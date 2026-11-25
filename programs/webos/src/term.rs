//! 화면 전체를 쓰는 터미널 프로그램(편집기, 모니터)을 위한 도구:
//! 키 입력 해석, 대체 화면 전환, 화면 폭에 맞춘 글자 자르기.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::ManuallyDrop;
use std::os::fd::FromRawFd;

#[link(wasm_import_module = "webos")]
extern "C" {
    #[link_name = "poll_input"]
    fn sys_poll_input(fd: i32, timeout_ms: i32) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Key {
    Char(char),
    /// Ctrl과 함께 누른 글자 (소문자로)
    Ctrl(char),
    Enter,
    Esc,
    Backspace,
    Delete,
    Tab,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
}

/// read_timeout의 결과
pub enum Event {
    Key(Key),
    /// 제한 시간 동안 아무 키도 누르지 않았다
    Timeout,
    /// 입력이 끝났다 (터미널이 닫힘)
    Closed,
}

/// 터미널을 전체 화면 모드로 바꾼다: 키 단위 입력, 대체 화면, 커서 숨김.
/// 값이 사라질 때(프로그램이 정상 종료할 때) 원래대로 되돌린다.
pub struct Screen;

impl Screen {
    pub fn enter() -> io::Result<Screen> {
        crate::set_raw(true)?;
        print("\x1b[?1049h\x1b[?25l");
        Ok(Screen)
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        print("\x1b[0m\x1b[?25h\x1b[?1049l");
        let _ = crate::set_raw(false);
    }
}

/// 화면 한 장면을 한 번의 쓰기로 내보낸다.
///
/// 표준 출력은 줄 단위로 버퍼링하기 때문에, 그대로 쓰면 마지막 줄바꿈 앞뒤로 쓰기가 둘로 나뉜다.
/// 그러면 아랫줄과 커서가 아직 그려지지 않은 중간 상태가 잠깐 보이므로, 버퍼를 거치지 않고 직접 쓴다.
pub fn print(text: &str) {
    let _ = io::stdout().flush();
    let mut out = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    let _ = out.write_all(text.as_bytes());
}

/// 키 입력을 읽어 해석한다.
pub struct Keys {
    /// 표준 라이브러리의 입력 버퍼를 거치지 않는 표준 입력.
    /// 버퍼에 남은 바이트는 커널이 모르므로, 거쳐 읽으면 "읽을 것이 있는가"를 물을 때 답이 어긋난다.
    stdin: ManuallyDrop<File>,
    pending: VecDeque<u8>,
}

impl Default for Keys {
    fn default() -> Self {
        Keys::new()
    }
}

impl Keys {
    pub fn new() -> Keys {
        // fd 0은 프로세스가 끝날 때까지 열려 있어야 하므로 닫히지 않게 감싼다.
        Keys { stdin: ManuallyDrop::new(unsafe { File::from_raw_fd(0) }), pending: VecDeque::new() }
    }

    fn fill(&mut self) -> bool {
        let mut chunk = [0u8; 1024];
        match self.stdin.read(&mut chunk) {
            Ok(n) if n > 0 => {
                self.pending.extend(&chunk[..n]);
                true
            }
            _ => false,
        }
    }

    fn next_byte(&mut self) -> Option<u8> {
        if self.pending.is_empty() && !self.fill() {
            return None;
        }
        self.pending.pop_front()
    }

    /// 키 하나를 기다려 읽는다. 입력이 끝났으면 None.
    pub fn read(&mut self) -> Option<Key> {
        let byte = self.next_byte()?;
        Some(match byte {
            b'\r' | b'\n' => Key::Enter,
            0x7f | 0x08 => Key::Backspace,
            b'\t' => Key::Tab,
            0x1b => self.escape(),
            b @ 0x01..=0x1a => Key::Ctrl((b'a' + b - 1) as char),
            b if b < 0x20 => return self.read(),
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
                    None => return self.read(),
                }
            }
        })
    }

    /// 키를 기다리되, 제한 시간(밀리초)이 지나면 돌아온다. 주기적으로 화면을 갱신하는 프로그램이 쓴다.
    pub fn read_timeout(&mut self, timeout_ms: u32) -> Event {
        if self.pending.is_empty() && unsafe { sys_poll_input(0, timeout_ms as i32) } == 0 {
            return Event::Timeout;
        }
        match self.read() {
            Some(key) => Event::Key(key),
            None => Event::Closed,
        }
    }

    /// ESC 뒤에 오는 방향키 등의 시퀀스를 읽는다. 시퀀스는 한 번에 도착하므로,
    /// 뒤따르는 바이트가 없으면 Esc 키를 단독으로 누른 것이다.
    fn escape(&mut self) -> Key {
        if self.pending.is_empty() {
            return Key::Esc;
        }
        if !matches!(self.pending.front(), Some(b'[') | Some(b'O')) {
            return Key::Esc;
        }
        self.pending.pop_front();
        let mut params = String::new();
        while let Some(b) = self.next_byte() {
            if (0x40..=0x7e).contains(&b) {
                return match (params.as_str(), b) {
                    ("", b'A') => Key::Up,
                    ("", b'B') => Key::Down,
                    ("", b'C') => Key::Right,
                    ("", b'D') => Key::Left,
                    ("", b'H') | ("1", b'~') | ("7", b'~') => Key::Home,
                    ("", b'F') | ("4", b'~') | ("8", b'~') => Key::End,
                    ("3", b'~') => Key::Delete,
                    ("5", b'~') => Key::PageUp,
                    ("6", b'~') => Key::PageDown,
                    _ => Key::Esc,
                };
            }
            params.push(b as char);
        }
        Key::Esc
    }
}

/// 글자열이 화면에서 차지하는 칸 수
pub fn width(text: &str) -> usize {
    text.chars().map(crate::char_width).sum()
}

/// 화면 폭에 맞춰 자르고, 모자라면 공백으로 채워 정확히 `cols`칸으로 만든다.
/// 2칸 글자가 끝에 걸리면 넣지 않는다.
pub fn fit(text: &str, cols: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = crate::char_width(c);
        if used + w > cols {
            break;
        }
        out.push(c);
        used += w;
    }
    out.extend(std::iter::repeat(' ').take(cols - used));
    out
}
