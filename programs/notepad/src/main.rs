//! 메모장. 메모 보관함(~/notes)의 글 파일을 골라 고치는 작은 편집기다.
//!
//! 창의 목록, 단추, 상태 표시는 이 프로그램이 직접 그린다. 글을 치는 곳만은 화면 쪽의 실제 입력 칸을
//! 빌려 쓴다 (한글 조합, 선택, 복사·붙여넣기를 위해서). 칸의 내용은 시스템 콜로 주고받고,
//! 파일을 읽고 쓰는 것은 다른 프로그램과 똑같은 파일 시스템 콜이다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::{env, fs, io, process};
use webos::gui::{Align, Color, Event, Field, Frame, Key, Window};

const EDITOR: u32 = 1;
const BAR: f32 = 44.0;
const ROW: f32 = 30.0;
const PAD: f32 = 10.0;
const INSET: f32 = 18.0;
/// 마지막 입력 뒤 이만큼 조용하면 저장한다.
const SAVE_DELAY_MS: u32 = 500;
const NEW_LABEL: &str = "새 메모";

struct Theme {
    side: Color,
    page: Color,
    line: Color,
    text: Color,
    muted: Color,
    button: Color,
    selected: Color,
    danger: Color,
}

const LIGHT: Theme = Theme {
    side: Color::rgb(244, 245, 248),
    page: Color::rgb(255, 255, 255),
    line: Color::rgb(214, 216, 224),
    text: Color::rgb(25, 26, 32),
    muted: Color::rgb(107, 110, 123),
    button: Color::rgb(255, 255, 255),
    selected: Color::rgb(221, 225, 250),
    danger: Color::rgb(194, 51, 42),
};

const DARK: Theme = Theme {
    side: Color::rgb(30, 32, 38),
    page: Color::rgb(23, 24, 29),
    line: Color::rgb(58, 60, 70),
    text: Color::rgb(232, 232, 236),
    muted: Color::rgb(141, 144, 156),
    button: Color::rgb(44, 46, 54),
    selected: Color::rgb(50, 54, 92),
    danger: Color::rgb(255, 143, 133),
};

/// 글의 폭을 재되, 한 번 잰 것은 기억해 둔다 (잴 때마다 화면 쪽에 물어봐야 하므로).
struct Widths {
    known: HashMap<(String, u32, bool), f32>,
}

impl Widths {
    fn of(&mut self, window: &Window, texts: &[&str], size: f32, bold: bool) -> Vec<f32> {
        let key = |text: &str| (text.to_string(), size.to_bits(), bold);
        let unknown: Vec<&str> = texts.iter().copied().filter(|t| !self.known.contains_key(&key(t))).collect();
        for (text, width) in unknown.iter().zip(window.measure(&unknown, size, bold)) {
            self.known.insert(key(text), width);
        }
        texts.iter().map(|t| self.known[&key(t)]).collect()
    }
}

struct Notepad {
    window: Window,
    widths: Widths,
    w: f32,
    h: f32,
    dark: bool,
    dir: PathBuf,
    /// 보관함 기준의 경로들 (폴더 안의 것은 "폴더/이름")
    files: Vec<String>,
    current: Option<String>,
    /// 열어 둔 메모의 글 (입력 칸에 있는 것과 같다)
    text: String,
    /// 아직 저장하지 않은 변경이 있다.
    dirty: bool,
    /// 저장에 실패했을 때의 설명
    error: Option<String>,
    scroll: f32,
    /// 입력 칸이 방금 나타났다: 이번에 그릴 때 커서를 준다.
    focus_editor: bool,
}

fn is_note(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".txt")
}

/// 보관함의 글 파일들을 폴더 안까지 찾는다. 숨김 파일은 건너뛴다.
fn find_notes(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = format!("{prefix}{name}");
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => find_notes(&entry.path(), &format!("{path}/"), out),
            Ok(_) if is_note(&name) => out.push(path),
            _ => {}
        }
    }
}

impl Notepad {
    fn side(&self) -> f32 {
        if self.w < 520.0 {
            (self.w * 0.36).max(110.0)
        } else {
            210.0
        }
    }

    fn list_height(&self) -> f32 {
        (self.h - BAR).max(0.0)
    }

    fn max_scroll(&self) -> f32 {
        (self.files.len() as f32 * ROW - self.list_height()).max(0.0)
    }

    fn refresh(&mut self) {
        let mut files = Vec::new();
        find_notes(&self.dir, "", &mut files);
        files.sort_by_key(|f| f.to_lowercase());
        self.files = files;
        self.scroll = self.scroll.min(self.max_scroll());
    }

