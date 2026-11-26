//! 메모장. 메모 보관함(~/notes)의 글을 폴더로 정리하고, 탭으로 여러 개를 열어 고친다.
//!
//! 창에 보이는 것(보관함 트리, 탭, 단추, 상태 줄)은 모두 이 프로그램이 그리기 명령으로 보낸 것이다.
//! 글을 치는 곳만은 화면 쪽의 실제 입력 칸을 빌려 쓰고(한글 조합, 선택, 복사·붙여넣기를 위해서),
//! 메뉴는 시스템의 것을 띄워 달라고 한다. 파일을 읽고 쓰는 것은 다른 프로그램과 똑같은 파일 시스템 콜이다.

mod markdown;
mod preview;
mod ui;
mod vault;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::{env, fs, io, process};
use preview::Target;
use ui::{Rect, Tool, Ui, Widths, DARK, LIGHT, RADIUS, TOOL_H};
use vault::{base_of, dir_of, ext_of, is_inside, join, kind_of, shown, stem_of, Kind, ATTACHMENTS};
use webos::gui::{Align, Event, Field, Frame, Key, MenuItem, Role, Style, Window};

// 입력 칸의 번호
const EDITOR: u32 = 1;
const TITLE: u32 = 2;
const SEARCH: u32 = 3;
const DIR_NAME: u32 = 4;

/// 마지막 입력 뒤 이만큼 조용하면 저장한다.
const SAVE_DELAY_MS: u32 = 400;
const TREE_ROW: f32 = 28.0;
const HIT_ROW: f32 = 50.0;
const TABS_H: f32 = 37.0;
const HEAD_H: f32 = 46.0;
const PROMPT_H: f32 = 38.0;
const STATUS_H: f32 = 36.0;
const SIDE_TOP: f32 = 104.0;

/// 보기 방식 (마크다운 메모)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Edit,
    Split,
    Read,
}

const MODES: [(Mode, &str); 3] = [(Mode::Edit, "편집"), (Mode::Split, "나란히"), (Mode::Read, "읽기")];

/// 마지막으로 그린 미리보기: 자리, 문서의 높이, 제목들의 위치. 휠과 목차가 이것을 본다.
#[derive(Default)]
struct PreviewInfo {
    view: Option<Rect>,
    height: f32,
    headings: Vec<(usize, f32)>,
}

const FORMATS: [(&str, &str); 2] = [("md", "마크다운 (.md)"), ("txt", "텍스트 (.txt)")];

/// 보관함 안의 폴더나 파일. path는 보관함 기준이다.
#[derive(Clone, PartialEq, Debug)]
struct Entry {
    path: String,
    kind: Kind,
}

/// 누를 수 있는 자리마다 적어 두는 "할 일"
#[derive(Clone, PartialEq, Debug)]
enum Action {
    NewNote,
    NewFolder,
    FormatMenu,
    SetFormat(&'static str),
    /// 트리나 찾은 목록의 파일
    Open(String),
    Dir(String),
    /// 트리의 빈 곳
    TreeBlank,
    Tab(String),
    CloseTab(String),
    CloseOthers(String),
    Back,
    Forward,
    AskDelete(String),
    Delete,
    CancelDelete,
    RenameNote(String),
    RenameDir(String),
    MoveMenu(String),
    Move(String, String),
    NewNoteIn(String),
    NewFolderIn(String),
    SetMode(Mode),
    /// 미리보기의 [[링크]]
    Link(String),
    Tag(String),
    /// 체크 목록의 체크 (원문의 줄)
    Toggle(usize),
    /// 목차의 제목 (원문의 줄)
    Jump(usize),
    ToggleBacklinks,
    ToggleOutline,
    ToggleTags,
}

struct Row {
    path: String,
    kind: Kind,
    level: usize,
}

struct App {
    window: Window,
    widths: Widths,
    w: f32,
    h: f32,
    dark: bool,
    root: PathBuf,
    entries: Vec<Entry>,
    /// 메모의 내용: 경로 → 글 (찾기와 링크 고치기에 쓴다)
    texts: HashMap<String, String>,
    /// 열어 둔 파일
    current: Option<String>,
    /// 열어 둔 메모의 글 (입력 칸에 있는 것과 같다)
    text: String,
    /// 아직 저장하지 않은 변경이 있다.
    dirty: bool,
    tabs: Vec<String>,
    /// 지나온 파일들과 그 안에서의 지금 위치 (뒤로, 앞으로)
    trail: Vec<String>,
    trail_at: usize,
    /// 사용자가 탭을 모두 닫았다. 다른 메모를 열 때까지는 알아서 열지 않는다.
    stay_empty: bool,
    /// 새 메모와 새 폴더가 만들어질 폴더
    active_dir: String,
    collapsed: HashSet<String>,
    query: String,
    format: &'static str,
    /// 제목 칸에 적혀 있는 글
    title_draft: String,
    renaming_dir: Option<String>,
    dir_draft: String,
    confirming: Option<String>,
    error: String,
    tree_scroll: f32,
    mouse: Option<(f32, f32)>,
    /// 커서가 있는 입력 칸
    focused: Option<u32>,
    /// 다음에 그릴 때 커서를 옮길 칸 (true면 글 전체를 고른 채로)
    focus: Option<(u32, bool)>,
    /// 다음에 그릴 때 띄울 메뉴: 자리, 그리고 줄마다의 글과 할 일
    menu: Option<((f32, f32), Vec<(MenuItem, Option<Action>)>)>,
    /// 지금 떠 있는 메뉴의 줄마다 할 일
    menu_actions: Vec<Option<Action>>,
    /// 마지막으로 그린 화면에서 누를 수 있는 자리들
    hits: Vec<(Rect, Action)>,
    /// 포인터 아래에 있는 자리 (hits의 순번). 바뀔 때만 다시 그린다.
    hot: Option<usize>,
    mode: Mode,
    preview_scroll: f32,
    preview: RefCell<PreviewInfo>,
    /// 다음에 그릴 때 옮길 본문의 커서 자리 (바이트 위치)
    caret: Option<usize>,
    backlinks_open: bool,
    outline_open: bool,
    tags_open: bool,
    /// 마지막으로 그린 트리 영역의 높이 (스크롤의 끝을 정할 때 쓴다)
    tree_height: RefCell<f32>,
}

fn describe(what: &str, e: &io::Error) -> String {
    format!("{what}: {}", webos::describe(e))
}

/// 1234567 → "1,234,567"
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

impl App {
    // ───────────── 보관함 읽기 ─────────────

    fn absolute(&self, path: &str) -> PathBuf {
        if path.is_empty() {
            self.root.clone()
        } else {
            self.root.join(path)
        }
    }

    fn files(&self) -> Vec<String> {
        self.entries.iter().filter(|e| e.kind != Kind::Dir).map(|e| e.path.clone()).collect()
    }

    fn notes(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().filter(|e| e.kind == Kind::Note).map(|e| e.path.as_str())
    }

    fn kind(&self, path: &str) -> Option<Kind> {
        self.entries.iter().find(|e| e.path == path).map(|e| e.kind)
    }

    /// 폴더 바로 아래의 항목들: 폴더 먼저, 그다음 보이는 이름순
    fn children_of(&self, dir: &str) -> Vec<&Entry> {
        let mut found: Vec<&Entry> = self.entries.iter().filter(|e| dir_of(&e.path) == dir).collect();
        found.sort_by(|a, b| {
            (b.kind == Kind::Dir).cmp(&(a.kind == Kind::Dir)).then_with(|| vault::natural_cmp(shown(&a.path), shown(&b.path)))
        });
        found
    }

    fn names_in(&self, dir: &str) -> Vec<&str> {
        self.entries.iter().filter(|e| dir_of(&e.path) == dir).map(|e| base_of(&e.path)).collect()
    }

    fn walk(&self, dir: &str, out: &mut Vec<Entry>) {
        let Ok(list) = fs::read_dir(self.absolute(dir)) else { return };
        for item in list.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = join(dir, &name);
            if item.file_type().is_ok_and(|t| t.is_dir()) {
                out.push(Entry { path: path.clone(), kind: Kind::Dir });
                self.walk(&path, out);
            } else {
                out.push(Entry { kind: kind_of(&path), path });
            }
        }
    }

