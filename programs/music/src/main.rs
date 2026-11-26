//! 음악. 정해 둔 목록의 곡을 유튜브의 플레이어로 튼다.
//!
//! 무엇을 틀지(목록, 다음 곡, 섞기와 반복)와 창의 그림은 이 프로그램이 맡고, 영상과 소리는 화면 쪽이 이 창에
//! 놓아 주는 유튜브의 공식 플레이어가 낸다. 프로그램은 "이 영상을 틀어라", "멈춰라"를 시키고 상태를 돌려받는다.
//! 목록은 글 파일이다 (/usr/share/music/library.txt, 그리고 사용자의 ~/music/*.txt).

mod library;

use library::{clock, Playlist, Track};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::{env, fs, process};
use webos::gui::{Align, Color, Event, Frame, Key, MenuItem, PlayerState, Role, Style, Window, PLAYER_UNSUPPORTED};
use webos::ui::{Rect, Tool, Ui, Widths, DARK, LIGHT, RADIUS};

const LIBRARY: &str = "/usr/share/music/library.txt";
const SIDE: f32 = 220.0;
/// 보관함의 한 줄, 곡 목록의 한 줄, 아래 재생 막대의 높이
const SIDE_ROW: f32 = 48.0;
const TRACK_ROW: f32 = 46.0;
const BAR_H: f32 = 78.0;
/// 플레이어의 가로세로 비율 (16:9)
const RATIO: f32 = 9.0 / 16.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Repeat {
    Off,
    /// 목록이 끝나면 처음으로
    All,
    /// 한 곡을 되풀이
    One,
}

#[derive(Clone, PartialEq, Debug)]
enum Action {
    /// 왼쪽에서 목록을 고른다
    List(usize),
    /// 그 목록의 몇 번째 곡을 튼다
    Play(usize, usize),
    Toggle,
    Next,
    Previous,
    Shuffle,
    Repeat,
    /// 진행 막대의 누른 자리로 옮긴다
    Seek,
    /// 소리 막대의 누른 자리만큼
    Volume,
    OpenOnYouTube,
    /// 좁은 화면에서 목록을 고르는 메뉴
    ListMenu,
    /// 보이는 목록을 처음부터 (섞기가 켜져 있으면 아무 곡부터) 튼다
    PlayList,
}

/// 플레이어에 시킬 일 (다음에 그릴 때 보낸다)
#[derive(Clone, PartialEq, Debug)]
enum Command {
    Load(String),
    Play,
    Pause,
    Seek(f32),
    Volume(f32),
}

struct App {
    window: Window,
    widths: Widths,
    w: f32,
    h: f32,
    dark: bool,
    lists: Vec<Playlist>,
    /// 화면에 펼쳐 둔 목록
    shown: usize,
    /// 틀고 있는 곡: (목록, 순번)
    playing: Option<(usize, usize)>,
    /// 이번 실행에서 영상을 한 번이라도 불러왔는가 (그 뒤로는 플레이어가 창에 놓여 있다)
    loaded: bool,
    state: PlayerState,
    position: f32,
    duration: f32,
    volume: f32,
    shuffle: bool,
    repeat: Repeat,
    /// 이 브라우저에서는 플레이어를 놓을 수 없다
    unsupported: bool,
    /// 틀 수 없었던 곡들과 그 이유
    broken: HashMap<String, &'static str>,
    /// 연달아 틀지 못한 곡의 수 (모두 못 틀면 끝없이 넘기지 않고 멈춘다)
    failures: usize,
    /// 유튜브에서 받아 온 제목과 작성자: 영상 번호 → (제목, 작성자). 받아 오지 못한 것은 None.
    meta: HashMap<String, Option<(String, String)>>,
    /// 받아 둔 곡의 작은 그림: 영상 번호 → 그림 파일의 경로. 받지 못한 것은 None.
    thumbs: HashMap<String, Option<String>>,
    /// 틀어 봐서 알게 된 곡의 길이 (초)
    lengths: HashMap<String, f32>,
    /// 섞어 틀 때 지나온 곡들 (이전 곡으로 돌아갈 때 쓴다)
    history: Vec<(usize, usize)>,
    /// 섞기에 쓰는 난수의 상태
    seed: u64,
    commands: Vec<Command>,
    scroll: f32,
    mouse: Option<(f32, f32)>,
    /// 진행 막대나 소리 막대를 누른 채 끌고 있다
    dragging: Option<Action>,
    hits: Vec<(Rect, Action)>,
    hot: Option<usize>,
    /// 마지막으로 그린 진행 막대, 소리 막대, 곡 목록의 자리
    bars: (Rect, Rect, Rect),
    menu: Option<((f32, f32), Vec<MenuItem>)>,
    opening: Option<String>,
    /// 마지막으로 파일에 적어 둔 설정
    remembered: String,
}

fn home() -> PathBuf {
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| "/home/guest".into()))
}

/// 시스템의 목록과, 사용자가 ~/music에 둔 목록 파일들을 읽는다.
fn load_lists() -> Vec<Playlist> {
    let mut lists = fs::read_to_string(LIBRARY).map(|text| library::parse(&text)).unwrap_or_default();
    let mut own: Vec<PathBuf> = fs::read_dir(home().join("music"))
        .map(|dir| dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|ext| ext == "txt")).collect())
        .unwrap_or_default();
    own.sort();
    for path in own {
        if let Ok(text) = fs::read_to_string(&path) {
            lists.extend(library::parse(&text));
        }
    }
    lists
}

impl App {
    fn track(&self, at: (usize, usize)) -> Option<&Track> {
        self.lists.get(at.0)?.tracks.get(at.1)
    }

    fn current(&self) -> Option<&Track> {
        self.track(self.playing?)
    }

