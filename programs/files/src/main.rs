//! 파일 탐색기. 파일시스템을 둘러보고, 만들고, 이름을 바꾸고, 지운다.
//!
//! 창에 보이는 것은 모두 이 프로그램이 그리기 명령으로 보낸 것이고, 파일을 다루는 것은 다른 프로그램과 똑같은 시스템 콜이다.
//! 파일을 두 번 누르면 화면 쪽에 "알맞은 앱으로 열어 달라"고 청한다.

use std::path::Path;
use std::{env, fs, io, process};
use webos::gui::{Align, Event, Field, Frame, Key, MenuItem, Role, Style, Window};
use webos::ui::{self, natural_cmp, Rect, Tool, Ui, Widths, DARK, LIGHT, RADIUS, TOOL_H};

/// 이름을 고치는 입력 칸
const RENAME: u32 = 1;
const BAR_H: f32 = 39.0;
const ROW_H: f32 = 28.0;
const STATUS_H: f32 = 36.0;
/// 다른 프로그램이 파일을 바꿨는지 이만큼마다 다시 본다.
const REFRESH_MS: u32 = 1000;

/// 새로 만들 수 있는 파일 형식: 이름, 확장자, 처음 넣어 둘 내용
const FILE_TYPES: [(&str, &str, &str); 5] =
    [("텍스트", ".txt", ""), ("마크다운", ".md", ""), ("JSON", ".json", "{}\n"), ("셸 스크립트", ".sh", ""), ("CSV", ".csv", "")];

#[derive(Clone, PartialEq, Debug)]
struct Entry {
    name: String,
    dir: bool,
    /// 파일은 바이트 수, 폴더는 안에 든 항목의 수
    size: u64,
}

#[derive(Clone, PartialEq, Debug)]
enum Action {
    Go(String),
    NewFolder,
    ToggleTypes,
    NewFile(usize),
    Select(String),
    /// 목록의 빈 곳
    Blank,
    Open(String),
    Rename(String),
    AskDelete,
    Delete,
    CancelDelete,
    Copy(String),
}

struct App {
    window: Window,
    widths: Widths,
    w: f32,
    h: f32,
    dark: bool,
    cwd: String,
    entries: Vec<Entry>,
    selected: Option<String>,
    renaming: Option<String>,
    rename_draft: String,
    confirming: bool,
    error: String,
    /// 새 파일의 형식을 고르는 중인가
    choosing_type: bool,
    scroll: f32,
    mouse: Option<(f32, f32)>,
    hits: Vec<(Rect, Action)>,
    hot: Option<usize>,
    menu: Option<((f32, f32), Vec<(MenuItem, Option<Action>)>)>,
    menu_actions: Vec<Option<Action>>,
    /// 다음에 그릴 때 이름 칸에 커서를 주고 이만큼(바이트)을 고른다.
    focus_rename: Option<usize>,
    copying: Option<String>,
    /// 다음에 그릴 때 알맞은 앱으로 열어 달라고 할 파일
    launching: Option<String>,
    /// 화면 쪽에 알린 창의 제목
    titled: String,
}

fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn parent(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(at) => path[..at].to_string(),
    }
}