    /// 보관함을 다시 읽는다. 처음 열 때, 무언가를 바꾼 뒤, 그리고 창이 다시 앞으로 왔을 때
    /// (그사이 다른 프로그램이 파일을 바꿨을 수 있다) 부른다.
    fn load(&mut self) {
        if let Err(e) = fs::create_dir_all(&self.root) {
            self.error = describe("보관함을 만들지 못했습니다", &e);
        }
        let mut found = Vec::new();
        self.walk("", &mut found);
        found.sort_by(|a, b| a.path.cmp(&b.path));
        let mut texts = HashMap::new();
        for entry in found.iter().filter(|e| e.kind == Kind::Note) {
            if let Ok(text) = fs::read_to_string(self.absolute(&entry.path)) {
                texts.insert(entry.path.clone(), text);
            }
        }
        self.entries = found;
        self.texts = texts;
        // 사라진 파일은 탭과 지나온 길에서도 뺀다.
        let known: HashSet<String> = self.entries.iter().map(|e| e.path.clone()).collect();
        self.remap(|path| known.contains(path).then(|| path.to_string()));
        match self.current.clone() {
            // 치고 있어서 아직 저장하지 않은 것은 화면의 글이 더 새것이다.
            Some(path) if self.dirty => {
                self.texts.insert(path, self.text.clone());
            }
            Some(path) => {
                let on_disk = self.texts.get(&path).cloned().unwrap_or_default();
                if on_disk != self.text {
                    let _ = self.window.set_text(EDITOR, &on_disk);
                    self.text = on_disk;
                }
            }
            None if !self.stay_empty => {
                let next = self.tabs.last().cloned().or_else(|| self.notes().next().map(str::to_string));
                if let Some(path) = next {
                    self.show(&path, true);
                }
            }
            None => {}
        }
        if self.renaming_dir.as_ref().is_some_and(|dir| !known.contains(dir)) {
            self.renaming_dir = None;
        }
        if self.confirming.as_ref().is_some_and(|path| !known.contains(path)) {
            self.confirming = None;
        }
    }

    // ───────────── 저장 ─────────────

    fn save(&mut self) {
        let Some(path) = self.current.clone() else { return };
        if !self.dirty {
            return;
        }
        match fs::write(self.absolute(&path), &self.text) {
            Ok(()) => {
                self.dirty = false;
                self.error.clear();
            }
            Err(e) => self.error = describe("저장하지 못했습니다", &e),
        }
    }

    fn typed(&mut self) {
        match self.window.text(EDITOR) {
            Ok(text) if text != self.text => {
                if let Some(path) = &self.current {
                    self.texts.insert(path.clone(), text.clone());
                }
                self.text = text;
                self.dirty = true;
            }
            Ok(_) => {}
            Err(e) => self.error = describe("글을 읽지 못했습니다", &e),
        }
    }

    // ───────────── 탭과 지나온 길 ─────────────

    /// 화면에 올릴 파일을 바꾼다. 쓰던 것은 저장하고, 입력 칸들의 글을 새 파일의 것으로 채운다.
    fn set_current(&mut self, path: Option<&str>) {
        if self.current.as_deref() == path {
            return;
        }
        self.save();
        self.dirty = false;
        self.current = path.map(str::to_string);
        self.text.clear();
        self.preview_scroll = 0.0;
        let Some(path) = path else { return };
        if kind_of(path) == Kind::Note {
            match fs::read_to_string(self.absolute(path)) {
                Ok(text) => self.text = text,
                Err(e) => self.error = describe("열지 못했습니다", &e),
            }
            self.texts.insert(path.to_string(), self.text.clone());
        }
        let _ = self.window.set_text(EDITOR, &self.text);
        self.sync_title();
    }

    fn sync_title(&mut self) {
        self.title_draft = self.current.as_deref().map(stem_of).unwrap_or_default().to_string();
        let _ = self.window.set_text(TITLE, &self.title_draft);
    }

    /// 파일을 화면에 올린다: 탭에 없으면 탭을 만들고, 지나온 길에 적는다.
    fn show(&mut self, path: &str, record: bool) {
        self.set_current(Some(path));
        if !self.tabs.iter().any(|tab| tab == path) {
            self.tabs.push(path.to_string());
        }
        if record && self.trail.get(self.trail_at).map(String::as_str) != Some(path) {
            self.trail.truncate((self.trail_at + 1).min(self.trail.len()));
            self.trail.push(path.to_string());
            self.trail_at = self.trail.len() - 1;
        }
    }

    fn open(&mut self, path: &str, record: bool) {
        self.stay_empty = false;
        self.error.clear();
        self.show(path, record);
        self.active_dir = dir_of(path).to_string();
        self.confirming = None;
        // 그 파일이 든 폴더들이 접혀 있으면 펼친다.
        self.collapsed.retain(|dir| !is_inside(path, dir));
        if kind_of(path) == Kind::Note {
            self.focus = Some((EDITOR, false));
        }
    }

    /// 경로가 바뀌거나(이름 바꾸기, 옮기기) 없어졌을 때(None), 경로를 기억하는 모든 곳을 함께 고친다.
    fn remap(&mut self, to: impl Fn(&str) -> Option<String>) {
        let mut tabs: Vec<String> = Vec::new();
        for path in self.tabs.iter().filter_map(|p| to(p)) {
            if !tabs.contains(&path) {
                tabs.push(path);
            }
        }
        self.tabs = tabs;
        let mut trail: Vec<String> = Vec::new();
        let mut at = 0;
        for (i, path) in self.trail.iter().enumerate() {
            if let Some(moved) = to(path) {
                if trail.last() != Some(&moved) {
                    trail.push(moved);
                }
            }
            if i == self.trail_at {
                at = trail.len().saturating_sub(1);
            }
        }
        (self.trail, self.trail_at) = (trail, at);
        if let Some(path) = self.current.clone() {
            match to(&path) {
                Some(moved) if moved == path => {}
                // 같은 파일이 자리만 옮겼다: 쓰던 글은 그대로다.
                Some(moved) => {
                    self.current = Some(moved);
                    self.sync_title();
                }
                None => {
                    self.dirty = false;
                    self.set_current(None);
                }
            }
        }
    }

    fn can_go(&self, step: isize) -> bool {
        self.trail_at.checked_add_signed(step).is_some_and(|at| at < self.trail.len())
    }

    /// 뒤로(-1), 앞으로(+1)
    fn go(&mut self, step: isize) {
        if !self.can_go(step) {
            return;
        }
        self.trail_at = self.trail_at.wrapping_add_signed(step);
        let path = self.trail[self.trail_at].clone();
        self.open(&path, false);
    }

    fn close_tab(&mut self, path: &str) {
        let Some(at) = self.tabs.iter().position(|tab| tab == path) else { return };
        self.tabs.remove(at);
        if self.current.as_deref() != Some(path) {
            return;
        }
        // 닫은 탭의 오른쪽, 없으면 왼쪽 탭으로 간다.
        match self.tabs.get(at).or_else(|| at.checked_sub(1).and_then(|left| self.tabs.get(left))).cloned() {
            Some(next) => self.open(&next, true),
            None => {
                self.stay_empty = true;
                self.set_current(None);
            }
        }
    }

    // ───────────── 만들기, 이름 바꾸기, 옮기기, 지우기 ─────────────

    /// 빈 메모를 만들어 연다. 만들었으면 true.
    fn create_note(&mut self, dir: &str, stem: &str) -> bool {
        let name = vault::unique_name(&self.names_in(dir), stem, self.format);
        let path = join(dir, &name);
        match fs::create_dir_all(self.absolute(dir)).and_then(|_| fs::write(self.absolute(&path), "")) {
            Ok(()) => {
                self.query.clear();
                let _ = self.window.set_text(SEARCH, "");
                self.load();
                self.open(&path, true);
                true
            }
            Err(e) => {
                self.error = describe("만들지 못했습니다", &e);
                false
            }
        }
    }

    fn new_note(&mut self, dir: &str) {
        if self.create_note(dir, "제목 없음") {
            // 새 메모는 제목부터 정하도록 제목 칸에 커서를 둔다.
            self.focus = Some((TITLE, true));
        }
    }

    // ───────────── 링크, 태그, 목차 ─────────────

