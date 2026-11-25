//! 줄 편집기. 터미널을 키 단위 입력 모드로 바꾸고 화면을 직접 그리면서
//! 커서 이동, 명령 이력, 탭 자동완성을 처리한다.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};

pub enum Input {
    Line(String),
    Eof,
}

enum Key {
    Char(char),
    Enter,
    Backspace,
    Delete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    Tab,
    CtrlC,
    CtrlD,
    KillToEnd,
    KillToStart,
    KillWord,
    ClearScreen,
    Ignored,
}

/// (단어, 명령어 자리인가) → 그 단어를 대체할 수 있는 후보들
pub type Completer<'a> = &'a dyn Fn(&str, bool) -> Vec<String>;

/// 이력 파일에서 불러오는 최대 줄 수
const HISTORY_LIMIT: usize = 500;

#[derive(Default)]
pub struct Editor {
    history: Vec<String>,
    /// 이력을 남기는 파일. 없으면 이번 세션 동안만 기억한다.
    history_file: Option<String>,
    /// 읽었지만 아직 처리하지 않은 입력 (붙여넣은 여러 줄 등)
    pending: VecDeque<u8>,
}

/// 화면에 그려진 편집 줄의 상태
struct View<'a> {
    prompt: &'a str,
    /// 마지막으로 그렸을 때 커서가 프롬프트 첫 줄에서 몇 줄 아래에 있었는가
    cursor_row: usize,
    /// 줄이 화면 끝에서 딱 끝나 커서가 이미 다음 줄 처음에 와 있는가
    on_fresh_row: bool,
}

impl Editor {
    /// 지난 세션의 이력을 파일에서 불러오고, 앞으로의 명령도 같은 파일에 남긴다.
    pub fn with_history(path: String) -> Self {
        let lines: Vec<String> = fs::read_to_string(&path)
            .map(|text| text.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())
            .unwrap_or_default();
        let skip = lines.len().saturating_sub(HISTORY_LIMIT);
        Editor { history: lines.into_iter().skip(skip).collect(), history_file: Some(path), ..Editor::default() }
    }

