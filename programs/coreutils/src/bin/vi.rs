//! 터미널에서 도는 모드형 텍스트 편집기.
//!
//! 일반 모드에서 이동하고 명령을 내리며, 입력 모드에서 글자를 넣는다.
//! 지원: h j k l 0 $ w b gg G, i a I A o O, x dd yy p u, /검색 n, :w :q :q! :wq :숫자

use std::fs;
use std::io::IsTerminal;
use webos::term::{self, Key, Keys, Screen};

const TAB_STOP: usize = 4;
const UNDO_LIMIT: usize = 100;

#[derive(PartialEq)]
enum Mode {
    Normal,
    Insert,
    /// 맨 아랫줄에서 `:` 명령이나 `/` 검색어를 입력하는 중
    Prompt { prefix: char, text: String },
}

struct Editor {
    lines: Vec<Vec<char>>,
    /// 커서 위치 (줄 안에서는 글자 순번)
    cx: usize,
    cy: usize,
    /// 화면 왼쪽 위에 보이는 줄과 칸
    top: usize,
    left: usize,
    mode: Mode,
    path: Option<String>,
    dirty: bool,
    message: String,
    /// dd, yy, gg 처럼 두 글자로 된 명령의 첫 글자
    pending: Option<char>,
    yanked: Option<Vec<char>>,
    undo: Vec<(Vec<Vec<char>>, usize, usize)>,
    search: String,
    quit: bool,
}

/// 줄의 앞 `upto`글자가 화면에서 차지하는 칸 수. 탭은 다음 탭 위치까지 늘어난다.
fn display_col(line: &[char], upto: usize) -> usize {
    let mut col = 0;
    for &c in &line[..upto.min(line.len())] {
        col += if c == '\t' { TAB_STOP - col % TAB_STOP } else { webos::char_width(c) };
    }
    col
}

/// 줄에서 화면 칸 [left, left + cols) 에 해당하는 부분을 정확히 cols칸으로 그린다.
fn render_line(line: &[char], left: usize, cols: usize) -> String {
    let mut out = String::new();
    let mut col = 0;
    let end = left + cols;
    for &c in line {
        let width = if c == '\t' { TAB_STOP - col % TAB_STOP } else { webos::char_width(c) };
        let (from, to) = (col, col + width);
        col = to;
        if to <= left {
            continue;
        }
        if from >= end {
            break;
        }
        if c == '\t' || from < left || to > end {
            // 탭이거나, 2칸 글자가 화면 가장자리에 걸린 경우: 보이는 칸만큼 공백으로 채운다.
            out.extend(std::iter::repeat(' ').take(to.min(end) - from.max(left)));
        } else {
            out.push(c);
        }
    }
    let used = col.min(end).saturating_sub(left);
    out.extend(std::iter::repeat(' ').take(cols - used.min(cols)));
    out
}

impl Editor {
    fn open(path: Option<String>) -> Editor {
        let mut message = String::new();
        let lines = match &path {
            Some(p) => match fs::read_to_string(p) {
                Ok(text) => {
                    let lines: Vec<Vec<char>> = text.lines().map(|l| l.chars().collect()).collect();
                    message = format!("\"{p}\" {}줄", lines.len());
                    lines
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    message = format!("\"{p}\" [새 파일]");
                    Vec::new()
                }
                Err(e) => {
                    message = format!("\"{p}\" 을(를) 열 수 없습니다: {}", webos::describe(&e));
                    Vec::new()
                }
            },
            None => Vec::new(),
        };
        Editor {
            lines: if lines.is_empty() { vec![Vec::new()] } else { lines },
            cx: 0,
            cy: 0,
            top: 0,
            left: 0,
            mode: Mode::Normal,
            path,
            dirty: false,
            message,
            pending: None,
            yanked: None,
            undo: Vec::new(),
            search: String::new(),
            quit: false,
        }
    }

    fn line(&self) -> &Vec<char> {
        &self.lines[self.cy]
    }

    /// 커서가 있을 수 있는 마지막 위치. 일반 모드에서는 마지막 글자 위, 입력 모드에서는 그 뒤까지다.
    fn max_cx(&self) -> usize {
        let len = self.line().len();
        if self.mode == Mode::Insert {
            len
        } else {
            len.saturating_sub(1)
        }
    }

    fn clamp(&mut self) {
        self.cy = self.cy.min(self.lines.len() - 1);
        self.cx = self.cx.min(self.max_cx());
    }