    /// 창이 다시 앞으로 왔을 때: 그사이 다른 프로그램이 파일을 바꿨을 수 있다.
    fn sync(&mut self) {
        self.refresh();
        let Some(name) = self.current.clone() else { return };
        if self.dirty {
            return; // 치고 있던 것이 더 새것이다
        }
        match fs::read_to_string(self.dir.join(&name)) {
            Ok(text) if text != self.text => {
                let _ = self.window.set_text(EDITOR, &text);
                self.text = text;
            }
            Ok(_) => {}
            Err(_) => self.current = None, // 지워졌다
        }
    }

    fn open(&mut self, name: &str) {
        self.save();
        match fs::read_to_string(self.dir.join(name)) {
            Ok(text) => {
                let _ = self.window.set_text(EDITOR, &text);
                self.text = text;
                self.current = Some(name.to_string());
                self.error = None;
                self.focus_editor = true;
            }
            Err(e) => self.error = Some(format!("열지 못했습니다: {}", webos::describe(&e))),
        }
    }

    fn create(&mut self) {
        self.save();
        let made = fs::create_dir_all(&self.dir).and_then(|_| {
            // "새 메모.md", "새 메모 2.md", … 중 아직 없는 첫 이름
            let name = (1..)
                .map(|n| if n == 1 { format!("{NEW_LABEL}.md") } else { format!("{NEW_LABEL} {n}.md") })
                .find(|name| !self.dir.join(name).exists())
                .expect("some name is free");
            fs::write(self.dir.join(&name), "").map(|_| name)
        });
        match made {
            Ok(name) => {
                self.refresh();
                self.open(&name);
            }
            Err(e) => self.error = Some(format!("만들지 못했습니다: {}", webos::describe(&e))),
        }
    }

    fn save(&mut self) {
        let Some(name) = &self.current else { return };
        if !self.dirty {
            return;
        }
        match fs::write(self.dir.join(name), &self.text) {
            Ok(()) => {
                self.dirty = false;
                self.error = None;
            }
            Err(e) => self.error = Some(format!("저장하지 못했습니다: {}", webos::describe(&e))),
        }
    }

    fn typed(&mut self) -> io::Result<()> {
        let text = self.window.text(EDITOR)?;
        if text != self.text {
            self.text = text;
            self.dirty = true;
        }
        Ok(())
    }

    /// 폭에 맞지 않는 이름은 뒤를 자르고 "…"를 붙인다.
    fn fitted(&mut self, names: &[&str], size: f32, room: f32) -> Vec<String> {
        let widths = self.widths.of(&self.window, names, size, false);
        names
            .iter()
            .zip(widths)
            .map(|(name, width)| {
                if width <= room {
                    return name.to_string();
                }
                let keep = ((name.chars().count() as f32 * room / width) as usize).saturating_sub(2).max(1);
                format!("{}…", name.chars().take(keep).collect::<String>())
            })
            .collect()
    }

    fn draw(&mut self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let side = self.side();
        let mut f = Frame::new();
        f.clear(theme.page);

        // 왼쪽: 새 메모 단추와 메모 목록
        f.rect(0.0, 0.0, side, self.h, 0.0, theme.side);
        let button = self.widths.of(&self.window, &[NEW_LABEL], 13.0, false)[0] + 24.0;
        f.rect(PAD, 8.0, button, BAR - 16.0, 6.0, theme.button);
        f.frame(PAD, 8.0, button, BAR - 16.0, 6.0, theme.line, 1.0);
        f.text(PAD + button / 2.0, BAR / 2.0, 13.0, theme.text, Align::Center, false, NEW_LABEL);

        f.clip(0.0, BAR, side, self.list_height());
        if self.files.is_empty() {
            f.text(PAD + 4.0, BAR + ROW / 2.0, 12.5, theme.muted, Align::Left, false, "메모가 없습니다");
        }
        // 보이는 줄만 그린다.
        let first = (self.scroll / ROW) as usize;
        let last = (((self.scroll + self.list_height()) / ROW) as usize + 1).min(self.files.len());
        let shown: Vec<String> = self.files[first.min(last)..last].iter().map(|name| display_name(name)).collect();
        let labels = self.fitted(&shown.iter().map(String::as_str).collect::<Vec<_>>(), 13.0, side - PAD * 2.0 - 12.0);
        for (i, label) in labels.iter().enumerate() {
            let index = first + i;
            let y = BAR + index as f32 * ROW - self.scroll;
            let selected = self.current.as_deref() == Some(self.files[index].as_str());
            if selected {
                f.rect(6.0, y + 1.0, side - 12.0, ROW - 2.0, 6.0, theme.selected);
            }
            f.text(PAD + 6.0, y + ROW / 2.0, 13.0, theme.text, Align::Left, selected, label);
        }
        f.unclip();
        f.rect(side - 1.0, 0.0, 1.0, self.h, 0.0, theme.line);

        // 오른쪽: 제목 줄과 글 입력 칸
        let (x, room) = (side + INSET, self.w - side - INSET * 2.0);
        match self.current.clone() {
            None => {
                let hint = self.error.clone().unwrap_or_else(|| "왼쪽에서 메모를 고르거나 새 메모를 만드세요".into());
                f.text(side + (self.w - side) / 2.0, self.h / 2.0, 13.0, theme.muted, Align::Center, false, &hint);
            }
            Some(name) => {
                let (state, color) = match (&self.error, self.dirty) {
                    (Some(error), _) => (error.clone(), theme.danger),
                    (None, true) => ("저장 중…".to_string(), theme.muted),
                    (None, false) => ("저장됨".to_string(), theme.muted),
                };
                let state_width = self.widths.of(&self.window, &[&state], 12.0, false)[0];
                let shown = display_name(&name);
                let title = self.fitted(&[&shown], 15.0, (room - state_width - 16.0).max(40.0)).remove(0);
                f.text(x, BAR / 2.0, 15.0, theme.text, Align::Left, true, &title);
                f.text(self.w - INSET, BAR / 2.0, 12.0, color, Align::Right, false, &state);
                f.rect(side, BAR - 1.0, self.w - side, 1.0, 0.0, theme.line);
                f.field(&Field {
                    id: EDITOR,
                    x,
                    y: BAR + 12.0,
                    w: room.max(20.0),
                    h: (self.h - BAR - 24.0).max(20.0),
                    size: 14.0,
                    color: theme.text,
                    background: theme.page,
                    multiline: true,
                    mono: false,
                    focus: std::mem::take(&mut self.focus_editor),
                    label: "메모 내용",
                });
            }
        }
        f
    }