    fn remember(&mut self, line: &str) {
        if line.trim().is_empty() || self.history.last().map(String::as_str) == Some(line) {
            return;
        }
        self.history.push(line.to_string());
        if let Some(path) = &self.history_file {
            // 기록하지 못해도 셸 사용에는 지장이 없으므로 실패는 무시한다.
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{line}");
            }
        }
    }

    pub fn read_line(&mut self, prompt: &str, complete: Completer) -> Input {
        let _ = webos::set_raw(true);
        let result = self.edit(prompt, complete);
        let _ = webos::set_raw(false);
        if let Input::Line(line) = &result {
            self.remember(line);
        }
        result
    }

    fn edit(&mut self, prompt: &str, complete: Completer) -> Input {
        let mut buf: Vec<char> = Vec::new();
        let mut cur = 0;
        // 이력에서 보고 있는 위치. history.len() 이면 지금 작성 중인 줄이다.
        let mut at = self.history.len();
        let mut draft: Vec<char> = Vec::new();
        let mut view = View { prompt, cursor_row: 0, on_fresh_row: false };
        start_on_fresh_line();
        view.draw(&buf, cur);

        loop {
            let Some(key) = self.read_key() else {
                return Input::Eof;
            };
            match key {
                Key::Enter => {
                    view.draw(&buf, buf.len());
                    if !view.on_fresh_row {
                        emit("\n");
                    }
                    return Input::Line(buf.iter().collect());
                }
                Key::CtrlC => {
                    view.draw(&buf, buf.len());
                    emit("^C\n");
                    return Input::Line(String::new());
                }
                Key::CtrlD if buf.is_empty() => {
                    emit("\n");
                    return Input::Eof;
                }
                Key::CtrlD | Key::Delete => {
                    if cur < buf.len() {
                        buf.remove(cur);
                    }
                }
                Key::Char(c) => {
                    buf.insert(cur, c);
                    cur += 1;
                }
                Key::Backspace => {
                    if cur > 0 {
                        cur -= 1;
                        buf.remove(cur);
                    }
                }
                Key::Left => cur = cur.saturating_sub(1),
                Key::Right => cur = (cur + 1).min(buf.len()),
                Key::Home => cur = 0,
                Key::End => cur = buf.len(),
                Key::Up => {
                    if at > 0 {
                        if at == self.history.len() {
                            draft = buf.clone();
                        }
                        at -= 1;
                        buf = self.history[at].chars().collect();
                        cur = buf.len();
                    }
                }
                Key::Down => {
                    if at < self.history.len() {
                        at += 1;
                        buf = if at == self.history.len() { draft.clone() } else { self.history[at].chars().collect() };
                        cur = buf.len();
                    }
                }
                Key::KillToEnd => buf.truncate(cur),
                Key::KillToStart => {
                    buf.drain(..cur);
                    cur = 0;
                }
                Key::KillWord => {
                    let mut start = cur;
                    while start > 0 && buf[start - 1] == ' ' {
                        start -= 1;
                    }
                    while start > 0 && buf[start - 1] != ' ' {
                        start -= 1;
                    }
                    buf.drain(start..cur);
                    cur = start;
                }
                Key::ClearScreen => {
                    emit("\x1b[H\x1b[2J");
                    view.cursor_row = 0;
                }
                Key::Tab => {
                    if let Some(candidates) = apply_completion(&mut buf, &mut cur, complete) {
                        // 후보가 여럿이고 더 채울 글자가 없으면 목록을 보여 준다.
                        view.draw(&buf, buf.len());
                        let names: Vec<&str> = candidates.iter().map(|c| basename(c)).collect();
                        emit(&format!("\n{}\n", names.join("  ")));
                        view.cursor_row = 0;
                    }
                }
                Key::Ignored => continue,
            }
            view.draw(&buf, cur);
        }
    }

    // ───────────── 키 입력 ─────────────

    fn next_byte(&mut self) -> Option<u8> {
        if self.pending.is_empty() {
            let mut chunk = [0u8; 1024];
            match io::stdin().read(&mut chunk) {
                Ok(n) if n > 0 => self.pending.extend(&chunk[..n]),
                _ => return None,
            }
        }
        self.pending.pop_front()
    }

    fn read_key(&mut self) -> Option<Key> {
        let byte = self.next_byte()?;
        Some(match byte {
            b'\r' | b'\n' => Key::Enter,
            0x7f | 0x08 => Key::Backspace,
            b'\t' => Key::Tab,
            0x01 => Key::Home,
            0x02 => Key::Left,
            0x03 => Key::CtrlC,
            0x04 => Key::CtrlD,
            0x05 => Key::End,
            0x06 => Key::Right,
            0x0b => Key::KillToEnd,
            0x0c => Key::ClearScreen,
            0x0e => Key::Down,
            0x10 => Key::Up,
            0x15 => Key::KillToStart,
            0x17 => Key::KillWord,
            0x1b => self.read_escape(),
            b if b < 0x20 => Key::Ignored,
            b => {
                // UTF-8: 첫 바이트가 전체 길이를 알려 준다.
                let len = match b {
                    0xc0..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf7 => 4,
                    _ => 1,
                };
                let mut bytes = vec![b];
                for _ in 1..len {
                    bytes.push(self.next_byte()?);
                }
                match std::str::from_utf8(&bytes).ok().and_then(|s| s.chars().next()) {
                    Some(c) => Key::Char(c),
                    None => Key::Ignored,
                }
            }
        })
    }

    /// ESC 뒤에 오는 방향키 등의 시퀀스를 읽는다. 시퀀스는 한 번에 도착하므로,
    /// 뒤따르는 바이트가 없으면 Esc 키를 단독으로 누른 것이다.
    fn read_escape(&mut self) -> Key {
        if self.pending.is_empty() {
            return Key::Ignored;
        }
        match self.next_byte() {
            Some(b'[') | Some(b'O') => {}
            _ => return Key::Ignored,
        }
        let mut params = String::new();
        loop {
            match self.next_byte() {
                Some(b @ 0x40..=0x7e) => {
                    return match (params.as_str(), b) {
                        ("", b'A') => Key::Up,
                        ("", b'B') => Key::Down,
                        ("", b'C') => Key::Right,
                        ("", b'D') => Key::Left,
                        ("", b'H') | ("1", b'~') | ("7", b'~') => Key::Home,
                        ("", b'F') | ("4", b'~') | ("8", b'~') => Key::End,
                        ("3", b'~') => Key::Delete,
                        _ => Key::Ignored,
                    };
                }
                Some(b) => params.push(b as char),
                None => return Key::Ignored,
            }
        }
    }
}

impl View<'_> {
    /// 프롬프트와 편집 중인 줄을 다시 그리고 커서를 제자리에 둔다.
    /// 줄이 화면 폭을 넘어 여러 줄에 걸쳐도 맞도록, 터미널과 같은 규칙으로 위치를 계산한다.
    fn draw(&mut self, buf: &[char], cur: usize) {
        let (cols, _) = webos::window_size();
        let mut out = String::new();
        if self.cursor_row > 0 {
            out.push_str(&format!("\x1b[{}A", self.cursor_row));
        }
        out.push_str("\r\x1b[J");
        out.push_str(self.prompt);
        out.extend(buf.iter());

        let mut layout = Layout::new(cols);
        for c in visible_chars(self.prompt) {
            layout.put(c);
        }
        let mut target = None;
        for (i, &c) in buf.iter().enumerate() {
            if i == cur {
                target = Some(layout.next_position(c));
            }
            layout.put(c);
        }
        if layout.at_edge {
            // 줄이 화면 끝에서 딱 끝나면 커서가 다음 줄로 넘어가지 않으므로 직접 넘긴다.
            out.push('\n');
        }
        let end = layout.end_position();
        let (row, col) = target.unwrap_or(end);

        if end.0 > row {
            out.push_str(&format!("\x1b[{}A", end.0 - row));
        }
        out.push('\r');
        if col > 0 {
            out.push_str(&format!("\x1b[{col}C"));
        }
        self.cursor_row = row;
        self.on_fresh_row = layout.at_edge && target.is_none();
        emit(&out);
    }
}

