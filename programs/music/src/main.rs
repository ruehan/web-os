//! 음악. 등록해 둔 곡을 유튜브의 플레이어로 틀고, 글처럼 쓴 플레이리스트를 읽는다.
//!
//! 무엇을 틀지(차례, 다음 곡, 섞기와 반복)와 창의 그림은 이 프로그램이 맡고, 영상과 소리는 화면 쪽이 이 창에
//! 놓아 주는 유튜브의 공식 플레이어가 낸다. 프로그램은 "이 영상을 틀어라", "멈춰라"를 시키고 상태를 돌려받는다.
//!
//! 보관함은 글 파일들이다 (/usr/share/music과 사용자의 ~/music 아래):
//! - `songs.txt`: 등록한 곡들 (제목, 아티스트, 앨범). 아티스트별·앨범별 보기는 여기서 나온다.
//! - `playlists/*.md`: 글 한 편이 플레이리스트 하나다. 글은 여기에만 쓴다: 소개글, 곡, 곡마다의 이야기.

mod library;

use library::{clock, Post, Song};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::{env, fs, process};
use webos::gui::{Align, Color, Event, Frame, Key, MenuItem, PlayerState, Role, Style, Window, PLAYER_UNSUPPORTED};
use webos::ui::{natural_cmp, Rect, Tool, Ui, Widths, DARK, LIGHT, RADIUS};

const SHARED: &str = "/usr/share/music";
const SIDE: f32 = 220.0;
/// 보관함의 한 줄, 곡의 한 줄, 아래 재생 막대의 높이
const SIDE_ROW: f32 = 48.0;
const NAV_ROW: f32 = 32.0;
const TRACK_ROW: f32 = 46.0;
const BAR_H: f32 = 78.0;
/// 보관함 아래에 놓는 플레이어의 한 변 (유튜브가 정한 가장 작은 크기)
const PLAYER: f32 = 200.0;
const NO_ARTIST: &str = "아티스트 미상";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Repeat {
    Off,
    /// 차례가 끝나면 처음으로
    All,
    /// 한 곡을 되풀이
    One,
}

/// 가운데에 펼쳐 둔 것
#[derive(Clone, PartialEq, Debug)]
enum View {
    /// 플레이리스트(글)들의 목록
    Posts,
    /// 등록한 모든 곡
    Songs,
    Artists,
    Albums,
    Artist(String),
    Album(String),
    /// 플레이리스트 한 편
    Post(usize),
}

#[derive(Clone, PartialEq, Debug)]
enum Action {
    Go(View),
    /// 펼쳐 둔 것의 몇 번째 곡을 튼다
    Play(usize),
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
    /// 좁은 화면에서 볼 것을 고르는 메뉴
    ViewMenu,
    /// 펼쳐 둔 것을 처음부터 (섞기가 켜져 있으면 아무 곡부터) 튼다
    PlayAll,
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

/// 가운데의 스크롤되는 내용 한 줄
enum Item {
    /// 곡: 펼쳐 둔 것에서의 순번과 곡
    Song { at: usize, song: usize },
    /// 글 한 줄 (이미 폭에 맞춰 나눈 것)
    Text { line: String, size: f32, bold: bool, quiet: bool, indent: f32 },
    /// 다른 보기로 가는 카드 (플레이리스트, 아티스트, 앨범)
    Card { cover: Option<String>, title: String, sub: String, excerpt: Vec<String>, go: View },
    Gap(f32),
}

impl Item {
    fn height(&self) -> f32 {
        match self {
            Item::Song { .. } => TRACK_ROW,
            Item::Text { size, .. } => (size * 1.65).round(),
            Item::Card { excerpt, .. } => if excerpt.is_empty() { 58.0 } else { 92.0 },
            Item::Gap(h) => *h,
        }
    }
}

struct App {
    window: Window,
    widths: Widths,
    w: f32,
    h: f32,
    dark: bool,
    /// 등록한 곡들. 플레이리스트에만 나오는 곡도 여기에 든다.
    songs: Vec<Song>,
    /// 영상 번호 → songs의 자리
    index: HashMap<String, usize>,
    posts: Vec<Post>,
    view: View,
    /// 틀 차례 (songs의 자리들)와, 그 가운데 지금 트는 곡
    queue: Vec<usize>,
    playing: Option<usize>,
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
    /// 섞어 틀 때 지나온 곡들 (이전 곡으로 돌아갈 때 쓴다). 차례에서의 순번이다.
    history: Vec<usize>,
    /// 섞기에 쓰는 난수의 상태
    seed: u64,
    commands: Vec<Command>,
    scroll: f32,
    /// 마지막으로 그린 내용 전체의 높이
    content_h: f32,
    /// 다음에 그릴 때, 틀고 있는 곡의 줄이 보이도록 민다
    reveal: bool,
    mouse: Option<(f32, f32)>,
    /// 진행 막대나 소리 막대를 누른 채 끌고 있다
    dragging: Option<Action>,
    hits: Vec<(Rect, Action)>,
    hot: Option<usize>,
    /// 마지막으로 그린 진행 막대, 소리 막대, 스크롤되는 내용의 자리
    bars: (Rect, Rect, Rect),
    menu: Option<((f32, f32), Vec<MenuItem>)>,
    /// 띄워 둔 메뉴의 줄마다 갈 곳
    menu_views: Vec<View>,
    opening: Option<String>,
    /// 마지막으로 파일에 적어 둔 설정
    remembered: String,
}

fn home() -> PathBuf {
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| "/home/guest".into()))
}