    /// [[대상]]을 누르면 그 메모를 열고, 아직 없으면 그 이름으로 만든다.
    fn open_link(&mut self, target: &str) {
        if let Some(found) = vault::resolve_link(target, &self.files()).map(str::to_string) {
            return self.open(&found, true);
        }
        let stem = base_of(target).to_string();
        if let Some(problem) = vault::name_problem(&stem) {
            self.error = problem.to_string();
            return;
        }
        let dir = self.current.as_deref().map(dir_of).unwrap_or_default().to_string();
        self.create_note(&dir, &stem);
    }

    /// 이 메모를 가리키는 다른 메모들과, 링크가 든 줄
    fn backlinks(&self) -> Vec<(&str, &str)> {
        let Some(here) = self.current.as_deref() else { return Vec::new() };
        let known = self.files();
        self.notes()
            .filter(|path| *path != here)
            .filter_map(|path| {
                let body = self.texts.get(path)?;
                let line = body.lines().find(|line| vault::parse_links(line).iter().any(|link| vault::resolve_link(&link.target, &known) == Some(here)))?;
                Some((path, line.trim()))
            })
            .collect()
    }

    fn is_markdown(&self) -> bool {
        self.current.as_deref().is_some_and(|path| ext_of(path) == "md")
    }

    /// 지금 메모의 보기 방식. 마크다운이 아니면 늘 편집이다.
    fn view_mode(&self) -> Mode {
        if self.is_markdown() {
            self.mode
        } else {
            Mode::Edit
        }
    }

    fn outline(&self) -> Vec<markdown::Heading> {
        if self.is_markdown() {
            markdown::outline_of(&self.text)
        } else {
            Vec::new()
        }
    }