/// 글자를 차례로 놓으면서 터미널의 줄바꿈을 흉내 낸다.
struct Layout {
    cols: usize,
    row: usize,
    col: usize,
    /// 마지막 칸까지 채운 상태. 터미널은 다음 글자가 올 때 줄을 넘긴다.
    at_edge: bool,
}

impl Layout {
    fn new(cols: usize) -> Self {
        Layout { cols, row: 0, col: 0, at_edge: false }
    }

    /// 다음 글자 c가 놓일 위치
    fn next_position(&self, c: char) -> (usize, usize) {
        if self.at_edge || self.col + webos::char_width(c) > self.cols {
            (self.row + 1, 0)
        } else {
            (self.row, self.col)
        }
    }

    fn put(&mut self, c: char) {
        let width = webos::char_width(c);
        if width == 0 {
            return;
        }
        (self.row, self.col) = self.next_position(c);
        self.col += width;
        self.at_edge = self.col >= self.cols;
        if self.at_edge {
            self.col = self.cols - 1;
        }
    }

    /// 모든 글자를 놓은 뒤의 커서 위치 (끝에 걸렸으면 다음 줄 처음)
    fn end_position(&self) -> (usize, usize) {
        if self.at_edge {
            (self.row + 1, 0)
        } else {
            (self.row, self.col)
        }
    }
}

/// 색상 지정 같은 이스케이프 시퀀스를 뺀, 실제로 칸을 차지하는 글자들
fn visible_chars(text: &str) -> impl Iterator<Item = char> + '_ {
    let mut in_escape = false;
    text.chars().filter(move |&c| {
        if in_escape {
            in_escape = !c.is_ascii_alphabetic();
            false
        } else {
            in_escape = c == '\x1b';
            !in_escape
        }
    })
}

/// 직전 명령의 출력이 줄바꿈 없이 끝났더라도 프롬프트가 그 출력을 덮어쓰지 않게 한다.
///
/// 커서 위치를 물어볼 수 없으므로, 표시 문자 하나와 (화면 폭 - 1)개의 공백을 찍는다.
/// 커서가 줄 처음에 있었다면 정확히 한 줄을 채우고 같은 줄에 머물러서, 줄 처음으로 돌아가 지우면 흔적이 없다.
/// 줄 중간에 있었다면 다음 줄로 넘어가므로, 이전 출력은 끝에 표시(%)가 붙은 채로 남는다.
fn start_on_fresh_line() {
    let (cols, _) = webos::window_size();
    // 전체 화면 프로그램이 뒷정리를 못 하고 끝났을(강제 종료 등) 때를 대비해
    // 먼저 터미널을 평소 상태로 되돌린다: 대체 화면에서 나오고, 커서를 보이고, 색을 지운다.
    const RESET: &str = "\x1b[?1049l\x1b[?25h\x1b[0m";
    emit(&format!("{RESET}\x1b[90m%\x1b[0m{}\r\x1b[K", " ".repeat(cols.saturating_sub(1))));
}

fn emit(text: &str) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

fn basename(path: &str) -> &str {
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    let start = trimmed.rfind('/').map_or(0, |i| i + 1);
    &path[start..]
}

/// 커서 앞의 단어를 자동완성한다. 후보가 여럿이고 더 채울 수 없으면 그 후보들을 돌려준다.
fn apply_completion(buf: &mut Vec<char>, cur: &mut usize, complete: Completer) -> Option<Vec<String>> {
    let mut start = *cur;
    while start > 0 && buf[start - 1] != ' ' {
        start -= 1;
    }
    let word: String = buf[start..*cur].iter().collect();
    let before: String = buf[..start].iter().collect();
    // 줄의 처음이거나 | ; & 바로 뒤라면 명령어 이름이 올 자리다.
    let command = matches!(before.trim_end().chars().last(), None | Some('|' | ';' | '&'));

    let candidates = complete(&word, command);
    let replacement = match candidates.as_slice() {
        [] => return None,
        [only] if only.ends_with('/') => only.clone(),
        [only] => format!("{only} "),
        many => common_prefix(many),
    };
    if replacement == word {
        return Some(candidates);
    }
    let new: Vec<char> = replacement.chars().collect();
    let len = new.len();
    buf.splice(start..*cur, new);
    *cur = start + len;
    None
}

fn common_prefix(words: &[String]) -> String {
    let first: Vec<char> = words[0].chars().collect();
    let mut len = first.len();
    for word in &words[1..] {
        len = len.min(first.iter().zip(word.chars()).take_while(|(a, b)| **a == *b).count());
    }
    first[..len].iter().collect()
}