    /// 곡의 제목: 목록에 적힌 것, 없으면 유튜브에서 받아 온 것, 그것도 없으면 영상 번호
    fn title<'a>(&'a self, track: &'a Track) -> &'a str {
        let fetched = self.meta.get(&track.id).and_then(|m| m.as_ref()).map(|(title, _)| title.as_str());
        track.title.as_deref().or(fetched).unwrap_or(&track.id)
    }

    fn artist<'a>(&'a self, track: &'a Track) -> &'a str {
        let fetched = self.meta.get(&track.id).and_then(|m| m.as_ref()).map(|(_, author)| author.as_str());
        track.artist.as_deref().or(fetched).unwrap_or("")
    }

    /// 제목을 아직 모르는 곡 하나 (지금 보이는 목록과 틀고 있는 곡 가운데)
    fn unknown(&self) -> Option<String> {
        let shown = self.lists.get(self.shown).map(|list| list.tracks.iter()).into_iter().flatten();
        self.current().into_iter().chain(shown).find(|track| track.title.is_none() && !self.meta.contains_key(&track.id)).map(|track| track.id.clone())
    }

    /// 그림을 아직 준비하지 않은 곡 하나 (틀고 있는 곡, 보이는 목록의 곡들, 목록들의 첫 곡 가운데)
    fn uncovered(&self) -> Option<String> {
        let shown = self.lists.get(self.shown).map(|list| list.tracks.iter()).into_iter().flatten();
        let firsts = self.lists.iter().filter_map(|list| list.tracks.first());
        self.current().into_iter().chain(shown).chain(firsts).find(|track| !self.thumbs.contains_key(&track.id)).map(|track| track.id.clone())
    }