fn read_post(path: &Path) -> Option<Post> {
    let text = fs::read_to_string(path).ok()?;
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Some(library::parse_post(&text, &name))
}

/// 시스템의 보관함과 사용자의 ~/music을 읽는다. 플레이리스트는 새 글이 위로 오게 놓는다.
fn load() -> (Vec<Song>, Vec<Post>) {
    let (mut songs, mut posts): (Vec<Song>, Vec<Post>) = (Vec::new(), Vec::new());
    for root in [PathBuf::from(SHARED), home().join("music")] {
        for song in fs::read_to_string(root.join("songs.txt")).map(|text| library::parse_songs(&text)).unwrap_or_default() {
            if !songs.iter().any(|known| known.id == song.id) {
                songs.push(song);
            }
        }
        let mut files: Vec<PathBuf> = fs::read_dir(root.join("playlists"))
            .map(|dir| dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|ext| ext == "md" || ext == "txt")).collect())
            .unwrap_or_default();
        files.sort();
        posts.extend(files.iter().filter_map(|path| read_post(path)));
    }
    posts.sort_by(|a, b| b.date.cmp(&a.date));
    (songs, posts)
}

impl App {
    /// 플레이리스트에만 나오는 곡도 틀 수 있도록 곡 목록에 넣고, 번호로 찾을 수 있게 해 둔다.
    fn adopt(&mut self) {
        for id in self.posts.iter().flat_map(|post| post.entries.iter().map(|e| e.id.clone())).collect::<Vec<_>>() {
            if !self.songs.iter().any(|song| song.id == id) {
                self.songs.push(Song { id, ..Song::default() });
            }
        }
        self.index = self.songs.iter().enumerate().map(|(i, song)| (song.id.clone(), i)).collect();
    }

    fn current(&self) -> Option<&Song> {
        self.songs.get(*self.queue.get(self.playing?)?)
    }

    /// 곡의 제목: 적어 둔 것, 없으면 유튜브에서 받아 온 것, 그것도 없으면 영상 번호
    fn title<'a>(&'a self, song: &'a Song) -> &'a str {
        let fetched = self.meta.get(&song.id).and_then(|m| m.as_ref()).map(|(title, _)| title.as_str());
        song.title.as_deref().or(fetched).unwrap_or(&song.id)
    }

    fn artist<'a>(&'a self, song: &'a Song) -> &'a str {
        let fetched = self.meta.get(&song.id).and_then(|m| m.as_ref()).map(|(_, author)| author.as_str());
        song.artist.as_deref().or(fetched).unwrap_or("")
    }

    /// 묶음의 이름마다 그 곡들 (이름의 차례로)
    fn groups(&self, name: impl Fn(&Song) -> Option<String>) -> Vec<(String, Vec<usize>)> {
        let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
        for (i, song) in self.songs.iter().enumerate() {
            let Some(name) = name(song) else { continue };
            match groups.iter_mut().find(|(known, _)| *known == name) {
                Some((_, songs)) => songs.push(i),
                None => groups.push((name, vec![i])),
            }
        }
        // 이름의 차례로 놓되, 아티스트를 모르는 곡들의 묶음은 맨 뒤에 둔다.
        groups.sort_by(|a, b| (a.0 == NO_ARTIST).cmp(&(b.0 == NO_ARTIST)).then_with(|| natural_cmp(&a.0, &b.0)));
        groups
    }

    fn artist_name(&self, song: &Song) -> String {
        Some(self.artist(song)).filter(|a| !a.is_empty()).unwrap_or(NO_ARTIST).to_string()
    }

    fn artists(&self) -> Vec<(String, Vec<usize>)> {
        self.groups(|song| Some(self.artist_name(song)))
    }

    fn albums(&self) -> Vec<(String, Vec<usize>)> {
        self.groups(|song| song.album.clone())
    }

    /// 그 보기에서 틀 수 있는 곡들 (차례대로)
    fn songs_of(&self, view: &View) -> Vec<usize> {
        match view {
            View::Songs => (0..self.songs.len()).collect(),
            View::Artist(name) => (0..self.songs.len()).filter(|&i| self.artist_name(&self.songs[i]) == *name).collect(),
            View::Album(name) => (0..self.songs.len()).filter(|&i| self.songs[i].album.as_ref() == Some(name)).collect(),
            View::Post(i) => self.posts.get(*i).map_or(Vec::new(), |post| post.entries.iter().filter_map(|e| self.index.get(&e.id).copied()).collect()),
            View::Posts | View::Artists | View::Albums => Vec::new(),
        }
    }