    /// 내용을 바꾸기 직전에 부른다. 되돌리기(u)로 이 시점에 돌아올 수 있다.
    fn checkpoint(&mut self) {
        if self.undo.len() == UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.undo.push((self.lines.clone(), self.cx, self.cy));
        self.dirty = true;
    }

    // ───────────── 화면 ─────────────

    fn draw(&mut self) {
        let (cols, rows) = webos::window_size();
        let body = rows.saturating_sub(2).max(1);

        // 커서가 화면 안에 들어오도록 보이는 범위를 옮긴다.
        if self.cy < self.top {
            self.top = self.cy;
        } else if self.cy >= self.top + body {
            self.top = self.cy + 1 - body;
        }
        let cursor_col = display_col(self.line(), self.cx);
        if cursor_col < self.left {
            self.left = cursor_col;
        } else if cursor_col >= self.left + cols {
            self.left = cursor_col + 1 - cols;
        }

        let mut out = String::from("\x1b[?25l\x1b[H");
        for row in 0..body {
            match self.lines.get(self.top + row) {
                Some(line) => out.push_str(&render_line(line, self.left, cols)),
                // 파일 끝을 지난 줄
                None => out.push_str(&format!("\x1b[90m{}\x1b[0m", term::fit("~", cols))),
            }
            out.push_str("\r\n");
        }

        let name = self.path.as_deref().unwrap_or("[이름 없음]");
        let left = format!(" {name}{}", if self.dirty { " [+]" } else { "" });
        let right = format!("{}:{}  {}줄 ", self.cy + 1, self.cx + 1, self.lines.len());
        let gap = cols.saturating_sub(term::width(&left) + term::width(&right));
        let status = format!("{left}{}{right}", " ".repeat(gap));
        out.push_str(&format!("\x1b[7m{}\x1b[0m\r\n", term::fit(&status, cols)));

        let (bottom, cursor) = match &self.mode {
            Mode::Prompt { prefix, text } => {
                let shown = format!("{prefix}{text}");
                let col = term::width(&shown);
                (shown, Some((rows - 1, col)))
            }
            Mode::Insert => ("-- 입력 --".to_string(), None),
            Mode::Normal => (self.message.clone(), None),
        };
        // 마지막 줄에는 줄바꿈을 붙이지 않는다 (화면이 한 줄 밀려 올라간다).
        out.push_str(&term::fit(&bottom, cols));

        let (row, col) = cursor.unwrap_or((self.cy - self.top, cursor_col - self.left));
        out.push_str(&format!("\x1b[{};{}H\x1b[?25h", row + 1, col.min(cols - 1) + 1));
        term::print(&out);
    }

    // ───────────── 키 처리 ─────────────

    fn handle(&mut self, key: Key) {
        match self.mode {
            Mode::Normal => self.normal(key),
            Mode::Insert => self.insert(key),
            Mode::Prompt { .. } => self.prompt(key),
        }
        self.clamp();
    }