    /// 보관함의 모든 태그와, 그 태그가 든 메모의 수 (많은 것부터)
    fn all_tags(&self) -> Vec<(String, usize)> {
        let mut count: Vec<(String, usize)> = Vec::new();
        for path in self.notes() {
            for tag in markdown::tags_of(self.texts.get(path).map_or("", String::as_str)) {
                match count.iter_mut().find(|(name, _)| *name == tag) {
                    Some((_, n)) => *n += 1,
                    None => count.push((tag, 1)),
                }
            }
        }
        count.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| vault::natural_cmp(&a.0, &b.0)));
        count
    }

    /// 목차에서 고른 제목으로 간다: 편집 화면은 커서를 그 줄에 두고, 읽기 화면은 그 제목이 보이게 한다.
    fn jump(&mut self, line: usize) {
        if self.view_mode() != Mode::Read {
            self.caret = Some(self.text.split('\n').take(line).map(|l| l.len() + 1).sum());
        }
        let preview = self.preview.borrow();
        if let (Some(view), Some(&(_, y))) = (preview.view, preview.headings.iter().find(|(at, _)| *at == line)) {
            self.preview_scroll = (y - 8.0).clamp(0.0, (preview.height - view.h).max(0.0));
        }
    }

    fn set_query(&mut self, query: &str) {
        self.query = query.to_string();
        self.tree_scroll = 0.0;
        let _ = self.window.set_text(SEARCH, query);
    }

    fn toggle_task(&mut self, line: usize) {
        let text = markdown::toggle_task(&self.text, line);
        if text == self.text {
            return;
        }
        let _ = self.window.set_text(EDITOR, &text);
        if let Some(path) = &self.current {
            self.texts.insert(path.clone(), text.clone());
        }
        self.text = text;
        self.dirty = true;
    }

    fn new_folder(&mut self, dir: &str) {
        let path = join(dir, &vault::unique_name(&self.names_in(dir), "새 폴더", ""));
        match fs::create_dir_all(self.absolute(&path)) {
            Ok(()) => {
                self.load();
                self.collapsed.retain(|d| !is_inside(&path, d));
                self.active_dir = dir.to_string();
                self.rename_dir_start(&path);
            }
            Err(e) => self.error = describe("폴더를 만들지 못했습니다", &e),
        }
    }

    /// 다른 메모들 안의, 옛 경로를 가리키던 링크를 새 경로로 고쳐 쓴다.
    fn relink(&mut self, old: &str, new: &str, known: &[String]) {
        let notes: Vec<String> = self.notes().map(str::to_string).collect();
        for path in notes {
            let Some(before) = self.texts.get(&path) else { continue };
            let after = vault::rename_links(before, old, new, known);
            if &after == before {
                continue;
            }
            if let Err(e) = fs::write(self.absolute(&path), &after) {
                self.error = describe("링크를 고치지 못했습니다", &e);
            }
            if self.current.as_deref() == Some(path.as_str()) {
                let _ = self.window.set_text(EDITOR, &after);
                self.text = after.clone();
            }
            self.texts.insert(path, after);
        }
    }

    /// 제목 칸에 적힌 이름으로 열어 둔 메모의 파일 이름을 바꾼다.
    fn commit_title(&mut self) {
        let Some(from) = self.current.clone() else { return };
        let stem = self.title_draft.trim().to_string();
        if kind_of(&from) != Kind::Note || stem == stem_of(&from) {
            return self.sync_title();
        }
        let ext = ext_of(&from);
        let to = join(dir_of(&from), &format!("{stem}.{ext}"));
        let problem = vault::name_problem(&stem).or_else(|| {
            let taken = self.names_in(dir_of(&from)).into_iter().any(|name| name.to_lowercase() == base_of(&to).to_lowercase() && name != base_of(&from));
            taken.then_some("같은 이름의 파일이 이미 있습니다.")
        });
        if let Some(problem) = problem {
            self.error = problem.to_string();
            return self.sync_title();
        }
        self.save();
        let known = self.files();
        match fs::rename(self.absolute(&from), self.absolute(&to)) {
            Ok(()) => {
                self.error.clear();
                self.remap(|path| Some(if path == from { to.clone() } else { path.to_string() }));
                self.load();
                self.relink(&from, &to, &known);
            }
            Err(e) => {
                self.error = describe("이름을 바꾸지 못했습니다", &e);
                self.sync_title();
            }
        }
    }

    fn rename_dir_start(&mut self, dir: &str) {
        self.renaming_dir = Some(dir.to_string());
        self.dir_draft = base_of(dir).to_string();
        let _ = self.window.set_text(DIR_NAME, &self.dir_draft);
        self.focus = Some((DIR_NAME, true));
    }

    fn commit_dir_name(&mut self) {
        let Some(from) = self.renaming_dir.take() else { return };
        let name = self.dir_draft.trim().to_string();
        if name == base_of(&from) {
            return;
        }
        let problem = vault::name_problem(&name)
            .or_else(|| self.names_in(dir_of(&from)).into_iter().any(|n| n.to_lowercase() == name.to_lowercase()).then_some("같은 이름이 이미 있습니다."));
        if let Some(problem) = problem {
            self.error = problem.to_string();
            return;
        }
        let to = join(dir_of(&from), &name);
        self.save();
        match fs::rename(self.absolute(&from), self.absolute(&to)) {
            Ok(()) => self.moved(&from, &to),
            Err(e) => self.error = describe("이름을 바꾸지 못했습니다", &e),
        }
    }

    /// 파일이나 폴더가 from에서 to로 옮겨졌다: 그 안의 것을 가리키던 경로들을 모두 고친다.
    fn moved(&mut self, from: &str, to: &str) {
        let shift = |path: &str| if is_inside(path, from) { format!("{to}{}", &path[from.len()..]) } else { path.to_string() };
        self.remap(|path| Some(shift(path)));
        self.active_dir = shift(&self.active_dir);
        self.collapsed = self.collapsed.iter().map(|dir| shift(dir)).collect();
        self.error.clear();
        self.load();
    }

    /// 파일이나 폴더를 다른 폴더로 옮긴다 (dest가 빈 문자열이면 보관함 맨 위).
    fn move_to(&mut self, path: &str, dest: &str) {
        if let Some(problem) = vault::move_problem(path, dest, &self.names_in(dest)) {
            if !problem.is_empty() {
                self.error = problem.to_string();
            }
            return;
        }
        let to = join(dest, base_of(path));
        let known = self.files();
        self.save();
        match fs::rename(self.absolute(path), self.absolute(&to)) {
            Ok(()) => {
                self.moved(path, &to);
                self.collapsed.retain(|dir| !is_inside(&to, dir));
                // 이름만 적은 링크는 그대로 통한다. 폴더까지 적은 링크([[폴더/메모]])만 새 자리로 고친다.
                for old in known.iter().filter(|old| is_inside(old, path)) {
                    self.relink(old, &format!("{to}{}", &old[path.len()..]), &known);
                }
            }
            Err(e) => self.error = describe("옮기지 못했습니다", &e),
        }
    }

    fn remove(&mut self, path: &str) {
        self.confirming = None;
        let target = self.absolute(path);
        let removed = if self.kind(path) == Some(Kind::Dir) { fs::remove_dir_all(target) } else { fs::remove_file(target) };
        match removed {
            Ok(()) => {
                if is_inside(&self.active_dir, path) {
                    self.active_dir = dir_of(path).to_string();
                }
                self.remap(|p| (!is_inside(p, path)).then(|| p.to_string()));
                self.load();
            }
            Err(e) => self.error = describe("지우지 못했습니다", &e),
        }
    }

    // ───────────── 찾기 ─────────────

    /// 찾는 글이 든 메모들과, 그 글이 나온 줄
    fn results(&self) -> Vec<(&str, &str)> {
        let wanted = self.query.trim().to_lowercase();
        self.notes()
            .filter_map(|path| {
                let body = self.texts.get(path).map_or("", String::as_str);
                let line = body.lines().find(|line| line.to_lowercase().contains(&wanted));
                if line.is_none() && !stem_of(path).to_lowercase().contains(&wanted) {
                    return None;
                }
                Some((path, line.or_else(|| body.lines().find(|l| !l.trim().is_empty())).unwrap_or("").trim()))
            })
            .collect()
    }

    // ───────────── 화면 ─────────────

    fn side(&self) -> f32 {
        if self.w < 620.0 {
            (self.w * 0.4).clamp(120.0, 250.0)
        } else {
            250.0
        }
    }

    /// 트리에 보이는 줄들 (접힌 폴더의 안쪽은 뺀다)
    fn rows(&self) -> Vec<Row> {
        fn add(app: &App, dir: &str, level: usize, out: &mut Vec<Row>) {
            for entry in app.children_of(dir) {
                out.push(Row { path: entry.path.clone(), kind: entry.kind, level });
                if entry.kind == Kind::Dir && !app.collapsed.contains(&entry.path) {
                    add(app, &entry.path, level + 1, out);
                }
            }
        }
        let mut out = Vec::new();
        add(self, "", 1, &mut out);
        out
    }

    fn list_height(&self) -> f32 {
        if self.query.trim().is_empty() {
            self.rows().len() as f32 * TREE_ROW
        } else {
            self.results().len() as f32 * HIT_ROW
        }
    }

    fn max_scroll(&self) -> f32 {
        (self.list_height() + 6.0 - *self.tree_height.borrow()).max(0.0)
    }

    fn draw(&mut self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let mut ui = Ui::new(self.window, std::mem::take(&mut self.widths), theme, self.mouse);
        let focus = self.focus.take();
        ui.f.clear(theme.surface);
        self.draw_main(&mut ui, focus);
        self.draw_side(&mut ui, focus);
        if let Some(at) = self.caret.take() {
            ui.f.select(EDITOR, at, at);
        }
        if let Some(((x, y), items)) = self.menu.take() {
            let (labels, actions): (Vec<MenuItem>, Vec<Option<Action>>) = items.into_iter().unzip();
            ui.f.menu(x, y, &labels);
            self.menu_actions = actions;
        }
        self.widths = ui.widths;
        self.hits = ui.hits;
        self.hot = self.hit_at(self.mouse);
        ui.f
    }

    /// 한 줄짜리 입력 칸을 테두리와 함께 놓는다.
    #[allow(clippy::too_many_arguments)]
    fn input(&self, ui: &mut Ui<Action>, rect: Rect, id: u32, size: f32, bold: bool, label: &str, placeholder: &str, focus: Option<(u32, bool)>) {
        ui.f.field(&Field {
            id,
            x: rect.x + 7.0,
            y: rect.y + 1.5,
            w: (rect.w - 14.0).max(4.0),
            h: rect.h - 3.0,
            size,
            color: ui.theme.text,
            background: ui.theme.surface,
            multiline: false,
            mono: false,
            bold,
            focus: focus.is_some_and(|(field, _)| field == id),
            select: focus.is_some_and(|(field, select)| field == id && select),
            label,
            placeholder,
        });
    }

    fn draw_side(&self, ui: &mut Ui<Action>, focus: Option<(u32, bool)>) {
        let theme = ui.theme;
        let side = self.side();
        ui.f.rect(0.0, 0.0, side, self.h, 0.0, theme.surface2);
        ui.vline(side - 1.0, 0.0, self.h);

        // 단추들: 새 메모, 새 메모의 형식, 새 폴더
        let mut x = 8.0;
        x += ui.tool(x, 6.0, "새 메모", Tool::Primary, false, Some(Action::NewNote)) + 6.0;
        let format = Rect::new(x, 6.0, (side - 9.0 - x).max(0.0), TOOL_H);
        if format.w >= 48.0 {
            let name = FORMATS.iter().find(|(ext, _)| *ext == self.format).map_or("", |f| f.1);
            ui.f.rect(format.x, format.y, format.w, format.h, RADIUS, theme.surface);
            if ui.hot(format) {
                ui.f.rect(format.x, format.y, format.w, format.h, RADIUS, theme.hover);
            }
            ui.f.frame(format.x, format.y, format.w, format.h, RADIUS, theme.line, 1.0);
            ui.label(format.x + 9.0, format.mid_y(), 12.0, theme.text, Style::PLAIN, format.w - 30.0, name);
            let (cx, cy) = (format.right() - 13.0, format.mid_y());
            ui.f.line(&[(cx - 3.5, cy - 1.5), (cx, cy + 2.0), (cx + 3.5, cy - 1.5)], theme.muted, 1.3);
            ui.target(format, Role::Button, false, &format!("새 메모의 형식: {name}"), Action::FormatMenu);
        }
        ui.tool(8.0, 38.0, "새 폴더", Tool::Plain, false, Some(Action::NewFolder));

        // 찾기
        let find = Rect::new(8.0, 70.0, side - 17.0, 28.0);
        ui.field_box(find, self.focused == Some(SEARCH));
        self.input(ui, find, SEARCH, 13.0, false, "메모 찾기", "메모 찾기", focus);

        let bottom = self.draw_sections(ui, side - 1.0);
        let area = Rect::new(0.0, SIDE_TOP, side - 1.0, (bottom - SIDE_TOP).max(0.0));
        *self.tree_height.borrow_mut() = area.h;
        let scroll = self.tree_scroll.min(self.max_scroll());
        ui.clip(area);
        ui.hit(area, Action::TreeBlank);
        if self.query.trim().is_empty() {
            self.draw_tree(ui, area, scroll, focus);
        } else {
            self.draw_results(ui, area, scroll);
        }
        // 넘치는 목록의 스크롤 막대
        let total = self.list_height() + 6.0;
        if total > area.h && area.h > 0.0 {
            let thumb = (area.h * area.h / total).max(24.0);
            let top = area.y + (area.h - thumb) * scroll / (total - area.h);
            ui.f.rect(area.right() - 5.0, top, 3.0, thumb, 1.5, theme.line_strong);
        }
        ui.unclip();
    }

    /// 보관함 아래의 접을 수 있는 구역들(목차, 태그)을 아래에서부터 쌓아 그린다. 그 맨 위의 y를 돌려준다.
    fn draw_sections(&self, ui: &mut Ui<Action>, width: f32) -> f32 {
        const HEAD: f32 = 30.0;
        const ROW: f32 = 24.0;
        let theme = ui.theme;
        let limit = (self.h * 0.3).max(HEAD);
        let mut bottom = self.h;
        let header = |ui: &mut Ui<Action>, y: f32, open: bool, label: &str, action: Action| {
            ui.hline(0.0, y, width);
            let rect = Rect::new(0.0, y + 1.0, width, HEAD - 1.0);
            let (cx, cy) = (16.0, rect.mid_y());
            let arrow: [(f32, f32); 3] = if open { [(cx - 3.5, cy - 2.0), (cx, cy + 2.0), (cx + 3.5, cy - 2.0)] } else { [(cx - 2.0, cy - 3.5), (cx + 2.0, cy), (cx - 2.0, cy + 3.5)] };
            ui.f.line(&arrow, theme.muted, 1.3);
            ui.label(27.0, cy, 12.5, theme.muted, Style::PLAIN, width - 36.0, label);
            ui.target(rect, Role::Button, open, label, action);
        };

        // 태그: 누르면 그 태그가 든 메모를 찾는다.
        let tags = self.all_tags();
        if !tags.is_empty() {
            let mut places: Vec<(Rect, String, usize)> = Vec::new();
            let mut body = 0.0;
            if self.tags_open {
                let (mut x, mut y) = (10.0, 0.0);
                for (tag, count) in &tags {
                    let w = ui.width(&format!("#{tag} {count}"), 12.0, Style::PLAIN) + 14.0;
                    if x + w > width - 10.0 && x > 10.0 {
                        (x, y) = (10.0, y + 24.0);
                    }
                    places.push((Rect::new(x, y, w, 20.0), tag.clone(), *count));
                    x += w + 4.0;
                }
                body = (y + 28.0).min(limit - HEAD);
            }
            let top = bottom - HEAD - body;
            header(ui, top, self.tags_open, &format!("태그 {}개", tags.len()), Action::ToggleTags);
            ui.clip(Rect::new(0.0, top + HEAD, width, body));
            for (rect, tag, count) in places {
                let rect = Rect::new(rect.x, top + HEAD + rect.y, rect.w, rect.h);
                let pressed = self.query == format!("#{tag}");
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, 10.0, theme.accent_soft);
                if pressed {
                    ui.f.frame(rect.x, rect.y, rect.w, rect.h, 10.0, theme.accent, 1.5);
                }
                let name = format!("#{tag}");
                let name_w = ui.width(&format!("{name} "), 12.0, Style::PLAIN);
                ui.text(rect.x + 7.0, rect.mid_y(), 12.0, theme.accent, Style::PLAIN, &name);
                ui.text(rect.x + 7.0 + name_w, rect.mid_y(), 12.0, theme.accent.alpha(166), Style::PLAIN, &count.to_string());
                ui.target(rect, Role::Button, pressed, &name, Action::Tag(tag));
            }
            ui.unclip();
            bottom = top;
        }

        // 목차: 지금 메모의 제목들
        let outline = self.outline();
        if !outline.is_empty() {
            let body = if self.outline_open { (outline.len() as f32 * ROW + 6.0).min(limit - HEAD) } else { 0.0 };
            let top = bottom - HEAD - body;
            header(ui, top, self.outline_open, "목차", Action::ToggleOutline);
            ui.clip(Rect::new(0.0, top + HEAD, width, body));
            for (i, heading) in outline.iter().enumerate().take_while(|_| self.outline_open) {
                let rect = Rect::new(6.0, top + HEAD + i as f32 * ROW, width - 12.0, ROW);
                if ui.hot(rect) {
                    ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
                }
                let x = rect.x + 10.0 + (heading.level - 1) as f32 * 10.0;
                ui.label(x, rect.mid_y(), 12.5, theme.text, Style::PLAIN, rect.right() - 8.0 - x, &heading.title);
                ui.target(rect, Role::Button, false, &heading.title, Action::Jump(heading.line));
            }
            ui.unclip();
            bottom = top;
        }
        bottom
    }

    fn draw_tree(&self, ui: &mut Ui<Action>, area: Rect, scroll: f32, focus: Option<(u32, bool)>) {
        let theme = ui.theme;
        let rows = self.rows();
        if rows.is_empty() {
            ui.f.styled(area.x + area.w / 2.0, area.y + 26.0, 12.0, theme.muted, Align::Center, Style::PLAIN, "아직 메모가 없습니다.");
        }
        for (i, row) in rows.iter().enumerate() {
            let rect = Rect::new(6.0, area.y + i as f32 * TREE_ROW - scroll, area.w - 12.0, TREE_ROW);
            if rect.bottom() < area.y || rect.y > area.bottom() {
                continue; // 보이는 줄만 그린다
            }
            let is_dir = row.kind == Kind::Dir;
            let selected = !is_dir && self.current.as_deref() == Some(row.path.as_str());
            let active = is_dir && self.active_dir == row.path;
            let renaming = self.renaming_dir.as_deref() == Some(row.path.as_str());
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            if active {
                ui.f.rect(rect.x, rect.y + 2.0, 2.0, rect.h - 4.0, 1.0, theme.accent);
            }
            let x = rect.x + 9.5 + (row.level - 1) as f32 * 14.0;
            let (icon, color) = match row.kind {
                Kind::Dir => (ui::FOLDER, theme.accent),
                Kind::Note => (ui::NOTE, theme.muted),
                _ => (ui::FILE, theme.muted),
            };
            ui.icon(x, rect.y + 5.5, 0.85, color, icon);
            let name_x = x + 24.5;
            let name = shown(&row.path);
            if renaming {
                let edit = Rect::new(name_x - 6.0, rect.y + 2.5, (rect.right() - name_x + 2.0).max(30.0), 23.0);
                ui.field_box(edit, true);
                self.input(ui, edit, DIR_NAME, 13.0, false, "폴더 이름", "", focus);
                continue;
            }
            let mut room = rect.right() - 8.0 - name_x;
            let action = if is_dir { Action::Dir(row.path.clone()) } else { Action::Open(row.path.clone()) };
            ui.target(rect, Role::TreeItem, selected, name, action);
            if active {
                // 고른 폴더에는 지우기 단추가 나온다.
                let close = Rect::new(rect.right() - 26.0, rect.y + 4.0, 20.0, 20.0);
                ui.close_button(close, true, &format!("{name} 폴더 지우기"), Action::AskDelete(row.path.clone()));
                room -= 24.0;
            }
            let ext = ext_of(&row.path);
            if row.kind == Kind::Note && ext != "md" {
                let w = ui.width(&ext, 10.5, Style::MONO);
                ui.text(rect.right() - 8.0 - w, rect.mid_y(), 10.5, theme.muted, Style::MONO, &ext);
                room -= w + 6.0;
            }
            ui.label(name_x, rect.mid_y(), 13.0, theme.text, Style::PLAIN, room, name);
        }
    }

    fn draw_results(&self, ui: &mut Ui<Action>, area: Rect, scroll: f32) {
        let theme = ui.theme;
        let results = self.results();
        if results.is_empty() {
            ui.f.styled(area.x + area.w / 2.0, area.y + 26.0, 12.0, theme.muted, Align::Center, Style::PLAIN, "찾는 내용이 든 메모가 없습니다.");
        }
        for (i, (path, line)) in results.into_iter().enumerate() {
            let rect = Rect::new(6.0, area.y + i as f32 * HIT_ROW - scroll, area.w - 12.0, HIT_ROW - 2.0);
            if rect.bottom() < area.y || rect.y > area.bottom() {
                continue;
            }
            let selected = self.current.as_deref() == Some(path);
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            ui.label(rect.x + 8.0, rect.y + 15.0, 13.0, theme.text, Style::BOLD, rect.w - 16.0, stem_of(path));
            ui.label(rect.x + 8.0, rect.y + 34.0, 12.0, theme.muted, Style::PLAIN, rect.w - 16.0, if line.is_empty() { path } else { line });
            ui.target(rect, Role::Option, selected, stem_of(path), Action::Open(path.to_string()));
        }
    }

    fn draw_main(&self, ui: &mut Ui<Action>, focus: Option<(u32, bool)>) {
        let theme = ui.theme;
        let x0 = self.side();
        let width = (self.w - x0).max(0.0);
        self.draw_tabs(ui, x0, width);
        let mut y = TABS_H;

        // 지우기 확인
        if let Some(target) = &self.confirming {
            ui.f.rect(x0, y, width, PROMPT_H, 0.0, theme.surface2);
            ui.hline(x0, y + PROMPT_H - 1.0, width);
            let what = match self.kind(target) {
                Some(Kind::Dir) => " 폴더와 그 안의 모든 것을",
                Some(Kind::Image) => " 그림을",
                Some(Kind::Note) => " 메모를",
                _ => " 파일을",
            };
            let cancel = ui.tool_width("취소");
            let remove = ui.tool_width("지우기");
            let by = y + (PROMPT_H - 1.0 - TOOL_H) / 2.0;
            ui.tool(x0 + width - 8.0 - cancel, by, "취소", Tool::Plain, false, Some(Action::CancelDelete));
            ui.tool(x0 + width - 14.0 - cancel - remove, by, "지우기", Tool::Danger, false, Some(Action::Delete));
            let question = format!("“{}”{what} 지울까요?", base_of(target));
            ui.label(x0 + 10.0, y + (PROMPT_H - 1.0) / 2.0, 12.0, theme.text, Style::PLAIN, width - 40.0 - cancel - remove, &question);
            y += PROMPT_H;
        }

        let Some(path) = self.current.as_deref() else {
            let mid = y + (self.h - y) / 2.0;
            ui.f.styled(x0 + width / 2.0, mid, 13.0, theme.muted, Align::Center, Style::PLAIN, "“새 메모”를 눌러 적기 시작하세요.");
            if !self.error.is_empty() {
                // 열어 둔 메모가 없으면 상태 줄도 없으므로, 오류는 여기에 보여 준다.
                ui.f.styled(x0 + width / 2.0, mid + 24.0, 12.0, theme.danger, Align::Center, Style::PLAIN, &self.error);
            }
            return;
        };
        let is_note = kind_of(path) == Kind::Note;

        // 제목 줄: 제목(파일 이름)과 단추들
        ui.hline(x0, y + HEAD_H - 1.0, width);
        let remove = ui.tool_width("삭제");
        ui.tool(x0 + width - 8.0 - remove, y + 9.5, "삭제", Tool::Plain, false, Some(Action::AskDelete(path.to_string())));
        let mut right = x0 + width - 14.0 - remove;
        if self.is_markdown() {
            // 보기 방식: 편집 / 나란히 / 읽기
            let widths: Vec<f32> = MODES.iter().map(|(_, name)| ui.width(name, 13.0, Style::BOLD).ceil() + 28.0).collect();
            let total: f32 = widths.iter().sum::<f32>() + 4.0;
            let group = Rect::new(right - total, y + 7.0, total, 31.0);
            ui.f.rect(group.x, group.y, group.w, group.h, 10.0, theme.surface2);
            ui.f.frame(group.x, group.y, group.w, group.h, 10.0, theme.line, 1.0);
            let mut x = group.x + 2.0;
            for ((mode, name), w) in MODES.iter().zip(widths) {
                let rect = Rect::new(x, group.y + 2.0, w, 27.0);
                let pressed = self.mode == *mode;
                if pressed {
                    ui.f.rect(rect.x, rect.y, rect.w, rect.h, 8.0, theme.surface);
                    ui.f.frame(rect.x, rect.y, rect.w, rect.h, 8.0, theme.line, 1.0);
                }
                ui.f.styled(rect.x + w / 2.0, rect.mid_y(), 13.0, theme.text, Align::Center, Style { bold: pressed, ..Style::PLAIN }, name);
                ui.target(rect, Role::Button, pressed, name, Action::SetMode(*mode));
                x += w;
            }
            right = group.x - 6.0;
        }
        let title = Rect::new(x0 + 8.0, y + 7.0, (right - x0 - 8.0).max(40.0), 31.0);
        if is_note {
            // 평소에는 글처럼 보이다가 커서가 들어가면 테두리가 생긴다.
            if self.focused == Some(TITLE) {
                ui.f.frame(title.x, title.y, title.w, title.h, RADIUS, theme.line_strong, 1.0);
            }
            self.input(ui, title, TITLE, 15.0, true, "제목", "", focus);
        } else {
            ui.label(title.x + 7.0, title.mid_y(), 15.0, theme.text, Style::BOLD, title.w - 14.0, base_of(path));
        }
        y += HEAD_H;

        // 상태 줄
        let status = Rect::new(x0, self.h - STATUS_H, width, STATUS_H);
        ui.hline(x0, status.y, width);
        let count = if is_note { format!("{}자", grouped(self.text.chars().count())) } else { String::new() };
        let count_w = ui.width(&count, 12.0, Style::PLAIN);
        ui.f.styled(status.right() - 8.0, status.mid_y(), 12.0, theme.muted, Align::Right, Style::PLAIN, &count);
        let room = width - 24.0 - count_w;
        if self.error.is_empty() {
            let state = if !is_note { "" } else if self.dirty { " · 저장 중…" } else { " · 저장됨" };
            ui.label(x0 + 8.0, status.mid_y(), 12.0, theme.muted, Style::PLAIN, room, &format!("notes/{path}{state}"));
        } else {
            ui.label(x0 + 8.0, status.mid_y(), 12.0, theme.danger, Style::PLAIN, room, &self.error);
        }

        // 이 메모를 가리키는 메모들 (상태 줄 바로 위)
        let mut body_bottom = status.y;
        let backlinks = if is_note { self.backlinks() } else { Vec::new() };
        if !backlinks.is_empty() {
            const HEAD: f32 = 30.0;
            const ROW: f32 = 24.0;
            let rows = if self.backlinks_open { (backlinks.len() as f32 * ROW + 8.0).min(((self.h - y) * 0.3).max(ROW + 8.0)) } else { 0.0 };
            let top = body_bottom - HEAD - rows;
            ui.hline(x0, top, width);
            let head = Rect::new(x0, top + 1.0, width, HEAD - 1.0);
            let (cx, cy) = (x0 + 17.0, head.mid_y());
            let arrow: [(f32, f32); 3] = if self.backlinks_open { [(cx - 3.5, cy - 2.0), (cx, cy + 2.0), (cx + 3.5, cy - 2.0)] } else { [(cx - 2.0, cy - 3.5), (cx + 2.0, cy), (cx - 2.0, cy + 3.5)] };
            ui.f.line(&arrow, theme.muted, 1.3);
            let label = format!("이 메모를 가리키는 메모 {}개", backlinks.len());
            ui.text(x0 + 28.0, cy, 12.5, theme.muted, Style::PLAIN, &label);
            ui.target(head, Role::Button, self.backlinks_open, &label, Action::ToggleBacklinks);
            ui.clip(Rect::new(x0, top + HEAD, width, rows));
            for (i, (from, line)) in backlinks.iter().enumerate().take_while(|_| self.backlinks_open) {
                let mid = top + HEAD + i as f32 * ROW + ROW / 2.0;
                let name = stem_of(from);
                let name_w = ui.width(name, 12.5, Style::PLAIN);
                ui.text(x0 + 12.0, mid, 12.5, theme.accent, Style { underline: true, ..Style::PLAIN }, name);
                ui.target(Rect::new(x0 + 12.0, mid - 10.0, name_w, 20.0), Role::Link, false, name, Action::Open(from.to_string()));
                ui.label(x0 + 22.0 + name_w, mid, 12.0, theme.muted, Style::PLAIN, width - 34.0 - name_w, line);
            }
            ui.unclip();
            body_bottom = top;
        }

        // 본문
        let body = Rect::new(x0, y, width, (body_bottom - y).max(0.0));
        if !is_note {
            let hint = if kind_of(path) == Kind::Image {
                format!("메모에 넣으려면 ![[{}]] 라고 적습니다.", base_of(path))
            } else {
                "메모장에서 열 수 없는 파일입니다.".to_string()
            };
            ui.f.styled(body.x + body.w / 2.0, body.mid_y(), 12.0, theme.muted, Align::Center, Style::PLAIN, &hint);
            *self.preview.borrow_mut() = PreviewInfo::default();
            return;
        }
        let mode = self.view_mode();
        // 나란히 보기: 왼쪽에서 쓰고 오른쪽에서 결과를 본다.
        let (editor, reading) = match mode {
            Mode::Edit => (Some(body), None),
            Mode::Read => (None, Some(body)),
            Mode::Split => {
                let half = (body.w / 2.0).floor();
                (Some(Rect::new(body.x, body.y, half, body.h)), Some(Rect::new(body.x + half, body.y, body.w - half, body.h)))
            }
        };
        if let Some(rect) = editor {
            ui.f.field(&Field {
                id: EDITOR,
                x: rect.x + 14.0,
                y: rect.y + 12.0,
                w: (rect.w - 28.0).max(20.0),
                h: (rect.h - 24.0).max(20.0),
                size: 13.0,
                color: theme.text,
                background: theme.surface,
                multiline: true,
                mono: true,
                bold: false,
                focus: focus.is_some_and(|(field, _)| field == EDITOR),
                select: false,
                label: "메모 내용",
                placeholder: "",
            });
        }
        let mut info = PreviewInfo::default();
        if let Some(view) = reading {
            if mode == Mode::Split {
                ui.vline(view.x, view.y, view.h);
            }
            let files = self.files();
            let act = |target: Target| match target {
                Target::Link(to) => Action::Link(to),
                Target::Tag(name) => Action::Tag(name),
                Target::Toggle(line) => Action::Toggle(line),
            };
            // 먼저 높이만 재서 스크롤의 끝을 정하고, 그다음에 그린다.
            let measured = preview::render(ui, &files, &self.texts, &self.text, view, 0.0, false, true, &act);
            let scroll = self.preview_scroll.min((measured.height - view.h).max(0.0));
            ui.clip(view);
            preview::render(ui, &files, &self.texts, &self.text, view, scroll, true, true, &act);
            if measured.height > view.h && view.h > 0.0 {
                let thumb = (view.h * view.h / measured.height).max(24.0);
                let top = view.y + (view.h - thumb) * scroll / (measured.height - view.h);
                ui.f.rect(view.right() - 5.0, top, 3.0, thumb, 1.5, theme.line_strong);
            }
            ui.unclip();
            info = PreviewInfo { view: Some(view), height: measured.height, headings: measured.headings };
        }
        *self.preview.borrow_mut() = info;
    }

    /// 열어 둔 메모들의 탭과 뒤로·앞으로 단추
    fn draw_tabs(&self, ui: &mut Ui<Action>, x0: f32, width: f32) {
        let theme = ui.theme;
        ui.f.rect(x0, 0.0, width, TABS_H - 1.0, 0.0, theme.surface2);
        ui.hline(x0, TABS_H - 1.0, width);
        let mut x = x0 + 8.0;
        for (glyph, name, step, action) in [("←", "뒤로", -1, Action::Back), ("→", "앞으로", 1, Action::Forward)] {
            let rect = Rect::new(x, 5.0, 26.0, TOOL_H);
            let enabled = self.can_go(step);
            let hot = enabled && ui.hot(rect);
            ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.surface);
            if hot {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            let fade = |c: webos::gui::Color| if enabled { c } else { c.alpha((c.0 & 0xff) as u8 / 2) };
            ui.f.frame(rect.x, rect.y, rect.w, rect.h, RADIUS, fade(if hot { theme.line_strong } else { theme.line }), 1.0);
            ui.f.styled(rect.x + 13.0, rect.mid_y(), 12.0, fade(theme.text), Align::Center, Style::PLAIN, glyph);
            if enabled {
                ui.target(rect, Role::Button, false, name, action);
            } else {
                ui.f.region(rect.x, rect.y, rect.w, rect.h, Role::Button, false, true, name);
            }
            x += 30.0;
        }
        let strip = Rect::new(x, 0.0, (x0 + width - 8.0 - x).max(0.0), TABS_H - 1.0);
        if self.tabs.is_empty() || strip.w < 20.0 {
            return;
        }
        let count = self.tabs.len() as f32;
        let tab_w = ((strip.w - 2.0 * (count - 1.0)) / count).clamp(64.0, 160.0);
        // 탭이 넘치면 지금 탭이 보이도록 왼쪽으로 민다.
        let at = self.current.as_ref().and_then(|cur| self.tabs.iter().position(|tab| tab == cur)).unwrap_or(0) as f32;
        let offset = (at * (tab_w + 2.0) + tab_w - strip.w).max(0.0);
        ui.clip(strip);
        for (i, path) in self.tabs.iter().enumerate() {
            let rect = Rect::new(strip.x + i as f32 * (tab_w + 2.0) - offset, 5.0, tab_w, TOOL_H);
            let selected = self.current.as_deref() == Some(path.as_str());
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.surface);
                ui.f.frame(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.line, 1.0);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            let name = shown(path);
            ui.label(rect.x + 10.0, rect.mid_y(), 12.5, if selected { theme.text } else { theme.muted }, Style::PLAIN, rect.w - 34.0, name);
            ui.target(rect, Role::Tab, selected, name, Action::Tab(path.clone()));
            let close = Rect::new(rect.right() - 22.0, rect.y + 4.0, 18.0, 18.0);
            ui.close_button(close, false, &format!("{name} 탭 닫기"), Action::CloseTab(path.clone()));
        }
        ui.unclip();
    }

    // ───────────── 입력 ─────────────

    fn hit_at(&self, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at?;
        self.hits.iter().rposition(|(rect, _)| rect.contains(at))
    }

    fn show_menu(&mut self, at: (f32, f32), items: Vec<(MenuItem, Option<Action>)>) {
        self.menu = Some((at, items));
    }

    /// 우클릭한 자리에 맞는 메뉴
    fn context_menu(&mut self, action: Action, at: (f32, f32)) {
        let item = |label: &str, action: Action| (MenuItem::new(label), Some(action));
        let danger = |label: &str, action: Action| (MenuItem::danger(label), Some(action));
        let separator = || (MenuItem::separator(), None);
        let items = match action {
            Action::Open(path) => {
                let mut items = vec![item("열기", Action::Open(path.clone()))];
                if kind_of(&path) == Kind::Note {
                    items.push(item("이름 바꾸기", Action::RenameNote(path.clone())));
                }
                items.extend([item("다른 폴더로 옮기기…", Action::MoveMenu(path.clone())), separator(), danger("삭제…", Action::AskDelete(path))]);
                items
            }
            Action::Dir(path) => {
                self.active_dir = path.clone();
                vec![
                    item("여기에 새 메모", Action::NewNoteIn(path.clone())),
                    item("여기에 새 폴더", Action::NewFolderIn(path.clone())),
                    separator(),
                    item("이름 바꾸기", Action::RenameDir(path.clone())),
                    item("다른 폴더로 옮기기…", Action::MoveMenu(path.clone())),
                    danger("삭제…", Action::AskDelete(path)),
                ]
            }
            Action::TreeBlank => {
                self.active_dir.clear();
                vec![item("새 메모", Action::NewNoteIn(String::new())), item("새 폴더", Action::NewFolderIn(String::new()))]
            }
            Action::Tab(path) | Action::CloseTab(path) => vec![
                item("탭 닫기", Action::CloseTab(path.clone())),
                (MenuItem::new("다른 탭 모두 닫기").disabled_if(self.tabs.len() < 2), Some(Action::CloseOthers(path))),
            ],
            _ => return,
        };
        self.show_menu(at, items);
    }

    fn perform(&mut self, action: Action, at: (f32, f32), clicks: i32) {
        match action {
            Action::NewNote => self.new_note(&self.active_dir.clone()),
            Action::NewFolder => self.new_folder(&self.active_dir.clone()),
            Action::NewNoteIn(dir) => {
                self.active_dir = dir.clone();
                self.new_note(&dir);
            }
            Action::NewFolderIn(dir) => self.new_folder(&dir),
            Action::FormatMenu => {
                let items = FORMATS.iter().map(|&(ext, name)| (MenuItem::new(name), Some(Action::SetFormat(ext)))).collect();
                self.show_menu(at, items);
            }
            Action::SetFormat(ext) => self.format = ext,
            Action::Open(path) | Action::Tab(path) => self.open(&path, true),
            Action::Dir(path) => {
                self.active_dir = path.clone();
                if !self.collapsed.remove(&path) {
                    self.collapsed.insert(path.clone());
                }
                // 두 번 누르면 이름을 바꾼다.
                if clicks == 2 {
                    self.rename_dir_start(&path);
                }
            }
            Action::TreeBlank => self.active_dir.clear(),
            Action::CloseTab(path) => self.close_tab(&path),
            Action::CloseOthers(path) => {
                self.open(&path, true);
                self.tabs.retain(|tab| *tab == path);
            }
            Action::Back => self.go(-1),
            Action::Forward => self.go(1),
            Action::AskDelete(path) => self.confirming = Some(path),
            Action::Delete => {
                if let Some(path) = self.confirming.clone() {
                    self.remove(&path);
                }
            }
            Action::CancelDelete => self.confirming = None,
            Action::RenameNote(path) => {
                self.open(&path, true);
                self.focus = Some((TITLE, true));
            }
            Action::RenameDir(path) => self.rename_dir_start(&path),
            Action::MoveMenu(path) => {
                // 옮길 수 있는 폴더들을 메뉴로 보여 준다.
                let dirs = std::iter::once("").chain(self.entries.iter().filter(|e| e.kind == Kind::Dir).map(|e| e.path.as_str()));
                let mut items: Vec<(MenuItem, Option<Action>)> = dirs
                    .filter(|dir| vault::move_problem(&path, dir, &self.names_in(dir)).is_none())
                    .map(|dir| (MenuItem::new(if dir.is_empty() { "보관함 맨 위" } else { dir }), Some(Action::Move(path.clone(), dir.to_string()))))
                    .collect();
                if items.is_empty() {
                    items.push((MenuItem::new("옮길 수 있는 폴더가 없습니다").disabled_if(true), None));
                }
                self.show_menu(at, items);
            }
            Action::Move(path, dest) => self.move_to(&path, &dest),
            Action::SetMode(mode) => {
                self.mode = mode;
                if mode != Mode::Read {
                    self.focus = Some((EDITOR, false));
                }
            }
            Action::Link(target) => self.open_link(&target),
            // 태그를 누르면 그 태그가 든 메모를 찾는다. 다시 누르면 찾기를 지운다.
            Action::Tag(name) => {
                let wanted = format!("#{name}");
                self.set_query(if self.query == wanted { "" } else { &wanted });
            }
            Action::Toggle(line) => self.toggle_task(line),
            Action::Jump(line) => self.jump(line),
            Action::ToggleBacklinks => self.backlinks_open = !self.backlinks_open,
            Action::ToggleOutline => self.outline_open = !self.outline_open,
            Action::ToggleTags => self.tags_open = !self.tags_open,
        }
    }

    /// 입력 하나를 처리한다. 화면을 다시 그려야 하면 true.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Resize { w, h, dark } => {
                (self.w, self.h, self.dark) = (w, h, dark);
                self.tree_scroll = self.tree_scroll.min(self.max_scroll());
            }
            Event::PointerMove { x, y } => {
                self.mouse = Some((x, y));
                return self.hit_at(self.mouse) != self.hot;
            }
            Event::PointerLeave => {
                self.mouse = None;
                return self.hot.is_some();
            }
            Event::PointerDown { x, y, button, clicks } => {
                self.mouse = Some((x, y));
                let Some(action) = self.hit_at(self.mouse).map(|i| self.hits[i].1.clone()) else { return false };
                match button {
                    0 => self.perform(action, (x, y), clicks),
                    // 탭은 가운데 단추로 누르면 닫힌다.
                    1 => match action {
                        Action::Tab(path) => self.close_tab(&path),
                        _ => return false,
                    },
                    _ => self.context_menu(action, (x, y)),
                }
            }
            Event::Wheel { x, dy, .. } if x < self.side() => {
                let to = (self.tree_scroll + dy).clamp(0.0, self.max_scroll());
                if to == self.tree_scroll {
                    return false;
                }
                self.tree_scroll = to;
            }
            Event::Wheel { x, y, dy } => {
                let preview = self.preview.borrow();
                let Some(view) = preview.view.filter(|view| view.contains((x, y))) else { return false };
                let to = (self.preview_scroll + dy).clamp(0.0, (preview.height - view.h).max(0.0));
                if to == self.preview_scroll {
                    return false;
                }
                drop(preview);
                self.preview_scroll = to;
            }
            Event::Input { field } => match field {
                EDITOR => self.typed(),
                TITLE => self.title_draft = self.window.text(TITLE).unwrap_or_default(),
                DIR_NAME => self.dir_draft = self.window.text(DIR_NAME).unwrap_or_default(),
                SEARCH => {
                    self.query = self.window.text(SEARCH).unwrap_or_default();
                    self.tree_scroll = 0.0;
                }
                _ => return false,
            },
            Event::FieldFocus { field, on } => {
                self.focused = if on { Some(field) } else { self.focused.filter(|f| *f != field) };
                // 칸을 벗어나면 적어 둔 이름으로 바꾼다.
                if !on && field == TITLE {
                    self.commit_title();
                } else if !on && field == DIR_NAME {
                    self.commit_dir_name();
                }
            }
            Event::Key { key: Key::Enter, .. } if self.focused == Some(TITLE) => {
                self.commit_title();
                self.focus = Some((EDITOR, false));
            }
            Event::Key { key: Key::Enter, .. } if self.focused == Some(DIR_NAME) => self.commit_dir_name(),
            Event::Key { key: Key::Escape, .. } => {
                if self.focused == Some(TITLE) {
                    self.sync_title();
                    self.focus = Some((EDITOR, false));
                } else if self.renaming_dir.take().is_none() && self.confirming.take().is_none() {
                    return false;
                }
            }
            Event::Key { key, mods } if mods.command() => match key {
                Key::Char(c) if c.eq_ignore_ascii_case(&'s') && !mods.alt => self.save(),
                // 어디에 커서가 있든 Ctrl/Cmd+Alt+N 으로 새 메모를 만든다. (Ctrl/Cmd+N 은 브라우저가 새 창에 쓴다.)
                Key::Char(c) if c.eq_ignore_ascii_case(&'n') && mods.alt => self.new_note(&self.active_dir.clone()),
                Key::Left if mods.alt => self.go(-1),
                Key::Right if mods.alt => self.go(1),
                _ => return false,
            },
            Event::Menu(chosen) => {
                let actions = std::mem::take(&mut self.menu_actions);
                match chosen.and_then(|i| actions.into_iter().nth(i).flatten()) {
                    Some(action) => self.perform(action, self.mouse.unwrap_or((0.0, 0.0)), 1),
                    None => return false,
                }
            }
            Event::Focus(true) => {
                if !self.dirty {
                    self.load();
                }
            }
            // 다른 창으로 넘어가면 기다리지 않고 바로 저장한다 (곧바로 다른 프로그램이 이 파일을 읽을 수 있다).
            Event::Focus(false) => self.save(),
            Event::Close => {
                self.commit_title();
                self.save();
                process::exit(0);
            }
            _ => return false,
        }
        true
    }
}