    /// 입력 하나를 처리한다. 화면을 다시 그려야 하면 true.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Resize { w, h, dark } => {
                (self.w, self.h, self.dark) = (w, h, dark);
                self.scroll = self.scroll.min(self.max_scroll());
            }
            Event::PointerDown { x, y, button: 0 } if x < self.side() => {
                if y < BAR {
                    let button = self.widths.of(&self.window, &[NEW_LABEL], 13.0, false)[0] + 24.0;
                    if x >= PAD && x < PAD + button {
                        self.create();
                    }
                } else if let Some(name) = self.files.get(((y - BAR + self.scroll) / ROW) as usize).cloned() {
                    if self.current.as_deref() != Some(name.as_str()) {
                        self.open(&name);
                    }
                }
            }
            Event::Wheel { x, dy, .. } if x < self.side() => {
                let to = (self.scroll + dy).clamp(0.0, self.max_scroll());
                if to == self.scroll {
                    return false;
                }
                self.scroll = to;
            }
            Event::Input { field: EDITOR } => {
                if let Err(e) = self.typed() {
                    self.error = Some(format!("글을 읽지 못했습니다: {}", webos::describe(&e)));
                }
            }
            Event::Key { key: Key::Char(c), mods } if mods.command() && c.eq_ignore_ascii_case(&'s') => self.save(),
            Event::Focus(true) => self.sync(),
            // 다른 창으로 넘어가면 기다리지 않고 바로 저장한다 (곧바로 다른 프로그램이 이 파일을 읽을 수 있다).
            Event::Focus(false) => self.save(),
            Event::Close => {
                self.save();
                process::exit(0);
            }
            _ => return false,
        }
        true
    }
}

/// 목록과 제목에 보이는 이름: .md는 떼고, 다른 확장자는 둔다.
fn display_name(path: &str) -> String {
    path.strip_suffix(".md").unwrap_or(path).to_string()
}

fn main() {
    webos::init();
    let window = match Window::open("메모장", 760, 500) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("notepad: cannot open a window: {}", webos::describe(&e));
            process::exit(1);
        }
    };
    let home = env::var("HOME").unwrap_or_else(|_| "/home/guest".into());
    let mut app = Notepad {
        window,
        widths: Widths { known: HashMap::new() },
        w: 760.0,
        h: 500.0,
        dark: false,
        dir: Path::new(&home).join("notes"),
        files: Vec::new(),
        current: None,
        text: String::new(),
        dirty: false,
        error: None,
        scroll: 0.0,
        focus_editor: false,
    };
    app.refresh();
    // 실행할 때 파일 이름을 주면 그것을 연다: notepad 장보기.md
    if let Some(name) = env::args().nth(1) {
        app.open(&name);
    }
    let frame = app.draw();
    let _ = app.window.present(&frame);
    loop {
        // 저장할 것이 있으면 입력이 잠시 멈추기를 기다렸다가 저장한다.
        let event = if app.dirty && app.error.is_none() { app.window.next_event_within(SAVE_DELAY_MS) } else { app.window.next_event() };
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