fn base(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// 사람이 읽기 쉬운 크기 표기
fn format_size(bytes: u64) -> String {
    const K: f64 = 1024.0;
    let b = bytes as f64;
    if b < K {
        format!("{bytes} B")
    } else if b < K * K {
        format!("{:.1} KB", b / K)
    } else if b < K * K * K {
        format!("{:.1} MB", b / K / K)
    } else {
        format!("{:.1} GB", b / K / K / K)
    }
}

fn describe(e: &io::Error) -> String {
    webos::describe(e)
}

impl App {
    /// 지금 폴더를 다시 읽는다. 목록이 달라졌으면 true.
    fn refresh(&mut self) -> bool {
        let list = match fs::read_dir(&self.cwd) {
            Ok(list) => list,
            Err(_) if self.cwd != "/" => {
                // 보고 있던 폴더가 지워졌으면 위로 올라간다.
                self.cwd = parent(&self.cwd);
                self.selected = None;
                self.refresh();
                return true;
            }
            Err(e) => {
                self.error = describe(&e);
                return true;
            }
        };
        let mut found: Vec<Entry> = list
            .flatten()
            .filter_map(|item| {
                let name = item.file_name().to_string_lossy().into_owned();
                // 점으로 시작하는 파일(셸 이력 등)은 숨긴다.
                if name.starts_with('.') {
                    return None;
                }
                let meta = item.metadata().ok()?;
                let dir = meta.is_dir();
                let size = if dir { fs::read_dir(item.path()).map_or(0, |inner| inner.count() as u64) } else { meta.len() };
                Some(Entry { name, dir, size })
            })
            .collect();
        // 폴더 먼저, 그다음 이름순
        found.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural_cmp(&a.name, &b.name)));
        if found == self.entries {
            return false;
        }
        self.entries = found;
        if !self.selected.as_ref().is_some_and(|name| self.entries.iter().any(|e| &e.name == name)) {
            self.selected = None;
            self.confirming = false;
        }
        if self.renaming.as_ref().is_some_and(|name| !self.entries.iter().any(|e| &e.name == name)) {
            self.renaming = None;
        }
        self.scroll = self.scroll.min(self.max_scroll());
        true
    }

    fn current(&self) -> Option<&Entry> {
        self.entries.iter().find(|e| Some(&e.name) == self.selected.as_ref())
    }

    fn go(&mut self, path: &str) {
        self.cwd = path.to_string();
        self.selected = None;
        self.renaming = None;
        self.confirming = false;
        self.choosing_type = false;
        self.error.clear();
        self.scroll = 0.0;
        self.entries.clear();
        self.refresh();
    }

    /// 항목을 고른다. 이전 작업의 오류 안내는 더 볼 필요가 없으므로 지운다.
    fn select(&mut self, name: Option<String>) {
        self.error.clear();
        self.confirming = false;
        self.selected = name;
        self.reveal();
    }

    /// 고른 줄이 보이도록 목록을 민다.
    fn reveal(&mut self) {
        let Some(at) = self.entries.iter().position(|e| Some(&e.name) == self.selected.as_ref()) else { return };
        let (top, height) = (at as f32 * ROW_H, self.list_rect().h - 12.0);
        self.scroll = self.scroll.clamp((top + ROW_H - height).max(0.0), top).min(self.max_scroll());
    }

    fn open(&mut self, name: &str) {
        let Some(entry) = self.entries.iter().find(|e| e.name == name) else { return };
        let path = join(&self.cwd, name);
        if entry.dir {
            self.go(&path);
        } else {
            self.launching = Some(path);
        }
    }

    /// "새 폴더", "새 폴더 2", … 중 아직 없는 이름
    fn fresh_name(&self, stem: &str, ext: &str) -> String {
        (1..)
            .map(|n| if n > 1 { format!("{stem} {n}{ext}") } else { format!("{stem}{ext}") })
            .find(|name| !self.entries.iter().any(|e| &e.name == name))
            .expect("some name is free")
    }

    /// 파일 작업의 결과를 받아, 실패했으면 창 아래에 이유를 보여 준다.
    fn settle(&mut self, result: io::Result<()>) -> bool {
        match &result {
            Ok(()) => self.error.clear(),
            Err(e) => self.error = describe(e),
        }
        self.refresh();
        result.is_ok()
    }

    fn create(&mut self, name: String, make: impl FnOnce(&Path) -> io::Result<()>) {
        let made = make(Path::new(&join(&self.cwd, &name)));
        if self.settle(made) {
            // 만들자마자 이름을 고칠 수 있게 한다.
            self.selected = Some(name.clone());
            self.reveal();
            self.start_rename(&name);
        }
    }

    fn start_rename(&mut self, name: &str) {
        let Some(entry) = self.entries.iter().find(|e| e.name == name) else { return };
        // 확장자는 남기고 이름 부분만 고른 채로 시작한다.
        let stem = if entry.dir { name.len() } else { name.rfind('.').filter(|dot| *dot > 0).unwrap_or(name.len()) };
        self.selected = Some(name.to_string());
        self.renaming = Some(name.to_string());
        self.rename_draft = name.to_string();
        self.confirming = false;
        let _ = self.window.set_text(RENAME, name);
        self.focus_rename = Some(stem);
    }

    fn commit_rename(&mut self) {
        let Some(from) = self.renaming.take() else { return };
        let to = self.rename_draft.trim().to_string();
        if to.is_empty() || to == from {
            return;
        }
        if to.contains('/') {
            self.error = "이름에는 / 를 쓸 수 없습니다.".to_string();
            return;
        }
        let target = join(&self.cwd, &to);
        if Path::new(&target).exists() {
            self.error = "같은 이름이 이미 있습니다.".to_string();
            return;
        }
        if self.settle(fs::rename(join(&self.cwd, &from), target)) {
            self.selected = Some(to);
        }
    }

    fn remove(&mut self) {
        self.confirming = false;
        let Some(entry) = self.current().cloned() else { return };
        let path = join(&self.cwd, &entry.name);
        let removed = if entry.dir { fs::remove_dir_all(path) } else { fs::remove_file(path) };
        self.settle(removed);
    }

    /// 사용자가 창에 끌어다 놓은 파일들을 지금 폴더에 올린다 (직접 컴파일한 .wasm도 이렇게 넣는다).
    fn take_files(&mut self, refused: usize) {
        let inbox = webos::gui::handoff_dir();
        let mut handed: Vec<String> = fs::read_dir(&inbox).map(|list| list.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        handed.sort();
        let mut result = Ok(());
        for file in handed {
            // 이름은 "순번-원래 이름"이다.
            let name = file.split_once('-').map_or(file.as_str(), |(_, name)| name);
            let from = inbox.join(&file);
            let copied = fs::copy(&from, join(&self.cwd, name)).map(|_| ());
            let _ = fs::remove_file(&from);
            result = result.and(copied);
        }
        self.settle(result);
        if refused > 0 {
            self.error = "너무 큰 파일은 올리지 않았습니다 (20MB까지).".to_string();
        }
    }

    // ───────────── 화면 ─────────────

    fn list_rect(&self) -> Rect {
        let top = BAR_H + if self.choosing_type { BAR_H } else { 0.0 };
        Rect::new(0.0, top, self.w, (self.h - STATUS_H - top).max(0.0))
    }

    fn max_scroll(&self) -> f32 {
        (self.entries.len() as f32 * ROW_H + 12.0 - self.list_rect().h).max(0.0)
    }

    fn draw(&mut self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let mut ui: Ui<Action> = Ui::new(self.window, std::mem::take(&mut self.widths), theme, self.mouse);
        let focus = self.focus_rename.take();
        ui.f.clear(theme.surface);
        self.draw_list(&mut ui, focus);
        self.draw_bars(&mut ui);
        self.draw_status(&mut ui);

        // 창의 제목은 보고 있는 폴더의 이름이다.
        let title = if self.cwd == "/" { "/" } else { base(&self.cwd) };
        if title != self.titled {
            ui.f.title(title);
            self.titled = title.to_string();
        }
        if let Some(stem) = focus {
            ui.f.select(RENAME, 0, stem);
        }
        if let Some(text) = self.copying.take() {
            ui.f.copy(&text);
        }
        if let Some(path) = self.launching.take() {
            ui.f.launch(&path);
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

    /// 위쪽의 막대: 위 폴더로, 현재 위치, 새 폴더, 새 파일. 그리고 새 파일의 형식을 고르는 막대.
    fn draw_bars(&self, ui: &mut Ui<Action>) {
        let theme = ui.theme;
        ui.f.rect(0.0, 0.0, self.w, BAR_H - 1.0, 0.0, theme.surface);
        ui.hline(0.0, BAR_H - 1.0, self.w);

        // 위 폴더로
        let up = Rect::new(8.0, 6.0, 26.0, TOOL_H);
        let at_root = self.cwd == "/";
        let fade = |c: webos::gui::Color| if at_root { c.alpha((c.0 & 0xff) as u8 / 2) } else { c };
        let hot = !at_root && ui.hot(up);
        if hot {
            ui.f.rect(up.x, up.y, up.w, up.h, RADIUS, theme.hover);
        }
        ui.f.frame(up.x, up.y, up.w, up.h, RADIUS, fade(if hot { theme.line_strong } else { theme.line }), 1.0);
        ui.icon(up.x + 5.0, up.y + 5.0, 0.8, fade(theme.text), ui::UP);
        if at_root {
            ui.f.region(up.x, up.y, up.w, up.h, Role::Button, false, true, "위 폴더로");
        } else {
            ui.target(up, Role::Button, false, "위 폴더로", Action::Go(parent(&self.cwd)));
        }

        // 오른쪽 끝의 단추들
        let file = ui.tool_width("새 파일");
        let folder = ui.tool_width("새 폴더");
        ui.tool(self.w - 8.0 - file, 6.0, "새 파일", Tool::Plain, self.choosing_type, Some(Action::ToggleTypes));
        ui.tool(self.w - 14.0 - file - folder, 6.0, "새 폴더", Tool::Plain, false, Some(Action::NewFolder));

        // 현재 위치: 폴더마다 눌러 갈 수 있다. 넘치면 뒤쪽(지금 폴더)이 보이게 한다.
        let room = Rect::new(40.0, 0.0, (self.w - 60.0 - file - folder - 40.0).max(0.0), BAR_H - 1.0);
        let mut crumbs: Vec<(String, String)> = vec![("/".to_string(), "/".to_string())];
        for part in self.cwd.split('/').filter(|p| !p.is_empty()) {
            let path = join(&crumbs.last().expect("never empty").1, part);
            crumbs.push((part.to_string(), path));
        }
        let widths: Vec<f32> = crumbs.iter().map(|(name, _)| ui.width(name, 12.5, Style::MONO) + 12.0).collect();
        let total: f32 = widths.iter().sum::<f32>() + (crumbs.len() - 1) as f32 * 16.0;
        let mut x = room.x - (total - room.w).max(0.0);
        ui.clip(room);
        let last = crumbs.len() - 1;
        for (i, ((name, path), w)) in crumbs.iter().zip(widths).enumerate() {
            if i > 0 {
                ui.text(x + 2.0, BAR_H / 2.0 - 0.5, 12.5, theme.muted, Style::MONO, "›");
                x += 16.0;
            }
            let rect = Rect::new(x, 9.0, w, 20.0);
            let hot = ui.hot(rect);
            if hot {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            ui.text(x + 6.0, rect.mid_y(), 12.5, if i == last || hot { theme.text } else { theme.muted }, Style::MONO, name);
            ui.target(rect, Role::Link, i == last, name, Action::Go(path.clone()));
            x += w;
        }
        ui.unclip();

        if self.choosing_type {
            ui.f.rect(0.0, BAR_H, self.w, BAR_H - 1.0, 0.0, theme.surface2);
            ui.hline(0.0, BAR_H * 2.0 - 1.0, self.w);
            let mut x = 8.0;
            for (i, (name, ext, _)) in FILE_TYPES.iter().enumerate() {
                // 이름과, 그 옆에 흐린 고정폭의 확장자
                let (name_w, ext_w) = (ui.width(name, 12.0, Style::PLAIN), ui.width(ext, 12.0, Style::MONO));
                let rect = Rect::new(x, BAR_H + 6.0, (name_w + ext_w + 24.0).ceil(), TOOL_H);
                let hot = ui.hot(rect);
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.surface);
                if hot {
                    ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
                }
                ui.f.frame(rect.x, rect.y, rect.w, rect.h, RADIUS, if hot { theme.line_strong } else { theme.line }, 1.0);
                ui.text(rect.x + 10.0, rect.mid_y(), 12.0, theme.text, Style::PLAIN, name);
                ui.text(rect.x + 14.0 + name_w, rect.mid_y(), 12.0, theme.muted, Style::MONO, ext);
                ui.target(rect, Role::Button, false, &format!("{name} {ext}"), Action::NewFile(i));
                x += rect.w + 6.0;
            }
        }
    }

    fn draw_list(&self, ui: &mut Ui<Action>, focus: Option<usize>) {
        let theme = ui.theme;
        let area = self.list_rect();
        let scroll = self.scroll.min(self.max_scroll());
        ui.clip(area);
        ui.hit(area, Action::Blank);
        if self.entries.is_empty() {
            let hint = "비어 있는 폴더입니다. 파일을 끌어다 놓으면 여기에 올라갑니다.";
            ui.f.styled(area.x + area.w / 2.0, area.y + 44.0, 13.0, theme.muted, Align::Center, Style::PLAIN, hint);
        }
        for (i, entry) in self.entries.iter().enumerate() {
            let rect = Rect::new(6.0, area.y + 6.0 + i as f32 * ROW_H - scroll, area.w - 12.0, ROW_H);
            if rect.bottom() < area.y || rect.y > area.bottom() {
                continue; // 보이는 줄만 그린다
            }
            let selected = self.selected.as_ref() == Some(&entry.name);
            if selected {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.accent_soft);
            } else if ui.hot(rect) {
                ui.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.hover);
            }
            let (icon, color) = if entry.dir { (ui::FOLDER, theme.accent) } else { (ui::FILE, theme.muted) };
            ui.icon(rect.x + 8.0, rect.y + 4.0, 1.0, color, icon);
            let size = if entry.dir { format!("항목 {}개", entry.size) } else { format_size(entry.size) };
            let size_w = ui.width(&size, 12.0, Style::PLAIN);
            ui.f.styled(rect.right() - 8.0, rect.mid_y(), 12.0, theme.muted, Align::Right, Style::PLAIN, &size);
            let name_x = rect.x + 36.0;
            let room = rect.right() - 16.0 - size_w - name_x;
            if self.renaming.as_ref() == Some(&entry.name) {
                let edit = Rect::new(name_x - 7.0, rect.y + 2.0, (room + 7.0).max(40.0), 24.0);
                ui.field_box(edit, true);
                ui.f.field(&Field {
                    id: RENAME,
                    x: edit.x + 7.0,
                    y: edit.y + 1.5,
                    w: (edit.w - 14.0).max(4.0),
                    h: edit.h - 3.0,
                    size: 13.0,
                    color: theme.text,
                    background: theme.surface,
                    multiline: false,
                    mono: false,
                    bold: false,
                    focus: focus.is_some(),
                    select: false,
                    keys: false,
                    grab_enter: false,
                    locate: false,
                    label: "새 이름",
                    placeholder: "",
                });
                continue;
            }
            ui.label(name_x, rect.mid_y(), 13.0, theme.text, Style::PLAIN, room, &entry.name);
            ui.target(rect, Role::Option, selected, &entry.name, Action::Select(entry.name.clone()));
        }
        let total = self.entries.len() as f32 * ROW_H + 12.0;
        if total > area.h && area.h > 0.0 {
            let thumb = (area.h * area.h / total).max(24.0);
            let top = area.y + (area.h - thumb) * scroll / (total - area.h);
            ui.f.rect(area.right() - 5.0, top, 3.0, thumb, 1.5, theme.line_strong);
        }
        ui.unclip();
    }

    /// 아래의 상태 줄: 오류, 항목의 수, 또는 고른 항목과 그것으로 할 수 있는 일
    fn draw_status(&self, ui: &mut Ui<Action>) {
        let theme = ui.theme;
        let y = self.h - STATUS_H;
        ui.f.rect(0.0, y, self.w, STATUS_H, 0.0, theme.surface);
        ui.hline(0.0, y, self.w);
        let mid = y + STATUS_H / 2.0;
        // 상태 줄의 글은 화면 낭독기도 읽을 수 있게 알린다.
        let say = |ui: &mut Ui<Action>, role: Role, room: f32, text: &str| ui.f.region(8.0, y + 6.0, room.max(1.0), STATUS_H - 12.0, role, false, false, text);
        if !self.error.is_empty() {
            say(ui, Role::Alert, self.w - 16.0, &self.error);
            return ui.label(8.0, mid, 12.0, theme.danger, Style::PLAIN, self.w - 16.0, &self.error);
        }
        let Some(entry) = self.current() else {
            let count = format!("항목 {}개", self.entries.len());
            say(ui, Role::Status, self.w - 16.0, &count);
            return ui.text(8.0, mid, 12.0, theme.muted, Style::PLAIN, &count);
        };
        let by = y + (STATUS_H - TOOL_H) / 2.0;
        if self.confirming {
            let (cancel, remove) = (ui.tool_width("취소"), ui.tool_width("지우기"));
            ui.tool(self.w - 8.0 - cancel, by, "취소", Tool::Plain, false, Some(Action::CancelDelete));
            ui.tool(self.w - 14.0 - cancel - remove, by, "지우기", Tool::Danger, false, Some(Action::Delete));
            let inside = if entry.dir && entry.size > 0 { format!("과 그 안의 항목 {}개", entry.size) } else { String::new() };
            let question = format!("“{}”{inside}을(를) 지울까요?", entry.name);
            say(ui, Role::Status, self.w - 36.0 - cancel - remove, &question);
            return ui.label(8.0, mid, 12.0, theme.muted, Style::PLAIN, self.w - 36.0 - cancel - remove, &question);
        }
        let (remove, rename) = (ui.tool_width("삭제"), ui.tool_width("이름 바꾸기"));
        ui.tool(self.w - 8.0 - remove, by, "삭제", Tool::Plain, false, Some(Action::AskDelete));
        ui.tool(self.w - 14.0 - remove - rename, by, "이름 바꾸기", Tool::Plain, false, Some(Action::Rename(entry.name.clone())));
        say(ui, Role::Status, self.w - 36.0 - remove - rename, &entry.name);
        ui.label(8.0, mid, 12.0, theme.muted, Style::PLAIN, self.w - 36.0 - remove - rename, &entry.name);
    }

    // ───────────── 입력 ─────────────

    fn hit_at(&self, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at?;
        self.hits.iter().rposition(|(rect, _)| rect.contains(at))
    }

    fn perform(&mut self, action: Action, clicks: i32) {
        match action {
            Action::Go(path) => self.go(&path),
            Action::NewFolder => {
                let name = self.fresh_name("새 폴더", "");
                self.create(name, |path| fs::create_dir(path));
            }
            Action::ToggleTypes => self.choosing_type = !self.choosing_type,
            Action::NewFile(i) => {
                self.choosing_type = false;
                let (_, ext, content) = FILE_TYPES[i];
                let name = self.fresh_name("새 파일", ext);
                self.create(name, |path| fs::write(path, content));
            }
            Action::Select(name) => {
                // 이름을 고치던 중이면 그것부터 마무리한다.
                self.commit_rename();
                if clicks >= 2 {
                    self.open(&name);
                } else {
                    self.select(Some(name));
                }
            }
            Action::Blank => {
                self.commit_rename();
                self.select(None);
            }
            Action::Open(name) => self.open(&name),
            Action::Rename(name) => self.start_rename(&name),
            Action::AskDelete => self.confirming = self.selected.is_some(),
            Action::Delete => self.remove(),
            Action::CancelDelete => self.confirming = false,
            Action::Copy(text) => self.copying = Some(text),
        }
    }

    /// 우클릭한 자리에 맞는 메뉴
    fn context_menu(&mut self, action: Action, at: (f32, f32)) {
        let item = |label: &str, action: Action| (MenuItem::new(label), Some(action));
        let separator = || (MenuItem::separator(), None);
        let items = match action {
            Action::Select(name) => {
                // 우클릭한 항목이 선택된다 (메뉴가 무엇에 대한 것인지 보이도록).
                self.select(Some(name.clone()));
                let dir = self.entries.iter().any(|e| e.name == name && e.dir);
                vec![
                    item(if dir { "열기" } else { "편집기로 열기" }, Action::Open(name.clone())),
                    item("이름 바꾸기", Action::Rename(name.clone())),
                    item("경로 복사", Action::Copy(join(&self.cwd, &name))),
                    separator(),
                    (MenuItem::danger("삭제…"), Some(Action::AskDelete)),
                ]
            }
            Action::Blank => {
                let mut items = vec![item("새 폴더", Action::NewFolder)];
                items.extend(FILE_TYPES.iter().enumerate().map(|(i, (name, ext, _))| item(&format!("새 {name} 파일 ({ext})"), Action::NewFile(i))));
                items.push(separator());
                items.push((MenuItem::new("위 폴더로").disabled_if(self.cwd == "/"), Some(Action::Go(parent(&self.cwd)))));
                items.push(item("이 폴더의 경로 복사", Action::Copy(self.cwd.clone())));
                items
            }
            _ => return,
        };
        self.menu = Some((at, items));
    }

    fn move_selection(&mut self, step: isize) {
        if self.entries.is_empty() {
            return;
        }
        let at = self.entries.iter().position(|e| Some(&e.name) == self.selected.as_ref());
        let next = match at {
            Some(at) => at.saturating_add_signed(step).min(self.entries.len() - 1),
            None => 0,
        };
        self.select(Some(self.entries[next].name.clone()));
    }

    /// 입력 하나를 처리한다. 화면을 다시 그려야 하면 true.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Resize { w, h, dark } => {
                (self.w, self.h, self.dark) = (w, h, dark);
                self.scroll = self.scroll.min(self.max_scroll());
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
                    0 => self.perform(action, clicks),
                    2 => self.context_menu(action, (x, y)),
                    _ => return false,
                }
            }
            Event::Wheel { x, y, dy } if self.list_rect().contains((x, y)) => {
                let to = (self.scroll + dy).clamp(0.0, self.max_scroll());
                if to == self.scroll {
                    return false;
                }
                self.scroll = to;
            }
            Event::Input { field: RENAME } => self.rename_draft = self.window.text(RENAME).unwrap_or_default(),
            // 칸을 벗어나면 적어 둔 이름으로 바꾼다.
            Event::FieldFocus { field: RENAME, on: false } => self.commit_rename(),
            Event::Key { key, mods } if !mods.command() => {
                if self.renaming.is_some() {
                    match key {
                        Key::Enter => self.commit_rename(),
                        Key::Escape => self.renaming = None,
                        _ => return false,
                    }
                    return true;
                }
                match (key, self.selected.clone()) {
                    (Key::Down, _) => self.move_selection(1),
                    (Key::Up, _) => self.move_selection(-1),
                    (Key::Enter, Some(name)) => self.open(&name),
                    (Key::Delete | Key::Backspace, Some(_)) => self.confirming = true,
                    (Key::Escape, _) => self.confirming = false,
                    _ => return false,
                }
            }
            Event::Menu(chosen) => {
                let actions = std::mem::take(&mut self.menu_actions);
                match chosen.and_then(|i| actions.into_iter().nth(i).flatten()) {
                    Some(action) => self.perform(action, 1),
                    None => return false,
                }
            }
            Event::Files { refused, .. } => self.take_files(refused),
            Event::Focus(true) => return self.refresh(),
            Event::Close => process::exit(0),
            _ => return false,
        }
        true
    }
}