    /// 제목이나 그림을 받아 올 곡들의 차례: 틀고 있는 곡, 펼쳐 둔 곡들, 나머지
    fn wanted(&self) -> impl Iterator<Item = &Song> {
        let shown = self.songs_of(&self.view);
        self.current().into_iter().chain(shown.into_iter().map(|i| &self.songs[i])).chain(self.songs.iter())
    }

    fn unknown(&self) -> Option<String> {
        self.wanted().find(|song| (song.title.is_none() || song.artist.is_none()) && !self.meta.contains_key(&song.id)).map(|song| song.id.clone())
    }

    fn uncovered(&self) -> Option<String> {
        self.wanted().find(|song| !self.thumbs.contains_key(&song.id)).map(|song| song.id.clone())
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

    /// 차례의 `at`번째 곡을 튼다.
    fn play(&mut self, at: usize, remember: bool) {
        let Some(id) = self.queue.get(at).map(|&song| self.songs[song].id.clone()) else { return };
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
        self.reveal = true;
    }

    /// 펼쳐 둔 것을 틀 차례로 삼고 그 `at`번째 곡을 튼다.
    fn play_from_view(&mut self, at: usize) {
        let songs = self.songs_of(&self.view);
        if at >= songs.len() {
            return;
        }
        if songs != self.queue {
            self.queue = songs;
            self.history.clear();
            self.playing = None;
        }
        self.failures = 0;
        self.play(at, true);
    }

    fn random(&mut self, below: usize) -> usize {
        // xorshift: 섞기에 쓸 만큼만 고르면 된다.
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed % below.max(1) as u64) as usize
    }