    fn normal(&mut self, key: Key) {
        self.message.clear();
        let pending = self.pending.take();
        let page = webos::window_size().1.saturating_sub(3).max(1);
        match (pending, key) {
            // 이동
            (_, Key::Left | Key::Char('h') | Key::Backspace) => self.cx = self.cx.saturating_sub(1),
            (_, Key::Right | Key::Char('l' | ' ')) => self.cx += 1,
            (_, Key::Up | Key::Char('k')) => self.cy = self.cy.saturating_sub(1),
            (_, Key::Down | Key::Char('j') | Key::Enter) => self.cy += 1,
            (_, Key::Home | Key::Char('0')) => self.cx = 0,
            (_, Key::End | Key::Char('$')) => self.cx = usize::MAX,
            (_, Key::PageDown | Key::Ctrl('f')) => self.cy += page,
            (_, Key::PageUp | Key::Ctrl('b')) => self.cy = self.cy.saturating_sub(page),
            (_, Key::Char('w')) => self.word_forward(),
            (_, Key::Char('b')) => self.word_back(),
            (Some('g'), Key::Char('g')) => (self.cy, self.cx) = (0, 0),
            (_, Key::Char('G')) => (self.cy, self.cx) = (self.lines.len() - 1, 0),

            // 입력 모드로
            (_, Key::Char('i')) => self.start_insert(self.cx),
            (_, Key::Char('a')) => self.start_insert(self.cx + 1),
            (_, Key::Char('I')) => self.start_insert(0),
            (_, Key::Char('A')) => self.start_insert(usize::MAX),
            (_, Key::Char('o')) => self.open_line(self.cy + 1),
            (_, Key::Char('O')) => self.open_line(self.cy),

            // 고치기
            (_, Key::Char('x') | Key::Delete) => {
                if !self.line().is_empty() {
                    self.checkpoint();
                    let cx = self.cx;
                    self.lines[self.cy].remove(cx);
                }
            }
            (Some('d'), Key::Char('d')) => {
                self.checkpoint();
                let removed = self.lines.remove(self.cy);
                self.yanked = Some(removed);
                if self.lines.is_empty() {
                    self.lines.push(Vec::new());
                }
            }
            (Some('y'), Key::Char('y')) => {
                self.yanked = Some(self.line().clone());
                self.message = "1줄 복사".to_string();
            }
            (_, Key::Char('p')) => {
                if let Some(line) = self.yanked.clone() {
                    self.checkpoint();
                    self.lines.insert(self.cy + 1, line);
                    (self.cy, self.cx) = (self.cy + 1, 0);
                }
            }
            (_, Key::Char('u')) => match self.undo.pop() {
                Some((lines, cx, cy)) => {
                    (self.lines, self.cx, self.cy) = (lines, cx, cy);
                    self.message = "되돌렸습니다".to_string();
                }
                None => self.message = "더 되돌릴 것이 없습니다".to_string(),
            },

            // 검색과 명령
            (_, Key::Char(c @ (':' | '/'))) => self.mode = Mode::Prompt { prefix: c, text: String::new() },
            (_, Key::Char('n')) => self.find_next(),

            // 두 글자 명령의 첫 글자
            (None, Key::Char(c @ ('d' | 'y' | 'g'))) => self.pending = Some(c),
            _ => {}
        }
    }

    fn start_insert(&mut self, cx: usize) {
        self.checkpoint();
        self.mode = Mode::Insert;
        self.cx = cx.min(self.line().len());
    }

    fn open_line(&mut self, at: usize) {
        self.checkpoint();
        self.lines.insert(at, Vec::new());
        (self.cy, self.cx) = (at, 0);
        self.mode = Mode::Insert;
    }

    fn insert(&mut self, key: Key) {
        let (cx, cy) = (self.cx, self.cy);
        match key {
            Key::Esc | Key::Ctrl('c') => {
                self.mode = Mode::Normal;
                self.cx = cx.saturating_sub(1);
            }
            Key::Char(c) => {
                self.lines[cy].insert(cx, c);
                self.cx += 1;
            }
            Key::Tab => {
                self.lines[cy].insert(cx, '\t');
                self.cx += 1;
            }
            Key::Enter => {
                let rest = self.lines[cy].split_off(cx);
                self.lines.insert(cy + 1, rest);
                (self.cy, self.cx) = (cy + 1, 0);
            }
            Key::Backspace if cx > 0 => {
                self.lines[cy].remove(cx - 1);
                self.cx -= 1;
            }
            // 줄 처음에서 지우면 윗줄과 합친다.
            Key::Backspace if cy > 0 => {
                let line = self.lines.remove(cy);
                self.cy -= 1;
                self.cx = self.lines[self.cy].len();
                self.lines[self.cy].extend(line);
            }
            Key::Delete if cx < self.lines[cy].len() => {
                self.lines[cy].remove(cx);
            }
            Key::Left => self.cx = cx.saturating_sub(1),
            Key::Right => self.cx += 1,
            Key::Up => self.cy = cy.saturating_sub(1),
            Key::Down => self.cy += 1,
            Key::Home => self.cx = 0,
            Key::End => self.cx = usize::MAX,
            _ => {}
        }
    }

    fn prompt(&mut self, key: Key) {
        let Mode::Prompt { prefix, text } = &mut self.mode else {
            return;
        };
        let prefix = *prefix;
        match key {
            Key::Esc | Key::Ctrl('c') => self.mode = Mode::Normal,
            Key::Backspace => {
                // 내용을 다 지운 뒤 한 번 더 누르면 입력을 그만둔다.
                if text.pop().is_none() {
                    self.mode = Mode::Normal;
                }
            }
            Key::Char(c) => text.push(c),
            Key::Enter => {
                let text = std::mem::take(text);
                self.mode = Mode::Normal;
                if prefix == '/' {
                    if !text.is_empty() {
                        self.search = text;
                    }
                    self.find_next();
                } else {
                    self.command(text.trim());
                }
            }
            _ => {}
        }
    }