fn main() {
    webos::init();
    let (w, h) = (600, 420);
    let window = match Window::open("파일", w, h) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("files: cannot open a window: {}", webos::describe(&e));
            process::exit(1);
        }
    };
    // 실행할 때 폴더를 주면 거기서 시작한다: files /etc
    let start = env::args().nth(1).or_else(|| env::var("HOME").ok()).unwrap_or_else(|| "/".into());
    let start = if Path::new(&start).is_dir() { start.trim_end_matches('/').to_string() } else { "/".to_string() };
    let mut app = App {
        window,
        widths: Widths::default(),
        w: w as f32,
        h: h as f32,
        dark: false,
        cwd: if start.is_empty() { "/".to_string() } else { start },
        entries: Vec::new(),
        selected: None,
        renaming: None,
        rename_draft: String::new(),
        confirming: false,
        error: String::new(),
        choosing_type: false,
        scroll: 0.0,
        mouse: None,
        hits: Vec::new(),
        hot: None,
        menu: None,
        menu_actions: Vec::new(),
        focus_rename: None,
        copying: None,
        launching: None,
        titled: String::new(),
    };
    app.refresh();
    let frame = app.draw();
    let _ = app.window.present(&frame);
    loop {
        // 입력이 없어도 가끔 깨어나, 다른 프로그램(터미널 등)이 파일을 바꿨는지 본다.
        let mut redraw = match app.window.next_event_within(REFRESH_MS) {
            Some(event) => app.handle(event),
            None => app.renaming.is_none() && app.refresh(),
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