fn main() {
    webos::init();
    let (w, h) = (900, 580);
    let window = match Window::open("메모장", w, h) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("notepad: cannot open a window: {}", webos::describe(&e));
            process::exit(1);
        }
    };
    let home = env::var("HOME").unwrap_or_else(|_| "/home/guest".into());
    let mut app = App {
        window,
        widths: Widths::default(),
        w: w as f32,
        h: h as f32,
        dark: false,
        root: Path::new(&home).join("notes"),
        entries: Vec::new(),
        texts: HashMap::new(),
        current: None,
        text: String::new(),
        dirty: false,
        tabs: Vec::new(),
        trail: Vec::new(),
        trail_at: 0,
        stay_empty: false,
        active_dir: String::new(),
        collapsed: HashSet::from([ATTACHMENTS.to_string()]),
        query: String::new(),
        format: FORMATS[0].0,
        title_draft: String::new(),
        renaming_dir: None,
        dir_draft: String::new(),
        confirming: None,
        error: String::new(),
        tree_scroll: 0.0,
        mouse: None,
        focused: None,
        focus: None,
        menu: None,
        menu_actions: Vec::new(),
        hits: Vec::new(),
        hot: None,
        mode: Mode::Edit,
        preview_scroll: 0.0,
        preview: RefCell::default(),
        caret: None,
        backlinks_open: false,
        outline_open: true,
        tags_open: false,
        tree_height: RefCell::new(0.0),
    };
    // 실행할 때 파일 이름을 주면 그것을 연다: notepad 장보기.md
    match env::args().nth(1) {
        Some(name) => {
            app.stay_empty = true;
            app.load();
            if app.kind(&name).is_some_and(|kind| kind != Kind::Dir) {
                app.open(&name, true);
            } else {
                app.error = format!("그런 파일이 없습니다: {name}");
            }
        }
        None => app.load(),
    }
    let frame = app.draw();
    let _ = app.window.present(&frame);
    loop {
        // 저장할 것이 있으면 입력이 잠시 멈추기를 기다렸다가 저장한다.
        let event = if app.dirty && app.error.is_empty() { app.window.next_event_within(SAVE_DELAY_MS) } else { app.window.next_event() };
        let mut redraw = match event {
            Some(event) => app.handle(event),
            None if app.dirty => {
                app.save();
                true
            }
            None => break,
        };
        while let Some(event) = app.window.poll_event() {
            redraw |= app.handle(event);
        }
        if redraw {
            let frame = app.draw();
            let _ = app.window.present(&frame);
        }
    }
}
