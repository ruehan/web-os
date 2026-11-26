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
use webos::ui::{Rect, Tool, Ui, Widths, DARK, LIGHT, RADIUS, TOOL_H};

const LIBRARY: &str = "/usr/share/music/library.txt";
const SIDE: f32 = 200.0;
const ROW: f32 = 30.0;
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
        let (top, room) = (at.1 as f32 * ROW, self.bars.2.h - 12.0);
        if room > ROW {
            self.scroll = self.scroll.clamp((top + ROW - room).max(0.0), top);
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

    fn narrow(&self) -> bool {
        self.w < 620.0
    }

    fn list_height(&self) -> f32 {
        self.lists.get(self.shown).map_or(0.0, |list| list.tracks.len() as f32 * ROW) + 12.0
    }

    fn max_scroll(&self) -> f32 {
        (self.list_height() - self.bars.2.h).max(0.0)
    }

    fn draw(&mut self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let mut ui: Ui<Action> = Ui::new(self.window, std::mem::take(&mut self.widths), theme, self.mouse);
        ui.f.clear(theme.surface);
        let narrow = self.narrow();
        let x0 = if narrow { 0.0 } else { SIDE };
        if !narrow {
            self.draw_side(&mut ui);
        }
        let bars = self.draw_main(&mut ui, x0);
        self.bars = bars;

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

    /// 왼쪽: 재생 목록들
    fn draw_side(&self, ui: &mut Ui<Action>) {
        let theme = ui.theme;
        ui.f.rect(0.0, 0.0, SIDE, self.h, 0.0, theme.surface2);
        ui.vline(SIDE - 1.0, 0.0, self.h);
        ui.text(14.0, 22.0, 12.0, theme.muted, Style::BOLD, "재생 목록");
        if self.lists.is_empty() {
            ui.text(14.0, 54.0, 12.0, theme.muted, Style::PLAIN, "목록이 없습니다.");
        }
        for (i, list) in self.lists.iter().enumerate() {
            let rect = Rect::new(6.0, 40.0 + i as f32 * ROW, SIDE - 13.0, ROW);
            let selected = i == self.shown;
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            let count = list.tracks.len().to_string();
            let count_w = ui.width(&count, 11.5, Style::PLAIN);
            ui.f.styled(rect.right() - 10.0, rect.mid_y(), 11.5, theme.muted, Align::Right, Style::PLAIN, &count);
            // 틀고 있는 곡이 든 목록은 강조색으로
            let ink = if self.playing.is_some_and(|(at, _)| at == i) { theme.accent } else { theme.text };
            ui.label(rect.x + 10.0, rect.mid_y(), 13.0, ink, Style::PLAIN, rect.w - 30.0 - count_w, &list.name);
            ui.target(rect, Role::Option, selected, &list.name, Action::List(i));
        }
    }

    /// 플레이어, 지금 곡과 단추들, 곡 목록. (진행 막대, 소리 막대, 곡 목록)의 자리를 돌려준다.
    fn draw_main(&self, ui: &mut Ui<Action>, x0: f32) -> (Rect, Rect, Rect) {
        let width = self.w - x0;
        let narrow = self.narrow();
        // 좁은 화면에서는 플레이어가 폭을 다 쓰고, 정보와 단추가 그 아래로 간다.
        let video = if narrow {
            Rect::new(x0 + 12.0, 12.0, width - 24.0, ((width - 24.0) * RATIO).round())
        } else {
            let w = (width * 0.46).clamp(260.0, 420.0).round();
            Rect::new(x0 + 16.0, 16.0, w, (w * RATIO).round())
        };
        self.draw_video(ui, video);
        let info = if narrow {
            Rect::new(x0 + 12.0, video.bottom() + 10.0, width - 24.0, 118.0)
        } else {
            Rect::new(video.right() + 18.0, video.y, (x0 + width - 16.0 - video.right() - 18.0).max(120.0), video.h)
        };
        let (seek, volume) = self.draw_info(ui, info);
        let top = if narrow { info.bottom() + 6.0 } else { video.bottom() + 16.0 };
        ui.hline(x0, top, width);
        let list = Rect::new(x0, top + 1.0, width, (self.h - top - 1.0).max(0.0));
        self.draw_tracks(ui, list);
        (seek, volume, list)
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
            ui.f.styled(cx, cy, 13.0, quiet, Align::Center, Style::PLAIN, "곡을 고르면 여기서 재생됩니다.");
        } else {
            // 영상과 소리는 화면 쪽이 이 자리에 놓는 유튜브의 플레이어가 낸다.
            ui.f.player(rect.x, rect.y, rect.w, rect.h);
        }
    }

    /// 지금 곡의 제목, 단추들, 진행 막대와 소리 막대
    fn draw_info(&self, ui: &mut Ui<Action>, rect: Rect) -> (Rect, Rect) {
        let theme = ui.theme;
        let track = self.current();
        let title = track.map_or("고른 곡이 없습니다", |t| self.title(t));
        let trouble = track.and_then(|t| self.broken.get(&t.id)).copied();
        let artist = match (trouble, track) {
            (Some(reason), _) => reason,
            (None, Some(t)) => self.artist(t),
            (None, None) => "",
        };
        ui.label(rect.x, rect.y + 12.0, 15.0, theme.text, Style::BOLD, rect.w, title);
        ui.label(rect.x, rect.y + 34.0, 12.5, if trouble.is_some() { theme.danger } else { theme.muted }, Style::PLAIN, rect.w, artist);

        // 진행 막대와 시간
        let bar_y = rect.y + 58.0;
        let times = format!("{} / {}", clock(self.position), if self.duration > 0.0 { clock(self.duration) } else { "-:--".into() });
        let times_w = ui.width(&times, 11.5, Style::MONO);
        let seek = Rect::new(rect.x, bar_y - 8.0, (rect.w - times_w - 12.0).max(40.0), 16.0);
        let done = if self.duration > 0.0 { (self.position / self.duration).clamp(0.0, 1.0) } else { 0.0 };
        self.slider(ui, seek, done, "재생 위치", Action::Seek);
        ui.f.styled(rect.right(), bar_y, 11.5, theme.muted, Align::Right, Style::MONO, &times);

        // 단추들
        let y = rect.y + 76.0;
        let playing = matches!(self.state, PlayerState::Playing | PlayerState::Buffering) && self.playing.is_some();
        let mut x = rect.x;
        for (name, action, pressed) in [
            ("이전 곡", Action::Previous, false),
            (if playing { "일시정지" } else { "재생" }, Action::Toggle, false),
            ("다음 곡", Action::Next, false),
            ("섞기", Action::Shuffle, self.shuffle),
            (
                match self.repeat {
                    Repeat::Off => "반복",
                    Repeat::All => "반복: 목록 전체",
                    Repeat::One => "반복: 한 곡",
                },
                Action::Repeat,
                self.repeat != Repeat::Off,
            ),
        ] {
            let button = Rect::new(x, y, 34.0, 30.0);
            let hot = ui.hot(button);
            if pressed {
                ui.f.rect(button.x, button.y, button.w, button.h, RADIUS, theme.accent_soft);
            } else if hot {
                ui.f.rect(button.x, button.y, button.w, button.h, RADIUS, theme.hover);
            }
            ui.f.frame(button.x, button.y, button.w, button.h, RADIUS, if hot { theme.line_strong } else { theme.line }, 1.0);
            let ink = if pressed { theme.accent } else { theme.text };
            let (cx, cy) = (button.x + 17.0, button.mid_y());
            match &action {
                Action::Previous => {
                    ui.f.line(&[(cx - 6.0, cy - 6.0), (cx - 6.0, cy + 6.0)], ink, 1.6);
                    ui.f.line(&[(cx + 6.0, cy - 6.0), (cx - 3.0, cy), (cx + 6.0, cy + 6.0), (cx + 6.0, cy - 6.0)], ink, 1.6);
                }
                Action::Next => {
                    ui.f.line(&[(cx + 6.0, cy - 6.0), (cx + 6.0, cy + 6.0)], ink, 1.6);
                    ui.f.line(&[(cx - 6.0, cy - 6.0), (cx + 3.0, cy), (cx - 6.0, cy + 6.0), (cx - 6.0, cy - 6.0)], ink, 1.6);
                }
                Action::Toggle if playing => {
                    ui.f.rect(cx - 5.5, cy - 6.5, 4.0, 13.0, 1.0, ink);
                    ui.f.rect(cx + 1.5, cy - 6.5, 4.0, 13.0, 1.0, ink);
                }
                Action::Toggle => ui.f.line(&[(cx - 4.5, cy - 7.0), (cx + 6.5, cy), (cx - 4.5, cy + 7.0), (cx - 4.5, cy - 7.0)], ink, 1.6),
                Action::Shuffle => {
                    // 엇갈리는 두 줄
                    ui.f.line(&[(cx - 7.0, cy - 4.0), (cx - 3.0, cy - 4.0), (cx + 3.0, cy + 4.0), (cx + 7.0, cy + 4.0)], ink, 1.5);
                    ui.f.line(&[(cx - 7.0, cy + 4.0), (cx - 3.0, cy + 4.0), (cx + 3.0, cy - 4.0), (cx + 7.0, cy - 4.0)], ink, 1.5);
                }
                _ => {
                    // 돌아오는 고리. 한 곡 반복이면 가운데에 1을 적는다.
                    ui.f.line(&[(cx + 4.0, cy - 5.0), (cx - 4.0, cy - 5.0), (cx - 7.0, cy - 2.0), (cx - 7.0, cy + 2.0), (cx - 4.0, cy + 5.0), (cx + 4.0, cy + 5.0), (cx + 7.0, cy + 2.0), (cx + 7.0, cy - 1.0)], ink, 1.5);
                    ui.f.line(&[(cx + 4.5, cy - 2.5), (cx + 7.0, cy - 0.5), (cx + 9.5, cy - 2.5)], ink, 1.5);
                    if self.repeat == Repeat::One {
                        ui.f.styled(cx, cy + 0.5, 9.0, ink, Align::Center, Style::BOLD, "1");
                    }
                }
            }
            ui.target(button, Role::Button, pressed, name, action);
            x += 38.0;
        }

        // 소리 크기
        let volume = Rect::new(x + 14.0, y + 7.0, (rect.right() - x - 14.0).clamp(40.0, 110.0), 16.0);
        self.slider(ui, volume, self.volume / 100.0, "소리 크기", Action::Volume);

        // 좁은 화면에서는 왼쪽의 목록이 없으므로, 목록을 고르는 단추를 둔다.
        if self.narrow() {
            let name = self.lists.get(self.shown).map_or("목록", |l| l.name.as_str());
            let label = ui.fit(name, 12.0, Style::PLAIN, rect.w - 40.0);
            ui.tool(rect.x, rect.bottom() - TOOL_H, &format!("{label} ▾"), Tool::Plain, false, Some(Action::ListMenu));
        }
        (seek, volume)
    }

    /// 누르거나 끌어서 값을 정하는 가로 막대
    fn slider(&self, ui: &mut Ui<Action>, rect: Rect, fraction: f32, name: &str, action: Action) {
        let theme = ui.theme;
        let mid = rect.mid_y();
        ui.f.rect(rect.x, mid - 2.0, rect.w, 4.0, 2.0, theme.line_strong);
        ui.f.rect(rect.x, mid - 2.0, rect.w * fraction, 4.0, 2.0, theme.accent);
        if ui.hot(rect) || self.dragging.as_ref() == Some(&action) {
            ui.f.circle(rect.x + rect.w * fraction, mid, 5.5, theme.accent);
        }
        ui.target(rect, Role::Button, false, &format!("{name} {}%", (fraction * 100.0).round()), action);
    }

    /// 펼쳐 둔 목록의 곡들
    fn draw_tracks(&self, ui: &mut Ui<Action>, area: Rect) {
        let theme = ui.theme;
        let Some(list) = self.lists.get(self.shown) else {
            ui.f.styled(area.x + area.w / 2.0, area.y + 40.0, 13.0, theme.muted, Align::Center, Style::PLAIN, "틀 곡이 없습니다. 목록 파일에 유튜브 주소를 적어 주세요.");
            return ui.f.styled(area.x + area.w / 2.0, area.y + 62.0, 12.0, theme.muted, Align::Center, Style::MONO, LIBRARY);
        };
        let scroll = self.scroll.min((self.list_height() - area.h).max(0.0));
        ui.clip(area);
        for (i, track) in list.tracks.iter().enumerate() {
            let rect = Rect::new(area.x + 6.0, area.y + 6.0 + i as f32 * ROW - scroll, area.w - 12.0, ROW);
            if rect.bottom() < area.y || rect.y > area.bottom() {
                continue;
            }
            let current = self.playing == Some((self.shown, i));
            if current {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            let broken = self.broken.contains_key(&track.id);
            let ink = if broken { theme.muted } else if current { theme.accent } else { theme.text };
            // 틀고 있는 곡은 번호 대신 재생 표시
            if current && matches!(self.state, PlayerState::Playing | PlayerState::Buffering) {
                let (cx, cy) = (rect.x + 18.0, rect.mid_y());
                ui.f.line(&[(cx - 3.5, cy - 5.0), (cx + 4.5, cy), (cx - 3.5, cy + 5.0), (cx - 3.5, cy - 5.0)], theme.accent, 1.5);
            } else {
                ui.f.styled(rect.x + 24.0, rect.mid_y(), 11.5, theme.muted, Align::Right, Style::MONO, &(i + 1).to_string());
            }
            let (title, artist) = (self.title(track), self.artist(track));
            let artist_room = (rect.w * 0.34).min(220.0);
            let style = Style { strike: broken, ..Style::PLAIN };
            ui.label(rect.x + 36.0, rect.mid_y(), 13.0, ink, style, rect.w - 56.0 - artist_room, title);
            let fitted = ui.fit(artist, 12.0, Style::PLAIN, artist_room);
            ui.f.styled(rect.right() - 10.0, rect.mid_y(), 12.0, theme.muted, Align::Right, Style::PLAIN, &fitted);
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
    let (w, h) = (860, 520);
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
        let pending = app.unknown();
        let event = if pending.is_some() { app.window.next_event_within(40) } else { app.window.next_event() };
        let mut redraw = match (event, pending) {
            (Some(event), _) => app.handle(event),
            (None, Some(id)) => {
                app.fetch_meta(&id);
                true
            }
            (None, None) => break,
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