    fn command(&mut self, command: &str) {
        let (name, arg) = match command.split_once(' ') {
            Some((name, arg)) => (name, Some(arg.trim())),
            None => (command, None),
        };
        match name {
            "" => {}
            "w" => {
                self.save(arg);
            }
            "q" if self.dirty => self.message = "저장하지 않은 변경이 있습니다 (:q! 로 버리고 나가기)".to_string(),
            "q" | "q!" => self.quit = true,
            "wq" | "x" => self.quit = self.save(arg),
            _ => match name.parse::<usize>() {
                Ok(n) => (self.cy, self.cx) = (n.saturating_sub(1), 0),
                Err(_) => self.message = format!("모르는 명령입니다: {name}"),
            },
        }
    }

    /// 저장에 성공하면 true
    fn save(&mut self, path: Option<&str>) -> bool {
        let Some(path) = path.map(str::to_string).or(self.path.clone()) else {
            self.message = "파일 이름이 없습니다 (:w 이름)".to_string();
            return false;
        };
        let mut text = self.lines.iter().map(|l| l.iter().collect::<String>()).collect::<Vec<_>>().join("\n");
        text.push('\n');
        match fs::write(&path, &text) {
            Ok(()) => {
                self.message = format!("\"{path}\" {}줄, {}바이트 저장", self.lines.len(), text.len());
                self.path = Some(path);
                self.dirty = false;
                true
            }
            Err(e) => {
                self.message = format!("\"{path}\" 에 저장하지 못했습니다: {}", webos::describe(&e));
                false
            }
        }
    }

    // ───────────── 이동과 검색 ─────────────

    fn word_forward(&mut self) {
        let line = self.line();
        let mut i = self.cx;
        while i < line.len() && !line[i].is_whitespace() {
            i += 1;
        }
        while i < line.len() && line[i].is_whitespace() {
            i += 1;
        }
        if i < line.len() {
            self.cx = i;
        } else if self.cy + 1 < self.lines.len() {
            // 줄 끝이면 다음 줄의 첫 낱말로 간다.
            self.cy += 1;
            self.cx = self.line().iter().position(|c| !c.is_whitespace()).unwrap_or(0);
        }
    }

    fn word_back(&mut self) {
        if self.cx == 0 {
            if self.cy > 0 {
                self.cy -= 1;
                self.cx = self.line().len();
            } else {
                return;
            }
        }
        let line = self.line();
        let mut i = self.cx;
        while i > 0 && line[i - 1].is_whitespace() {
            i -= 1;
        }
        while i > 0 && !line[i - 1].is_whitespace() {
            i -= 1;
        }
        self.cx = i;
    }

    /// 커서 다음 위치부터 검색어를 찾는다. 끝까지 없으면 처음부터 다시 찾는다.
    fn find_next(&mut self) {
        if self.search.is_empty() {
            return;
        }
        let needle: Vec<char> = self.search.chars().collect();
        let find_in = |line: &[char], from: usize| {
            (from..line.len().saturating_sub(needle.len() - 1)).find(|&i| line[i..i + needle.len()] == needle[..])
        };
        let count = self.lines.len();
        for step in 0..=count {
            let y = (self.cy + step) % count;
            // 지금 줄은 커서 뒤부터, 한 바퀴 돌아온 마지막 차례에는 줄 처음부터 본다.
            let from = if step == 0 { self.cx + 1 } else { 0 };
            if let Some(x) = find_in(&self.lines[y], from) {
                if step > 0 && y <= self.cy {
                    self.message = "끝까지 찾아 처음부터 다시 찾았습니다".to_string();
                }
                (self.cy, self.cx) = (y, x);
                return;
            }
        }
        self.message = format!("찾을 수 없습니다: {}", self.search);
    }
}

fn main() {
    let args = coreutils::args();
    if !std::io::stdout().is_terminal() || !std::io::stdin().is_terminal() {
        eprintln!("vi: 터미널에서만 실행할 수 있습니다");
        std::process::exit(1);
    }
    let mut editor = Editor::open(args.into_iter().next());
    let Ok(_screen) = Screen::enter() else {
        eprintln!("vi: 터미널을 전체 화면으로 전환할 수 없습니다");
        std::process::exit(1);
    };
    let mut keys = Keys::new();
    while !editor.quit {
        editor.draw();
        match keys.read() {
            Some(key) => editor.handle(key),
            None => break,
        }
    }
}