    /// 다음에 틀 곡. `auto`는 곡이 끝나서 넘어가는 경우다 (반복 설정을 따른다).
    fn following(&mut self, auto: bool) -> Option<usize> {
        let at = self.playing?;
        let count = self.queue.len();
        if auto && self.repeat == Repeat::One {
            return Some(at);
        }
        if self.shuffle && count > 1 {
            // 지금 곡이 아닌 것 가운데 하나
            let pick = self.random(count - 1);
            return Some(if pick >= at { pick + 1 } else { pick });
        }
        if at + 1 < count {
            Some(at + 1)
        } else if self.repeat == Repeat::All || !auto {
            Some(0)
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
        if let Some(at) = self.playing {
            let count = self.queue.len().max(1);
            self.play((at + count - 1) % count, false);
        }
    }

    /// 아직 아무것도 틀지 않았을 때: 펼쳐 둔 것의 (곡이 없는 보기라면 모든 곡의) 처음부터 튼다.
    fn start(&mut self) {
        if self.songs_of(&self.view).is_empty() {
            self.queue = (0..self.songs.len()).collect();
            self.history.clear();
            self.failures = 0;
            self.play(0, false);
        } else {
            let first = if self.shuffle { let count = self.songs_of(&self.view).len(); self.random(count) } else { 0 };
            self.play_from_view(first);
        }
    }

    fn toggle(&mut self) {
        match (self.playing, self.state) {
            (None, _) => self.start(),
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

    fn view_key(&self) -> String {
        match &self.view {
            View::Posts => "posts".into(),
            View::Songs => "songs".into(),
            View::Artists => "artists".into(),
            View::Albums => "albums".into(),
            View::Artist(name) => format!("artist:{name}"),
            View::Album(name) => format!("album:{name}"),
            View::Post(i) => format!("post:{}", self.posts.get(*i).map_or("", |p| p.title.as_str())),
        }
    }

    fn view_from(&self, key: &str) -> Option<View> {
        Some(match key.split_once(':') {
            None => match key {
                "posts" => View::Posts,
                "songs" => View::Songs,
                "artists" => View::Artists,
                "albums" => View::Albums,
                _ => return None,
            },
            Some(("artist", name)) => View::Artist(name.to_string()),
            Some(("album", name)) => View::Album(name.to_string()),
            Some(("post", title)) => View::Post(self.posts.iter().position(|p| p.title == title)?),
            _ => return None,
        })
    }

    fn settings(&self) -> String {
        let repeat = match self.repeat {
            Repeat::Off => "off",
            Repeat::All => "all",
            Repeat::One => "one",
        };
        format!("volume\t{}\nshuffle\t{}\nrepeat\t{repeat}\nview\t{}\n", self.volume.round(), self.shuffle, self.view_key())
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
                Some(("view", key)) => self.view = self.view_from(key).unwrap_or(self.view.clone()),
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
    // 왼쪽에 보관함(플레이리스트, 모든 곡, 아티스트, 앨범)과 플레이리스트들, 가운데에 펼쳐 둔 것,
    // 아래에 늘 보이는 재생 막대. 영상은 가운데 위의 "표지" 자리에 보인다.
    // 플레이리스트는 글처럼 읽힌다: 소개글, 곡, 그 곡에 대한 이야기가 차례로 이어진다.

    fn narrow(&self) -> bool {
        self.w < 620.0
    }

    fn max_scroll(&self) -> f32 {
        (self.content_h - self.bars.2.h).max(0.0)
    }

    fn draw(&mut self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let mut ui: Ui<Action> = Ui::new(self.window, std::mem::take(&mut self.widths), theme, self.mouse);
        ui.f.clear(theme.surface);
        let narrow = self.narrow();
        let side = if narrow { 0.0 } else { SIDE };
        let bar_h = if narrow { 64.0 } else { BAR_H };
        let content = self.draw_main(&mut ui, Rect::new(side, 0.0, self.w - side, (self.h - bar_h).max(0.0)));
        if !narrow {
            self.draw_side(&mut ui, Rect::new(0.0, 0.0, side, (self.h - bar_h).max(0.0)));
        }
        let (seek, volume) = self.draw_bar(&mut ui, Rect::new(0.0, self.h - bar_h, self.w, bar_h));
        self.bars = (seek, volume, content);

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

    fn post_sub(&self, post: &Post) -> String {
        match &post.date {
            Some(date) => format!("{date} · {}곡", post.entries.len()),
            None => format!("{}곡", post.entries.len()),
        }
    }

    /// 보관함에서 고를 수 있는 보기들
    fn nav() -> [(&'static str, View); 4] {
        [("플레이리스트", View::Posts), ("모든 곡", View::Songs), ("아티스트", View::Artists), ("앨범", View::Albums)]
    }

    /// 왼쪽: 보관함과 플레이리스트들
    fn draw_side(&self, ui: &mut Ui<Action>, area: Rect) {
        let theme = ui.theme;
        ui.f.rect(area.x, area.y, area.w, area.h, 0.0, theme.surface2);
        ui.vline(area.right() - 1.0, area.y, area.h);
        ui.text(18.0, 26.0, 11.5, theme.muted, Style::BOLD, "보관함");
        let mut y = 42.0;
        for (name, view) in Self::nav() {
            let rect = Rect::new(8.0, y, area.w - 17.0, NAV_ROW - 2.0);
            let selected = match (&self.view, &view) {
                (View::Artist(_), View::Artists) | (View::Album(_), View::Albums) => true,
                (a, b) => a == b,
            };
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            ui.label(rect.x + 12.0, rect.mid_y(), 13.0, theme.text, Style::PLAIN, rect.w - 24.0, name);
            ui.target(rect, Role::Option, selected, name, Action::Go(view));
            y += NAV_ROW;
        }
        y += 12.0;
        ui.hline(18.0, y, area.w - 37.0);
        ui.text(18.0, y + 22.0, 11.5, theme.muted, Style::BOLD, "최근에 쓴 글");
        y += 40.0;
        // 영상과 소리는 화면 쪽이 보관함의 아래에 놓는 유튜브의 플레이어가 낸다.
        // 유튜브가 정한 가장 작은 크기(200×200)를 지킨다.
        let mut bottom = area.bottom();
        if self.loaded && !self.unsupported {
            let player = Rect::new(area.x + (area.w - 1.0 - PLAYER) / 2.0, area.bottom() - PLAYER - 10.0, PLAYER, PLAYER);
            ui.f.rect(player.x, player.y, player.w, player.h, RADIUS, Color::rgb(16, 17, 20));
            ui.f.player(player.x, player.y, player.w, player.h);
            bottom = player.y - 10.0;
        }
        ui.clip(Rect::new(area.x, y, area.w - 1.0, (bottom - y).max(0.0)));
        let current = self.current().map(|song| song.id.clone());
        for (i, post) in self.posts.iter().enumerate() {
            let rect = Rect::new(8.0, y + i as f32 * SIDE_ROW, area.w - 17.0, SIDE_ROW - 4.0);
            let selected = self.view == View::Post(i);
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            // 글의 표지: 첫 곡의 그림
            self.cover(ui, Rect::new(rect.x + 6.0, rect.y + 6.0, 57.0, 32.0), post.entries.first().map(|e| e.id.as_str()));
            let playing = current.as_ref().is_some_and(|id| post.entries.iter().any(|e| e.id == *id)) && self.queue == self.songs_of(&View::Post(i));
            ui.label(rect.x + 72.0, rect.y + 15.0, 13.0, if playing { theme.accent } else { theme.text }, Style::PLAIN, rect.w - 80.0, &post.title);
            ui.label(rect.x + 72.0, rect.y + 31.0, 11.5, theme.muted, Style::PLAIN, rect.w - 80.0, &self.post_sub(post));
            ui.target(rect, Role::Option, selected, &post.title, Action::Go(View::Post(i)));
        }
        ui.unclip();
    }

    /// 펼쳐 둔 것의 머리: (갈래, 이름, 덧붙이는 말)
    fn heading(&self) -> (&'static str, String, String) {
        let count = self.songs_of(&self.view).len();
        match &self.view {
            View::Posts => ("보관함", "플레이리스트".into(), format!("글 {}편", self.posts.len())),
            View::Songs => ("보관함", "모든 곡".into(), format!("{count}곡")),
            View::Artists => ("보관함", "아티스트".into(), format!("{}명", self.artists().len())),
            View::Albums => ("보관함", "앨범".into(), format!("{}장", self.albums().len())),
            View::Artist(name) => ("아티스트", name.clone(), format!("{count}곡")),
            View::Album(name) => {
                let artist = self.songs_of(&self.view).first().map(|&i| self.artist_name(&self.songs[i])).unwrap_or_default();
                ("앨범", name.clone(), format!("{artist} · {count}곡"))
            }
            View::Post(i) => ("플레이리스트", self.posts.get(*i).map_or(String::new(), |p| p.title.clone()), self.posts.get(*i).map_or(String::new(), |p| self.post_sub(p))),
        }
    }

    /// 가운데: 머리(영상, 이름, 재생 단추)와 그 아래의 내용. 스크롤되는 내용의 자리를 돌려준다.
    fn draw_main(&mut self, ui: &mut Ui<Action>, area: Rect) -> Rect {
        let theme = ui.theme;
        let narrow = self.narrow();
        let pad = if narrow { 12.0 } else { 22.0 };
        // 머리: 갈래, 이름, 덧붙이는 말과 재생 단추. 영상은 여기가 아니라 아래 재생 막대의 그림 자리에서 나온다.
        let (kind, name, sub) = self.heading();
        let playable = !self.songs_of(&self.view).is_empty();
        let play = |ui: &mut Ui<Action>, x: f32, y: f32| {
            // 펼쳐 둔 것을 처음부터 트는 큰 단추
            let rect = Rect::new(x, y, 92.0, 36.0);
            let hot = ui.hot(rect);
            ui.f.rect(rect.x, rect.y, rect.w, rect.h, 18.0, if hot { theme.accent.alpha(225) } else { theme.accent });
            let (cx, cy) = (rect.x + 30.0, rect.mid_y());
            ui.f.polygon(&[(cx - 5.0, cy - 6.5), (cx + 6.0, cy), (cx - 5.0, cy + 6.5)], theme.surface);
            ui.text(rect.x + 44.0, cy, 13.0, theme.surface, Style::BOLD, "재생");
            ui.target(rect, Role::Button, false, "모두 재생", Action::PlayAll);
        };
        let mut top = if narrow {
            let y = area.y + 12.0;
            // 좁은 화면에서는 왼쪽의 보관함이 없으므로, 이름이 볼 것을 고르는 단추다.
            let label = ui.fit(&name, 12.0, Style::PLAIN, area.w - 150.0);
            ui.tool(area.x + pad, y + 5.0, &format!("{label} ▾"), Tool::Plain, false, Some(Action::ViewMenu));
            if playable {
                play(ui, area.right() - pad - 92.0, y);
            }
            y + 46.0
        } else {
            let (x, y) = (area.x + pad, area.y + pad);
            let room = (area.w - pad * 2.0 - if playable { 112.0 } else { 0.0 }).max(60.0);
            ui.text(x, y + 8.0, 11.5, theme.muted, Style::BOLD, kind);
            ui.label(x, y + 36.0, 24.0, theme.text, Style::BOLD, room, &name);
            ui.label(x, y + 64.0, 12.5, theme.muted, Style::PLAIN, room, &sub);
            if playable {
                play(ui, area.right() - pad - 92.0, y + 20.0);
            }
            y + 84.0
        };
        if self.unsupported {
            // 이 브라우저에는 플레이어를 놓을 수 없다: 알리고, 유튜브에서 여는 길을 준다.
            ui.f.rect(area.x + pad, top, area.w - pad * 2.0, 34.0, RADIUS, theme.hover);
            let open = if self.current().is_some() { ui.tool_width("유튜브에서 열기") + 8.0 } else { 0.0 };
            ui.label(area.x + pad + 12.0, top + 17.0, 12.5, theme.text, Style::PLAIN, area.w - pad * 2.0 - 24.0 - open, "이 브라우저에서는 여기서 틀 수 없습니다. Chrome이나 Edge에서 열어 보세요.");
            if open > 0.0 {
                ui.tool(area.right() - pad - open, top + 4.0, "유튜브에서 열기", Tool::Plain, false, Some(Action::OpenOnYouTube));
            }
            top += 44.0;
        }

        if matches!(self.view, View::Songs | View::Artist(_) | View::Album(_)) {
            // 곡 목록의 머리줄
            ui.text(area.x + pad + 6.0, top + 12.0, 11.5, theme.muted, Style::PLAIN, "#");
            ui.text(area.x + pad + 36.0, top + 12.0, 11.5, theme.muted, Style::PLAIN, "제목");
            ui.f.styled(area.right() - pad - 6.0, top + 12.0, 11.5, theme.muted, Align::Right, Style::PLAIN, "길이");
            top += 25.0;
        }
        ui.hline(area.x + pad, top, area.w - pad * 2.0);
        let content = Rect::new(area.x, top + 1.0, area.w, (area.bottom() - top - 1.0).max(0.0));
        let items = self.layout(ui, content.w, pad);
        self.draw_items(ui, content, pad, &items);
        content
    }

    /// 글을 폭에 맞춰 줄로 나눠 내용에 보탠다. 빈 줄은 문단 사이의 틈, `## `로 시작하는 줄은 작은 제목이다.
    fn prose(ui: &mut Ui<Action>, text: &str, size: f32, room: f32, indent: f32, quiet: bool, out: &mut Vec<Item>) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                out.push(Item::Gap(8.0));
                continue;
            }
            let (line, size, bold) = match line.strip_prefix("## ") {
                Some(heading) => (heading, size + 2.0, true),
                None => (line, size, false),
            };
            for line in wrap(ui, line, size, if bold { Style::BOLD } else { Style::PLAIN }, room) {
                out.push(Item::Text { line, size, bold, quiet, indent });
            }
        }
    }

    /// 펼쳐 둔 것의 내용을 위에서 아래로 늘어놓는다.
    fn layout(&self, ui: &mut Ui<Action>, width: f32, pad: f32) -> Vec<Item> {
        let room = (width - pad * 2.0).max(80.0);
        let mut items = Vec::new();
        let cover = |songs: &[usize]| songs.first().map(|&i| self.songs[i].id.clone());
        match &self.view {
            View::Posts => {
                if self.posts.is_empty() {
                    Self::prose(ui, "아직 플레이리스트가 없습니다.\n~/music/playlists/이름.md 파일에 글을 쓰고, 유튜브 주소를 한 줄에 하나씩 적어 보세요.", 13.0, room, 6.0, true, &mut items);
                }
                for (i, post) in self.posts.iter().enumerate() {
                    // 소개글의 첫 문단을 두 줄까지 보여 준다.
                    let first = post.intro.lines().map(str::trim).find(|line| !line.is_empty() && !line.starts_with("## ")).unwrap_or("");
                    let mut excerpt = wrap(ui, first, 12.0, Style::PLAIN, (room - 160.0).max(60.0));
                    if excerpt.len() > 2 {
                        excerpt.truncate(2);
                        excerpt[1].push('…');
                    }
                    if excerpt.is_empty() {
                        excerpt.push(String::new());
                    }
                    items.push(Item::Card { cover: post.entries.first().map(|e| e.id.clone()), title: post.title.clone(), sub: self.post_sub(post), excerpt, go: View::Post(i) });
                }
            }
            View::Artists => {
                for (name, songs) in self.artists() {
                    items.push(Item::Card { cover: cover(&songs), sub: format!("{}곡", songs.len()), go: View::Artist(name.clone()), title: name, excerpt: Vec::new() });
                }
            }
            View::Albums => {
                let albums = self.albums();
                if albums.is_empty() {
                    Self::prose(ui, "앨범을 적어 둔 곡이 없습니다.\n곡 목록(songs.txt)에서 곡의 넷째 칸에 앨범을 적어 보세요.", 13.0, room, 6.0, true, &mut items);
                }
                for (name, songs) in albums {
                    let artist = self.artist_name(&self.songs[songs[0]]);
                    items.push(Item::Card { cover: cover(&songs), sub: format!("{artist} · {}곡", songs.len()), go: View::Album(name.clone()), title: name, excerpt: Vec::new() });
                }
            }
            View::Songs | View::Artist(_) | View::Album(_) => {
                let songs = self.songs_of(&self.view);
                if songs.is_empty() {
                    Self::prose(ui, &format!("등록한 곡이 없습니다.\n{SHARED}/songs.txt 파일에 유튜브 주소를 한 줄에 하나씩 적어 주세요."), 13.0, room, 6.0, true, &mut items);
                }
                for (at, song) in songs.into_iter().enumerate() {
                    items.push(Item::Song { at, song });
                }
            }
            View::Post(i) => {
                let Some(post) = self.posts.get(*i) else { return items };
                if !post.intro.is_empty() {
                    items.push(Item::Gap(8.0));
                    Self::prose(ui, &post.intro, 13.5, room - 12.0, 6.0, false, &mut items);
                    items.push(Item::Gap(14.0));
                }
                for (at, entry) in post.entries.iter().enumerate() {
                    let Some(&song) = self.index.get(&entry.id) else { continue };
                    items.push(Item::Song { at, song });
                    // 그 곡 아래에 쓴 글
                    if !entry.text.is_empty() {
                        items.push(Item::Gap(4.0));
                        Self::prose(ui, &entry.text, 13.5, room - 12.0, 6.0, false, &mut items);
                    }
                    items.push(Item::Gap(16.0));
                }
            }
        }
        items
    }

    fn draw_items(&mut self, ui: &mut Ui<Action>, area: Rect, pad: f32, items: &[Item]) {
        let theme = ui.theme;
        let mut tops = Vec::with_capacity(items.len());
        let mut total = 4.0;
        for item in items {
            tops.push(total);
            total += item.height();
        }
        self.content_h = total + 10.0;
        let most = (self.content_h - area.h).max(0.0);
        if std::mem::take(&mut self.reveal) {
            // 틀고 있는 곡의 줄이 보이도록 민다.
            let current = self.playing.and_then(|at| self.queue.get(at).copied());
            let row = items.iter().zip(&tops).find(|(item, _)| matches!(item, Item::Song { song, .. } if Some(*song) == current));
            if let (Some((_, &top)), true) = (row, area.h > TRACK_ROW + 12.0) {
                self.scroll = self.scroll.clamp((top + TRACK_ROW + 8.0 - area.h).max(0.0), top.max(0.0));
            }
        }
        self.scroll = self.scroll.clamp(0.0, most);
        ui.clip(area);
        for (item, top) in items.iter().zip(&tops) {
            let y = area.y + top - self.scroll;
            let h = item.height();
            if y + h < area.y || y > area.bottom() {
                continue;
            }
            match item {
                Item::Song { at, song } => self.draw_row(ui, Rect::new(area.x + pad - 6.0, y, area.w - pad * 2.0 + 12.0, h - 2.0), *at, *song),
                Item::Text { line, size, bold, quiet, indent } => {
                    let style = if *bold { Style::BOLD } else { Style::PLAIN };
                    ui.text(area.x + pad + indent, y + h / 2.0, *size, if *quiet { theme.muted } else { theme.text }, style, line);
                }
                Item::Card { cover, title, sub, excerpt, go } => {
                    let rect = Rect::new(area.x + pad - 6.0, y, area.w - pad * 2.0 + 12.0, h - 4.0);
                    if ui.hot(rect) {
                        ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
                    }
                    let tall = !excerpt.is_empty();
                    let picture = if tall { Rect::new(rect.x + 8.0, rect.y + 8.0, 128.0, 72.0) } else { Rect::new(rect.x + 8.0, rect.y + 7.0, 71.0, 40.0) };
                    self.cover(ui, picture, cover.as_deref());
                    let x = picture.right() + 14.0;
                    let room = rect.right() - x - 12.0;
                    if tall {
                        ui.label(x, rect.y + 20.0, 15.0, theme.text, Style::BOLD, room, title);
                        ui.label(x, rect.y + 40.0, 11.5, theme.muted, Style::PLAIN, room, sub);
                        for (k, line) in excerpt.iter().enumerate() {
                            ui.text(x, rect.y + 59.0 + k as f32 * 17.0, 12.0, theme.muted, Style::PLAIN, line);
                        }
                    } else {
                        ui.label(x, rect.mid_y() - 8.5, 13.5, theme.text, Style::PLAIN, room, title);
                        ui.label(x, rect.mid_y() + 9.0, 11.5, theme.muted, Style::PLAIN, room, sub);
                    }
                    ui.target(rect, Role::Link, false, title, Action::Go(go.clone()));
                }
                Item::Gap(_) => {}
            }
        }
        if self.content_h > area.h && area.h > 0.0 {
            let thumb = (area.h * area.h / self.content_h).max(24.0);
            let top = area.y + (area.h - thumb) * self.scroll / most.max(1.0);
            ui.f.rect(area.right() - 5.0, top, 3.0, thumb, 1.5, theme.line_strong);
        }
        ui.unclip();
    }

    /// 곡 한 줄: 순번(또는 재생 표시), 그림, 제목과 아티스트, 앨범, 길이
    fn draw_row(&self, ui: &mut Ui<Action>, rect: Rect, at: usize, song: usize) {
        let theme = ui.theme;
        let track = &self.songs[song];
        let current = self.playing.and_then(|at| self.queue.get(at).copied()) == Some(song);
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
            ui.f.styled(cx + 5.0, cy, 12.0, if current { theme.accent } else { theme.muted }, Align::Right, Style::MONO, &(at + 1).to_string());
        }
        self.cover(ui, Rect::new(rect.x + 36.0, rect.y + 7.0, 53.0, 30.0), Some(&track.id));
        let length = self.lengths.get(&track.id).map_or(String::new(), |seconds| clock(*seconds));
        let length_w = ui.width("0:00:00", 11.5, Style::MONO);
        ui.f.styled(rect.right() - 12.0, cy, 11.5, theme.muted, Align::Right, Style::MONO, &length);
        let mut room = rect.w - 100.0 - length_w - 24.0;
        // 넓으면 앨범도 한 칸 (앨범을 펼쳐 둔 때는 빼고)
        if let (Some(album), true) = (&track.album, rect.w > 560.0 && !matches!(self.view, View::Album(_))) {
            let x = rect.x + (rect.w * 0.6).round();
            ui.label(x, cy, 12.0, theme.muted, Style::PLAIN, rect.right() - length_w - 36.0 - x, album);
            room = x - rect.x - 100.0 - 16.0;
        }
        let (title, artist) = (self.title(track), self.artist(track));
        let style = Style { strike: broken, ..Style::PLAIN };
        ui.label(rect.x + 100.0, cy - 8.5, 13.0, ink, style, room, title);
        let note = self.broken.get(&track.id).copied().unwrap_or(artist);
        ui.label(rect.x + 100.0, cy + 9.0, 11.5, theme.muted, Style::PLAIN, room, note);
        ui.target(rect, Role::Option, current, title, Action::Play(at));
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
        let left_w = if narrow { bar.w - 116.0 } else { (bar.w * 0.3).clamp(210.0, 330.0) };
        let cover = if narrow { Rect::new(bar.x + 10.0, mid - 24.0, 85.0, 48.0) } else { Rect::new(bar.x + 14.0, mid - 30.0, 107.0, 60.0) };
        if narrow && self.loaded && !self.unsupported {
            // 좁은 화면에는 보관함이 없으므로, 플레이어를 이 그림 자리에 놓는다.
            // (넓은 화면에서는 왼쪽 보관함의 아래에 놓는다.)
            ui.f.rect(cover.x, cover.y, cover.w, cover.h, 4.0, Color::rgb(16, 17, 20));
            ui.f.player(cover.x, cover.y, cover.w, cover.h);
        } else {
            self.cover(ui, cover, track.map(|t| t.id.as_str()));
        }
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
            Action::Go(view) => {
                self.view = view;
                self.scroll = 0.0;
            }
            Action::Play(at) => self.play_from_view(at),
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
            Action::PlayAll => {
                let count = self.songs_of(&self.view).len();
                let first = if self.shuffle { self.random(count) } else { 0 };
                self.play_from_view(first);
            }
            Action::ViewMenu => {
                // 보관함의 보기들과 플레이리스트들
                let posts = self.posts.iter().enumerate().map(|(i, post)| (post.title.clone(), View::Post(i)));
                let (labels, views): (Vec<String>, Vec<View>) = Self::nav().into_iter().map(|(name, view)| (name.to_string(), view)).chain(posts).unzip();
                self.menu = Some((at, labels.iter().map(|label| MenuItem::new(label)).collect()));
                self.menu_views = views;
            }
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
            Event::Menu(Some(i)) => match self.menu_views.get(i).cloned() {
                Some(view) => self.perform(Action::Go(view), (0.0, 0.0)),
                None => return false,
            },
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
                let count = self.queue.len();
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

/// 글 한 줄을 폭에 맞춰 여러 줄로 나눈다. 낱말 사이에서 나누고, 한 줄보다 긴 낱말은 글자 사이에서 나눈다.
fn wrap(ui: &mut Ui<Action>, text: &str, size: f32, style: Style, room: f32) -> Vec<String> {
    let mut lines = Vec::new();
    let (mut line, mut used) = (String::new(), 0.0f32);
    for word in text.split_inclusive(' ') {
        let width = ui.width(word, size, style);
        if used + width <= room {
            line.push_str(word);
            used += width;
        } else if width <= room {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
            used = width;
        } else {
            for c in word.chars() {
                let w = ui.width(c.encode_utf8(&mut [0; 4]), size, style);
                if used + w > room && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    used = 0.0;
                }
                line.push(c);
                used += w;
            }
        }
    }
    lines.push(line);
    lines.into_iter().map(|l| l.trim_end().to_string()).filter(|l| !l.is_empty()).collect()
}

fn main() {
    webos::init();
    let (w, h) = (980, 640);
    let window = match Window::open("음악", w, h) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("music: cannot open a window: {}", webos::describe(&e));
            process::exit(1);
        }
    };
    // 섞기의 씨앗: 켤 때마다 달라지게 지금 시각을 쓴다.
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1;
    let (songs, mut posts) = load();
    // 실행할 때 플레이리스트 파일을 주면 그 글을 펼친다: music ~/music/playlists/밤.md
    let mut opened = None;
    if let Some(path) = env::args().nth(1) {
        match read_post(Path::new(&path)) {
            Some(post) => {
                opened = Some(posts.iter().position(|known| *known == post).unwrap_or_else(|| {
                    posts.insert(0, post);
                    0
                }));
            }
            None => eprintln!("music: {path}: cannot read the file"),
        }
    }
    let none = Rect::new(0.0, 0.0, 0.0, 0.0);
    let mut app = App {
        window,
        widths: Widths::default(),
        w: w as f32,
        h: h as f32,
        dark: false,
        // 글이 있으면 글의 목록부터, 없으면 곡 목록부터 보여 준다.
        view: if posts.is_empty() { View::Songs } else { View::Posts },
        songs,
        index: HashMap::new(),
        posts,
        queue: Vec::new(),
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
        content_h: 0.0,
        reveal: false,
        mouse: None,
        dragging: None,
        hits: Vec::new(),
        hot: None,
        bars: (none, none, none),
        menu: None,
        menu_views: Vec::new(),
        opening: None,
        remembered: String::new(),
    };
    app.adopt();
    app.restore();
    if let Some(i) = opened {
        app.view = View::Post(i);
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