    /// 곡의 작은 그림을 준비한다: 받아 둔 파일이 있으면 그것을, 없으면 유튜브에서 받아 와 적어 둔다.
    /// 그림은 화면 쪽이 파일을 읽어 그리므로, 그릴 수 있는 그림인지(크기를 물어) 확인해 둔다.
    fn fetch_cover(&mut self, id: &str) {
        let file = home().join(format!(".cache/music/covers/{id}.jpg"));
        if !file.exists() {
            let fetched = webos::fetch(&format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"), false).ok().filter(|r| r.status == 200).and_then(|mut response| {
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(&mut response.body, &mut bytes).ok()?;
                Some(bytes)
            });
            if let Some(bytes) = fetched {
                let _ = file.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| fs::write(&file, bytes));
            }
        }
        let path = file.to_string_lossy().into_owned();
        let usable = file.exists() && self.window.image_size(&path).is_some();
        self.thumbs.insert(id.to_string(), usable.then_some(path));
    }

    /// 유튜브에 그 영상의 제목과 작성자를 묻는다 (커널이 받아 온다). 받은 것은 다음을 위해 적어 둔다.
    fn fetch_meta(&mut self, id: &str) {
        let url = format!("https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v={id}");
        let found = webos::fetch(&url, false).ok().filter(|response| response.status == 200).and_then(|mut response| {
            let mut body = String::new();
            std::io::Read::read_to_string(&mut response.body, &mut body).ok()?;
            Some((library::json_string(&body, "title")?, library::json_string(&body, "author_name").unwrap_or_default()))
        });
        if let Some((title, author)) = &found {
            let line = format!("{id}\t{}\t{}\n", title.replace(['\t', '\n'], " "), author.replace(['\t', '\n'], " "));
            let file = home().join(".cache/music/titles");
            let _ = file.parent().map_or(Ok(()), fs::create_dir_all);
            let _ = fs::OpenOptions::new().create(true).append(true).open(file).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
        }
        self.meta.insert(id.to_string(), found);
    }

    // ───────────── 재생 ─────────────

    fn play(&mut self, at: (usize, usize), remember: bool) {
        let Some(id) = self.track(at).map(|track| track.id.clone()) else { return };
        if remember {
            if let Some(from) = self.playing {
                self.history.push(from);
                if self.history.len() > 200 {
                    self.history.remove(0);
                }
            }
        }
        self.playing = Some(at);
        self.state = PlayerState::Buffering;
        (self.position, self.duration) = (0.0, 0.0);
        self.commands.push(Command::Load(id));
        if !self.loaded {
            // 플레이어가 처음 놓일 때 소리 크기를 맞춘다.
            self.commands.push(Command::Volume(self.volume));
            self.loaded = true;
        }
        self.reveal(at);
    }

    /// 틀고 있는 곡의 줄이 보이도록 목록을 민다.
    fn reveal(&mut self, at: (usize, usize)) {
        if at.0 != self.shown {
            return;
        }
        let (top, room) = (at.1 as f32 * TRACK_ROW, self.bars.2.h - 12.0);
        if room > TRACK_ROW {
            self.scroll = self.scroll.clamp((top + TRACK_ROW - room).max(0.0), top);
        }
    }

    fn random(&mut self, below: usize) -> usize {
        // xorshift: 섞기에 쓸 만큼만 고르면 된다.
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed % below.max(1) as u64) as usize
    }

    /// 다음에 틀 곡. `auto`는 곡이 끝나서 넘어가는 경우다 (반복 설정을 따른다).
    fn following(&mut self, auto: bool) -> Option<(usize, usize)> {
        let (list, at) = self.playing?;
        let count = self.lists.get(list)?.tracks.len();
        if auto && self.repeat == Repeat::One {
            return Some((list, at));
        }
        if self.shuffle && count > 1 {
            // 지금 곡이 아닌 것 가운데 하나
            let pick = self.random(count - 1);
            return Some((list, if pick >= at { pick + 1 } else { pick }));
        }
        if at + 1 < count {
            Some((list, at + 1))
        } else if self.repeat == Repeat::All || !auto {
            Some((list, 0))
        } else {
            None
        }
    }

    fn next(&mut self, auto: bool) {
        match self.following(auto) {
            Some(at) => self.play(at, true),
            None => self.state = PlayerState::Ended,
        }
    }

    fn previous(&mut self) {
        // 곡이 어느 정도 흘렀으면 그 곡의 처음으로, 아니면 앞 곡으로 간다.
        if self.position > 3.0 {
            self.position = 0.0;
            return self.commands.push(Command::Seek(0.0));
        }
        if let Some(at) = self.history.pop() {
            return self.play(at, false);
        }
        if let Some((list, at)) = self.playing {
            let count = self.lists[list].tracks.len();
            self.play((list, (at + count - 1) % count.max(1)), false);
        }
    }

    fn toggle(&mut self) {
        match (self.playing, self.state) {
            // 아직 아무것도 틀지 않았으면 보이는 목록의 첫 곡부터
            (None, _) => self.play((self.shown, 0), false),
            (Some(at), PlayerState::Ended) => self.play(at, false),
            (Some(_), PlayerState::Playing | PlayerState::Buffering) => {
                self.state = PlayerState::Paused;
                self.commands.push(Command::Pause);
            }
            (Some(_), _) => {
                self.state = PlayerState::Playing;
                self.commands.push(Command::Play);
            }
        }
    }

    // ───────────── 설정 기억하기 ─────────────

    fn settings(&self) -> String {
        let repeat = match self.repeat {
            Repeat::Off => "off",
            Repeat::All => "all",
            Repeat::One => "one",
        };
        format!("volume\t{}\nshuffle\t{}\nrepeat\t{repeat}\nlist\t{}\n", self.volume.round(), self.shuffle, self.lists.get(self.shown).map_or("", |l| l.name.as_str()))
    }

    fn remember(&mut self) {
        let settings = self.settings();
        if settings == self.remembered {
            return;
        }
        let file = home().join(".config/music/settings");
        if file.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| fs::write(&file, &settings)).is_ok() {
            self.remembered = settings;
        }
    }

    fn restore(&mut self) {
        let text = fs::read_to_string(home().join(".config/music/settings")).unwrap_or_default();
        for line in text.lines() {
            match line.split_once('\t') {
                Some(("volume", v)) => self.volume = v.parse::<f32>().unwrap_or(80.0).clamp(0.0, 100.0),
                Some(("shuffle", v)) => self.shuffle = v == "true",
                Some(("repeat", "all")) => self.repeat = Repeat::All,
                Some(("repeat", "one")) => self.repeat = Repeat::One,
                Some(("list", name)) => self.shown = self.lists.iter().position(|l| l.name == name).unwrap_or(0),
                _ => {}
            }
        }
        // 지난번에 받아 둔 제목들
        for line in fs::read_to_string(home().join(".cache/music/titles")).unwrap_or_default().lines() {
            let mut parts = line.split('\t');
            if let (Some(id), Some(title)) = (parts.next(), parts.next()) {
                self.meta.insert(id.to_string(), Some((title.to_string(), parts.next().unwrap_or("").to_string())));
            }
        }
        self.remembered = self.settings();
    }

    // ───────────── 화면 ─────────────
    //
    // 음악 서비스의 플레이어들이 흔히 쓰는 구성이다: 왼쪽에 보관함(재생 목록들), 가운데에 고른 목록과 그 곡들,
    // 아래에 늘 보이는 재생 막대(지금 곡, 재생 단추들과 진행 막대, 소리). 영상은 가운데 위의 "표지" 자리에 보인다.

    fn narrow(&self) -> bool {
        self.w < 620.0
    }

    fn list_height(&self) -> f32 {
        self.lists.get(self.shown).map_or(0.0, |list| list.tracks.len() as f32 * TRACK_ROW) + 12.0
    }

    fn max_scroll(&self) -> f32 {
        (self.list_height() - self.bars.2.h).max(0.0)
    }

    fn draw(&mut self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let mut ui: Ui<Action> = Ui::new(self.window, std::mem::take(&mut self.widths), theme, self.mouse);
        ui.f.clear(theme.surface);
        let narrow = self.narrow();
        let side = if narrow { 0.0 } else { SIDE };
        let bar_h = if narrow { 64.0 } else { BAR_H };
        let list = self.draw_main(&mut ui, Rect::new(side, 0.0, self.w - side, (self.h - bar_h).max(0.0)));
        if !narrow {
            self.draw_side(&mut ui, Rect::new(0.0, 0.0, side, (self.h - bar_h).max(0.0)));
        }
        let (seek, volume) = self.draw_bar(&mut ui, Rect::new(0.0, self.h - bar_h, self.w, bar_h));
        self.bars = (seek, volume, list);

        // 플레이어에 시킬 일들. 영상을 불러오라는 것이 여럿이면 마지막 것만 보낸다.
        let commands = std::mem::take(&mut self.commands);
        let last_load = commands.iter().rposition(|c| matches!(c, Command::Load(_)));
        for (i, command) in commands.iter().enumerate() {
            match command {
                Command::Load(id) if Some(i) == last_load => ui.f.player_load(id, true),
                Command::Load(_) => {}
                Command::Play => ui.f.player_play(),
                Command::Pause => ui.f.player_pause(),
                Command::Seek(to) => ui.f.player_seek(*to),
                Command::Volume(volume) => ui.f.player_volume(*volume),
            }
        }
        if let Some(url) = self.opening.take() {
            ui.f.open_url(&url);
        }
        if let Some(((x, y), items)) = self.menu.take() {
            ui.f.menu(x, y, &items);
        }
        self.widths = ui.widths;
        self.hits = ui.hits;
        self.hot = self.hit_at(self.mouse);
        ui.f
    }

    /// 곡의 작은 그림 (유튜브의 썸네일). 받아 둔 것이 없으면 빈 칸을 그린다.
    fn cover(&self, ui: &mut Ui<Action>, rect: Rect, id: Option<&str>) {
        ui.f.rect(rect.x, rect.y, rect.w, rect.h, 4.0, ui.theme.hover);
        match id.and_then(|id| self.thumbs.get(id)).and_then(|path| path.as_deref()) {
            Some(path) => ui.f.image(rect.x, rect.y, rect.w, rect.h, path),
            None => {
                // 음표
                let (cx, cy, ink) = (rect.x + rect.w / 2.0, rect.mid_y(), ui.theme.muted);
                ui.f.line(&[(cx - 2.0, cy + 4.0), (cx - 2.0, cy - 5.0), (cx + 4.0, cy - 6.5), (cx + 4.0, cy + 2.5)], ink, 1.4);
                ui.f.circle(cx - 3.8, cy + 4.2, 2.0, ink);
                ui.f.circle(cx + 2.2, cy + 2.7, 2.0, ink);
            }
        }
    }

    /// 왼쪽: 보관함 (재생 목록들)
    fn draw_side(&self, ui: &mut Ui<Action>, area: Rect) {
        let theme = ui.theme;
        ui.f.rect(area.x, area.y, area.w, area.h, 0.0, theme.surface2);
        ui.vline(area.right() - 1.0, area.y, area.h);
        ui.text(18.0, 26.0, 11.5, theme.muted, Style::BOLD, "보관함");
        if self.lists.is_empty() {
            ui.text(18.0, 60.0, 12.0, theme.muted, Style::PLAIN, "목록이 없습니다.");
        }
        ui.clip(Rect::new(area.x, 44.0, area.w - 1.0, (area.h - 44.0).max(0.0)));
        for (i, list) in self.lists.iter().enumerate() {
            let rect = Rect::new(8.0, 46.0 + i as f32 * SIDE_ROW, area.w - 17.0, SIDE_ROW - 4.0);
            let selected = i == self.shown;
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            // 목록의 표지: 첫 곡의 그림
            let first = list.tracks.first().map(|t| t.id.as_str());
            self.cover(ui, Rect::new(rect.x + 6.0, rect.y + 6.0, 57.0, 32.0), first);
            let playing = self.playing.is_some_and(|(at, _)| at == i);
            ui.label(rect.x + 72.0, rect.y + 15.0, 13.0, if playing { theme.accent } else { theme.text }, Style::PLAIN, rect.w - 80.0, &list.name);
            ui.label(rect.x + 72.0, rect.y + 31.0, 11.5, theme.muted, Style::PLAIN, rect.w - 80.0, &format!("{}곡", list.tracks.len()));
            ui.target(rect, Role::Option, selected, &list.name, Action::List(i));
        }
        ui.unclip();
    }

    /// 가운데: 고른 목록의 머리(영상과 목록 이름, 재생 단추)와 곡들. 곡 목록의 자리를 돌려준다.
    fn draw_main(&self, ui: &mut Ui<Action>, area: Rect) -> Rect {
        let theme = ui.theme;
        let narrow = self.narrow();
        let pad = if narrow { 12.0 } else { 22.0 };
        // 영상은 목록의 "표지" 자리에 보인다. 약관에 따라 숨기지 않고, 충분한 크기로 둔다.
        let video_w = if narrow { area.w - pad * 2.0 } else { (area.w * 0.48).clamp(288.0, 400.0).round() };
        let video = Rect::new(area.x + pad, area.y + pad, video_w, (video_w * RATIO).round());
        self.draw_video(ui, video);

        let list = self.lists.get(self.shown);
        let name = list.map_or("음악", |l| l.name.as_str());
        let count = format!("재생 목록 · {}곡", list.map_or(0, |l| l.tracks.len()));
        let play = |ui: &mut Ui<Action>, x: f32, y: f32| {
            // 목록을 처음부터 트는 큰 단추
            let rect = Rect::new(x, y, 92.0, 36.0);
            let hot = ui.hot(rect);
            ui.f.rect(rect.x, rect.y, rect.w, rect.h, 18.0, if hot { theme.accent.alpha(225) } else { theme.accent });
            let (cx, cy) = (rect.x + 30.0, rect.mid_y());
            ui.f.polygon(&[(cx - 5.0, cy - 6.5), (cx + 6.0, cy), (cx - 5.0, cy + 6.5)], theme.surface);
            ui.text(rect.x + 44.0, cy, 13.0, theme.surface, Style::BOLD, "재생");
            ui.target(rect, Role::Button, false, "이 목록 재생", Action::PlayList);
        };
        let top = if narrow {
            let y = video.bottom() + 12.0;
            // 좁은 화면에서는 왼쪽의 보관함이 없으므로, 목록의 이름이 목록을 고르는 단추다.
            let label = ui.fit(name, 12.0, Style::PLAIN, area.w - 150.0);
            ui.tool(area.x + pad, y + 5.0, &format!("{label} ▾"), Tool::Plain, false, Some(Action::ListMenu));
            play(ui, area.right() - pad - 92.0, y);
            y + 46.0
        } else {
            let x = video.right() + 22.0;
            let room = (area.right() - pad - x).max(60.0);
            ui.text(x, video.y + 16.0, 11.5, theme.muted, Style::BOLD, "지금 보는 목록");
            ui.label(x, video.y + 48.0, 26.0, theme.text, Style::BOLD, room, name);
            ui.label(x, video.y + 80.0, 12.5, theme.muted, Style::PLAIN, room, &count);
            play(ui, x, video.bottom() - 36.0);
            video.bottom() + 18.0
        };

        // 곡 목록의 머리줄
        ui.text(area.x + pad + 6.0, top + 12.0, 11.5, theme.muted, Style::PLAIN, "#");
        ui.text(area.x + pad + 36.0, top + 12.0, 11.5, theme.muted, Style::PLAIN, "제목");
        ui.f.styled(area.right() - pad - 6.0, top + 12.0, 11.5, theme.muted, Align::Right, Style::PLAIN, "길이");
        ui.hline(area.x + pad, top + 25.0, area.w - pad * 2.0);
        let tracks = Rect::new(area.x, top + 26.0, area.w, (area.bottom() - top - 26.0).max(0.0));
        self.draw_tracks(ui, tracks, pad);
        tracks
    }

    /// 플레이어의 자리. 아직 틀기 전이거나 플레이어를 놓을 수 없으면 그 자리에 안내를 그린다.
    fn draw_video(&self, ui: &mut Ui<Action>, rect: Rect) {
        ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, Color::rgb(16, 17, 20));
        let (cx, cy) = (rect.x + rect.w / 2.0, rect.mid_y());
        let quiet = Color::rgb(160, 163, 175);
        if self.unsupported {
            ui.f.styled(cx, cy - 22.0, 13.0, Color::rgb(232, 232, 236), Align::Center, Style::PLAIN, "이 브라우저에서는 여기서 틀 수 없습니다.");
            ui.f.styled(cx, cy - 2.0, 12.0, quiet, Align::Center, Style::PLAIN, "Chrome이나 Edge에서 열어 보세요.");
            if self.current().is_some() {
                let w = ui.tool_width("유튜브에서 열기");
                ui.tool(cx - w / 2.0, cy + 16.0, "유튜브에서 열기", Tool::Plain, false, Some(Action::OpenOnYouTube));
            }
        } else if !self.loaded {
            ui.f.circle(cx, cy - 12.0, 22.0, Color::rgba(255, 255, 255, 28));
            ui.f.polygon(&[(cx - 6.0, cy - 21.0), (cx + 9.0, cy - 12.0), (cx - 6.0, cy - 3.0)], quiet);
            ui.f.styled(cx, cy + 26.0, 12.5, quiet, Align::Center, Style::PLAIN, "곡을 고르면 여기서 재생됩니다.");
        } else {
            // 영상과 소리는 화면 쪽이 이 자리에 놓는 유튜브의 플레이어가 낸다.
            ui.f.player(rect.x, rect.y, rect.w, rect.h);
        }
    }

    /// 펼쳐 둔 목록의 곡들
    fn draw_tracks(&self, ui: &mut Ui<Action>, area: Rect, pad: f32) {
        let theme = ui.theme;
        let Some(list) = self.lists.get(self.shown) else {
            ui.f.styled(area.x + area.w / 2.0, area.y + 40.0, 13.0, theme.muted, Align::Center, Style::PLAIN, "틀 곡이 없습니다. 목록 파일에 유튜브 주소를 적어 주세요.");
            return ui.f.styled(area.x + area.w / 2.0, area.y + 62.0, 12.0, theme.muted, Align::Center, Style::MONO, LIBRARY);
        };
        let scroll = self.scroll.min((self.list_height() - area.h).max(0.0));
        ui.clip(area);
        for (i, track) in list.tracks.iter().enumerate() {
            let rect = Rect::new(area.x + pad - 6.0, area.y + 4.0 + i as f32 * TRACK_ROW - scroll, area.w - pad * 2.0 + 12.0, TRACK_ROW - 2.0);
            if rect.bottom() < area.y || rect.y > area.bottom() {
                continue;
            }
            let current = self.playing == Some((self.shown, i));
            let hot = ui.hot(rect);
            if current {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if hot {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            let broken = self.broken.contains_key(&track.id);
            let ink = if broken { theme.muted } else if current { theme.accent } else { theme.text };
            let (cx, cy) = (rect.x + 16.0, rect.mid_y());
            if current && matches!(self.state, PlayerState::Playing | PlayerState::Buffering) {
                // 틀고 있는 곡: 소리 막대 세 개
                for (k, height) in [9.0f32, 14.0, 6.0].into_iter().enumerate() {
                    ui.f.rect(cx - 6.0 + k as f32 * 4.5, cy + 7.0 - height, 3.0, height, 1.0, theme.accent);
                }
            } else if hot && !broken {
                // 포인터를 올린 줄: 누르면 튼다는 표시
                ui.f.polygon(&[(cx - 4.0, cy - 5.5), (cx + 5.0, cy), (cx - 4.0, cy + 5.5)], theme.text);
            } else {
                ui.f.styled(cx + 5.0, cy, 12.0, if current { theme.accent } else { theme.muted }, Align::Right, Style::MONO, &(i + 1).to_string());
            }
            self.cover(ui, Rect::new(rect.x + 36.0, rect.y + 7.0, 53.0, 30.0), Some(&track.id));
            let length = self.lengths.get(&track.id).map_or(String::new(), |seconds| clock(*seconds));
            let length_w = ui.width("0:00:00", 11.5, Style::MONO);
            ui.f.styled(rect.right() - 12.0, cy, 11.5, theme.muted, Align::Right, Style::MONO, &length);
            let (title, artist) = (self.title(track), self.artist(track));
            let room = rect.w - 100.0 - length_w - 24.0;
            let style = Style { strike: broken, ..Style::PLAIN };
            ui.label(rect.x + 100.0, cy - 8.5, 13.0, ink, style, room, title);
            let note = self.broken.get(&track.id).copied().unwrap_or(artist);
            ui.label(rect.x + 100.0, cy + 9.0, 11.5, theme.muted, Style::PLAIN, room, note);
            ui.target(rect, Role::Option, current, title, Action::Play(self.shown, i));
        }
        let total = self.list_height();
        if total > area.h && area.h > 0.0 {
            let thumb = (area.h * area.h / total).max(24.0);
            let top = area.y + (area.h - thumb) * scroll / (total - area.h);
            ui.f.rect(area.right() - 5.0, top, 3.0, thumb, 1.5, theme.line_strong);
        }
        ui.unclip();
    }

    /// 테두리 없는 둥근 단추의 바탕과 자리 알림. 그림을 그릴 가운데 자리와 색을 돌려준다.
    fn glyph(&self, ui: &mut Ui<Action>, cx: f32, cy: f32, name: &str, pressed: bool, action: Action) -> Color {
        let theme = ui.theme;
        let rect = Rect::new(cx - 16.0, cy - 16.0, 32.0, 32.0);
        if ui.hot(rect) {
            ui.f.circle(cx, cy, 16.0, theme.hover);
        }
        if pressed {
            // 켜져 있는 것(섞기, 반복)은 강조색과 아래의 점으로 알린다.
            ui.f.circle(cx, cy + 13.0, 1.6, theme.accent);
        }
        ui.target(rect, Role::Button, pressed, name, action);
        if pressed { theme.accent } else { theme.text }
    }

    /// 아래의 재생 막대: 지금 곡, 재생 단추들과 진행 막대, 소리. (진행 막대, 소리 막대)의 자리를 돌려준다.
    fn draw_bar(&self, ui: &mut Ui<Action>, bar: Rect) -> (Rect, Rect) {
        let theme = ui.theme;
        let narrow = self.narrow();
        ui.f.rect(bar.x, bar.y, bar.w, bar.h, 0.0, theme.surface2);
        ui.hline(bar.x, bar.y, bar.w);
        let track = self.current();
        let playing = matches!(self.state, PlayerState::Playing | PlayerState::Buffering) && self.playing.is_some();
        let done = if self.duration > 0.0 { (self.position / self.duration).clamp(0.0, 1.0) } else { 0.0 };
        let mid = bar.mid_y();

        // 왼쪽: 지금 곡
        let left_w = if narrow { bar.w - 116.0 } else { (bar.w * 0.28).clamp(170.0, 300.0) };
        let cover = if narrow { Rect::new(bar.x + 12.0, mid - 16.0, 57.0, 32.0) } else { Rect::new(bar.x + 16.0, mid - 20.0, 71.0, 40.0) };
        self.cover(ui, cover, track.map(|t| t.id.as_str()));
        let text_x = cover.right() + 12.0;
        let text_w = bar.x + left_w - text_x;
        let title = track.map_or("고른 곡이 없습니다", |t| self.title(t));
        let trouble = track.and_then(|t| self.broken.get(&t.id)).copied();
        let artist = trouble.or(track.map(|t| self.artist(t))).unwrap_or("");
        ui.label(text_x, mid - 8.5, 13.0, theme.text, Style::BOLD, text_w, title);
        ui.label(text_x, mid + 9.5, 11.5, if trouble.is_some() { theme.danger } else { theme.muted }, Style::PLAIN, text_w, artist);

        // 가운데의 큰 재생 단추: 채운 동그라미
        let toggle = |ui: &mut Ui<Action>, cx: f32, cy: f32| {
            let rect = Rect::new(cx - 18.0, cy - 18.0, 36.0, 36.0);
            ui.f.circle(cx, cy, if ui.hot(rect) { 18.0 } else { 17.0 }, theme.text);
            if playing {
                ui.f.rect(cx - 5.5, cy - 6.0, 4.0, 12.0, 1.0, theme.surface);
                ui.f.rect(cx + 1.5, cy - 6.0, 4.0, 12.0, 1.0, theme.surface);
            } else {
                ui.f.polygon(&[(cx - 4.0, cy - 6.5), (cx + 6.5, cy), (cx - 4.0, cy + 6.5)], theme.surface);
            }
            ui.target(rect, Role::Button, false, if playing { "일시정지" } else { "재생" }, Action::Toggle);
        };
        let skip = |ui: &mut Ui<Action>, cx: f32, cy: f32, forward: bool, ink: Color| {
            let d = if forward { 1.0 } else { -1.0 };
            ui.f.polygon(&[(cx - 5.0 * d, cy - 6.0), (cx + 3.5 * d, cy), (cx - 5.0 * d, cy + 6.0)], ink);
            ui.f.rect(cx + 3.5 * d - if forward { 0.0 } else { 2.0 }, cy - 6.0, 2.0, 12.0, 0.5, ink);
        };

        if narrow {
            // 좁은 화면: 진행은 막대 맨 위의 가는 줄로, 단추는 재생과 다음만.
            let seek = Rect::new(bar.x, bar.y - 5.0, bar.w, 12.0);
            ui.f.rect(bar.x, bar.y, bar.w * done, 2.5, 0.0, theme.accent);
            ui.target(seek, Role::Button, false, &format!("재생 위치 {}%", (done * 100.0).round()), Action::Seek);
            toggle(ui, bar.right() - 76.0, mid);
            let ink = self.glyph(ui, bar.right() - 30.0, mid, "다음 곡", false, Action::Next);
            skip(ui, bar.right() - 30.0, mid, true, ink);
            return (seek, Rect::new(0.0, 0.0, 0.0, 0.0));
        }

        // 가운데: 단추들과 그 아래의 진행 막대
        let cx = bar.x + bar.w / 2.0;
        let cy = bar.y + 26.0;
        let ink = self.glyph(ui, cx - 96.0, cy, "섞기", self.shuffle, Action::Shuffle);
        ui.f.line(&[(cx - 103.0, cy - 4.0), (cx - 99.0, cy - 4.0), (cx - 93.0, cy + 4.0), (cx - 89.0, cy + 4.0)], ink, 1.5);
        ui.f.line(&[(cx - 103.0, cy + 4.0), (cx - 99.0, cy + 4.0), (cx - 93.0, cy - 4.0), (cx - 89.0, cy - 4.0)], ink, 1.5);
        let ink = self.glyph(ui, cx - 50.0, cy, "이전 곡", false, Action::Previous);
        skip(ui, cx - 50.0, cy, false, ink);
        toggle(ui, cx, cy);
        let ink = self.glyph(ui, cx + 50.0, cy, "다음 곡", false, Action::Next);
        skip(ui, cx + 50.0, cy, true, ink);
        let repeat = match self.repeat {
            Repeat::Off => "반복",
            Repeat::All => "반복: 목록 전체",
            Repeat::One => "반복: 한 곡",
        };
        let rx = cx + 96.0;
        let ink = self.glyph(ui, rx, cy, repeat, self.repeat != Repeat::Off, Action::Repeat);
        // 돌아오는 고리. 한 곡 반복이면 가운데에 1을 적는다.
        ui.f.line(&[(rx + 4.0, cy - 5.0), (rx - 4.0, cy - 5.0), (rx - 7.0, cy - 2.0), (rx - 7.0, cy + 2.0), (rx - 4.0, cy + 5.0), (rx + 4.0, cy + 5.0), (rx + 7.0, cy + 2.0), (rx + 7.0, cy - 1.0)], ink, 1.5);
        ui.f.line(&[(rx + 4.5, cy - 2.5), (rx + 7.0, cy - 0.5), (rx + 9.5, cy - 2.5)], ink, 1.5);
        if self.repeat == Repeat::One {
            ui.f.styled(rx, cy + 0.5, 8.5, ink, Align::Center, Style::BOLD, "1");
        }

        let seek_w = (bar.w * 0.36).clamp(150.0, 480.0);
        let seek = Rect::new(cx - seek_w / 2.0, bar.y + 51.0, seek_w, 16.0);
        self.slider(ui, seek, done, "재생 위치", Action::Seek);
        ui.f.styled(seek.x - 10.0, seek.mid_y(), 11.0, theme.muted, Align::Right, Style::MONO, &clock(self.position));
        let length = if self.duration > 0.0 { clock(self.duration) } else { "-:--".into() };
        ui.text(seek.right() + 10.0, seek.mid_y(), 11.0, theme.muted, Style::MONO, &length);

        // 오른쪽: 소리
        let volume = Rect::new(bar.right() - 124.0, mid - 8.0, 104.0, 16.0);
        let (sx, sy) = (volume.x - 20.0, mid);
        ui.f.polygon(&[(sx - 6.0, sy - 2.5), (sx - 3.0, sy - 2.5), (sx + 1.0, sy - 6.0), (sx + 1.0, sy + 6.0), (sx - 3.0, sy + 2.5), (sx - 6.0, sy + 2.5)], theme.muted);
        if self.volume > 0.0 {
            ui.f.line(&[(sx + 4.0, sy - 3.0), (sx + 5.5, sy), (sx + 4.0, sy + 3.0)], theme.muted, 1.3);
        }
        self.slider(ui, volume, self.volume / 100.0, "소리 크기", Action::Volume);
        (seek, volume)
    }

    /// 누르거나 끌어서 값을 정하는 가로 막대
    fn slider(&self, ui: &mut Ui<Action>, rect: Rect, fraction: f32, name: &str, action: Action) {
        let theme = ui.theme;
        let mid = rect.mid_y();
        let active = ui.hot(rect) || self.dragging.as_ref() == Some(&action);
        ui.f.rect(rect.x, mid - 2.0, rect.w, 4.0, 2.0, theme.line_strong);
        ui.f.rect(rect.x, mid - 2.0, rect.w * fraction, 4.0, 2.0, if active { theme.accent } else { theme.text });
        if active {
            ui.f.circle(rect.x + rect.w * fraction, mid, 5.5, theme.text);
        }
        ui.target(rect, Role::Button, false, &format!("{name} {}%", (fraction * 100.0).round()), action);
    }

    // ───────────── 입력 ─────────────

    fn hit_at(&self, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at?;
        self.hits.iter().rposition(|(rect, _)| rect.contains(at))
    }

    /// 막대의 누른 자리가 전체의 얼마인가 (0~1)
    fn fraction(rect: Rect, x: f32) -> f32 {
        ((x - rect.x) / rect.w.max(1.0)).clamp(0.0, 1.0)
    }

    fn slide(&mut self, action: &Action, x: f32) {
        match action {
            Action::Seek if self.duration > 0.0 => {
                self.position = Self::fraction(self.bars.0, x) * self.duration;
                self.commands.push(Command::Seek(self.position));
            }
            Action::Volume => {
                self.volume = (Self::fraction(self.bars.1, x) * 100.0).round();
                self.commands.push(Command::Volume(self.volume));
            }
            _ => {}
        }
    }

    fn perform(&mut self, action: Action, at: (f32, f32)) {
        match action {
            Action::List(i) => {
                self.shown = i;
                self.scroll = 0.0;
            }
            Action::Play(list, i) => {
                self.failures = 0;
                self.play((list, i), true);
            }
            Action::Toggle => self.toggle(),
            Action::Next => {
                self.failures = 0;
                if self.playing.is_some() {
                    self.next(false);
                } else {
                    self.toggle();
                }
            }
            Action::Previous => self.previous(),
            Action::Shuffle => self.shuffle = !self.shuffle,
            Action::Repeat => {
                self.repeat = match self.repeat {
                    Repeat::Off => Repeat::All,
                    Repeat::All => Repeat::One,
                    Repeat::One => Repeat::Off,
                }
            }
            Action::Seek | Action::Volume => {
                self.slide(&action, at.0);
                self.dragging = Some(action);
            }
            Action::OpenOnYouTube => self.opening = self.current().map(|track| format!("https://www.youtube.com/watch?v={}", track.id)),
            Action::PlayList => {
                let count = self.lists.get(self.shown).map_or(0, |l| l.tracks.len());
                if count > 0 {
                    self.failures = 0;
                    let first = if self.shuffle { self.random(count) } else { 0 };
                    self.play((self.shown, first), true);
                }
            }
            Action::ListMenu => self.menu = Some((at, self.lists.iter().map(|list| MenuItem::new(&list.name)).collect())),
        }
    }

    /// 입력 하나를 처리한다. 화면을 다시 그려야 하면 true.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Resize { w, h, dark } => (self.w, self.h, self.dark) = (w, h, dark),
            Event::PointerMove { x, y } => {
                self.mouse = Some((x, y));
                if let Some(action) = self.dragging.clone() {
                    self.slide(&action, x);
                    return true;
                }
                return self.hit_at(self.mouse) != self.hot;
            }
            Event::PointerUp { .. } => return self.dragging.take().is_some(),
            Event::PointerLeave => {
                self.mouse = None;
                return self.hot.is_some();
            }
            Event::PointerDown { x, y, button: 0, .. } => {
                self.mouse = Some((x, y));
                let Some(action) = self.hit_at(self.mouse).map(|i| self.hits[i].1.clone()) else { return false };
                self.perform(action, (x, y));
            }
            Event::Wheel { x, y, dy } if self.bars.2.contains((x, y)) => {
                let to = (self.scroll + dy).clamp(0.0, self.max_scroll());
                if to == self.scroll {
                    return false;
                }
                self.scroll = to;
            }
            Event::Menu(Some(i)) if i < self.lists.len() => self.perform(Action::List(i), (0.0, 0.0)),
            Event::Key { key: Key::Char(' '), .. } => self.toggle(),
            Event::Key { key: Key::Right, mods } if mods.command() => self.perform(Action::Next, (0.0, 0.0)),
            Event::Key { key: Key::Left, mods } if mods.command() => self.previous(),
            Event::Player { state, position, duration } => {
                let was = (self.state, self.position.floor(), self.duration);
                // 끌어서 옮기는 동안에는 막대가 손을 따라가야 한다.
                if self.dragging != Some(Action::Seek) {
                    self.position = position;
                }
                if duration > 0.0 {
                    self.duration = duration;
                    // 틀어 봐야 길이를 안다. 알게 된 길이는 목록에 보여 준다.
                    if let Some(id) = self.current().map(|t| t.id.clone()) {
                        self.lengths.insert(id, duration);
                    }
                }
                if state == PlayerState::Playing {
                    self.failures = 0;
                }
                // 곡이 끝나면 다음 곡으로 넘어간다.
                if state == PlayerState::Ended && self.state != PlayerState::Ended && self.playing.is_some() {
                    self.state = state;
                    self.next(true);
                    return true;
                }
                self.state = state;
                return was != (self.state, self.position.floor(), self.duration);
            }
            Event::PlayerError(code) => {
                if code == PLAYER_UNSUPPORTED {
                    self.unsupported = true;
                    self.state = PlayerState::Unstarted;
                    return true;
                }
                // 틀 수 없는 곡은 표시해 두고 다음 곡으로 넘어간다. 모두 틀 수 없으면 거기서 멈춘다.
                let reason = match code {
                    100 => "없어졌거나 비공개인 영상입니다.",
                    101 | 150 | 153 => "다른 사이트에서의 재생을 막아 둔 영상입니다.",
                    _ => "이 영상은 틀 수 없습니다.",
                };
                if let Some(id) = self.current().map(|t| t.id.clone()) {
                    self.broken.insert(id, reason);
                }
                self.failures += 1;
                let count = self.playing.map_or(0, |(list, _)| self.lists[list].tracks.len());
                if self.failures < count {
                    self.next(false);
                } else {
                    self.state = PlayerState::Unstarted;
                }
            }
            Event::Close => {
                self.remember();
                process::exit(0);
            }
            _ => return false,
        }
        true
    }
}

fn main() {
    webos::init();
    let (w, h) = (980, 620);
    let window = match Window::open("음악", w, h) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("music: cannot open a window: {}", webos::describe(&e));
            process::exit(1);
        }
    };
    // 섞기의 씨앗: 켤 때마다 달라지게 지금 시각을 쓴다.
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1;
    let mut app = App {
        window,
        widths: Widths::default(),
        w: w as f32,
        h: h as f32,
        dark: false,
        lists: load_lists(),
        shown: 0,
        playing: None,
        loaded: false,
        state: PlayerState::Unstarted,
        position: 0.0,
        duration: 0.0,
        volume: 80.0,
        shuffle: false,
        repeat: Repeat::Off,
        unsupported: false,
        broken: HashMap::new(),
        failures: 0,
        meta: HashMap::new(),
        thumbs: HashMap::new(),
        lengths: HashMap::new(),
        history: Vec::new(),
        seed,
        commands: Vec::new(),
        scroll: 0.0,
        mouse: None,
        dragging: None,
        hits: Vec::new(),
        hot: None,
        bars: (Rect::new(0.0, 0.0, 0.0, 0.0), Rect::new(0.0, 0.0, 0.0, 0.0), Rect::new(0.0, 0.0, 0.0, 0.0)),
        menu: None,
        opening: None,
        remembered: String::new(),
    };
    app.restore();
    // 실행할 때 목록 파일을 주면 그것만 연다: music ~/music/밤.txt
    if let Some(path) = env::args().nth(1) {
        match fs::read_to_string(Path::new(&path)) {
            Ok(text) => {
                app.lists = library::parse(&text);
                app.shown = 0;
            }
            Err(e) => eprintln!("music: {path}: {}", webos::describe(&e)),
        }
    }
    let frame = app.draw();
    let _ = app.window.present(&frame);
    loop {
        // 제목을 모르는 곡이 있으면, 입력이 없는 틈에 하나씩 유튜브에 묻는다.
        // 곡의 그림도 같은 틈에 하나씩 받아 온다.
        let (pending, uncovered) = (app.unknown(), app.uncovered());
        let waiting = pending.is_some() || uncovered.is_some();
        let event = if waiting { app.window.next_event_within(40) } else { app.window.next_event() };
        let mut redraw = match (event, pending, uncovered) {
            (Some(event), ..) => app.handle(event),
            (None, Some(id), _) => {
                app.fetch_meta(&id);
                true
            }
            (None, None, Some(id)) => {
                app.fetch_cover(&id);
                true
            }
            (None, None, None) => break,
        };
        while let Some(event) = app.window.poll_event() {
            redraw |= app.handle(event);
        }
        app.remember();
        if redraw || !app.commands.is_empty() {
            let frame = app.draw();
            let _ = app.window.present(&frame);
        }
    }
}
