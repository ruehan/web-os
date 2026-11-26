//! 창을 열어 그림을 그리고 입력을 받는다.
//!
//! 프로그램은 그릴 것들(도형, 글자)을 `Frame`에 차례로 적어 `Window::present`로 보낸다.
//! 보낼 때마다 창의 내용이 통째로 바뀐다. 좌표는 창 안쪽의 왼쪽 위가 (0, 0)이다.
//! 규약의 상세는 커널의 `src/kernel/gui.ts`에 있고, 여기의 숫자들은 그쪽과 같아야 한다.

use std::io;

#[link(wasm_import_module = "webos")]
extern "C" {
    #[link_name = "gui_open"]
    fn sys_gui_open(title: *const u8, len: usize, w: i32, h: i32) -> i32;
    #[link_name = "gui_draw"]
    fn sys_gui_draw(data: *const u8, len: usize) -> i32;
    #[link_name = "gui_event"]
    fn sys_gui_event(out: *mut i32, timeout_ms: i32) -> i32;
}

/// 빨강, 초록, 파랑, 불투명도 (각 0~255)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Color(pub u32);

impl Color {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color::rgba(r, g, b, 255)
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
        Color(((r as u32) << 24) | ((g as u32) << 16) | ((b as u32) << 8) | a as u32)
    }

    /// "#rrggbb" 형식 (SVG 등에 쓴다)
    pub fn hex(self) -> String {
        format!("#{:06x}", self.0 >> 8)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Left = 0,
    Center = 1,
    Right = 2,
}

/// 한 번에 그릴 것들의 묶음
#[derive(Default)]
pub struct Frame {
    buf: Vec<u8>,
}

impl Frame {
    pub fn new() -> Frame {
        Frame::default()
    }

    fn op(&mut self, op: u8) {
        self.buf.push(op);
    }

    fn f(&mut self, values: &[f32]) {
        for v in values {
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
    }

    fn u(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    /// 창 전체를 한 색으로 채운다. 묶음의 맨 처음에 부른다.
    pub fn clear(&mut self, color: Color) {
        self.op(1);
        self.u(color.0);
    }

    /// 채운 사각형. `radius`는 모서리의 둥글기.
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, radius: f32, color: Color) {
        self.op(2);
        self.f(&[x, y, w, h, radius]);
        self.u(color.0);
    }

    /// 테두리만 있는 사각형
    #[allow(clippy::too_many_arguments)]
    pub fn frame(&mut self, x: f32, y: f32, w: f32, h: f32, radius: f32, color: Color, width: f32) {
        self.op(3);
        self.f(&[x, y, w, h, radius]);
        self.u(color.0);
        self.f(&[width]);
    }

    /// 점들을 잇는 선. 끝과 꺾이는 곳은 둥글게 그려진다.
    pub fn line(&mut self, points: &[(f32, f32)], color: Color, width: f32) {
        self.op(4);
        self.u(color.0);
        self.f(&[width]);
        self.u(points.len() as u32);
        for &(x, y) in points {
            self.f(&[x, y]);
        }
    }

    pub fn circle(&mut self, x: f32, y: f32, r: f32, color: Color) {
        self.op(5);
        self.f(&[x, y, r]);
        self.u(color.0);
    }

    /// 글자. `y`는 글자의 세로 가운데, `x`는 `align`에 따라 왼쪽 끝·가운데·오른쪽 끝이다.
    #[allow(clippy::too_many_arguments)]
    pub fn text(&mut self, x: f32, y: f32, size: f32, color: Color, align: Align, bold: bool, text: &str) {
        self.op(6);
        self.f(&[x, y, size]);
        self.u(color.0);
        self.buf.push(align as u8 | if bold { 4 } else { 0 });
        self.u(text.len() as u32);
        self.buf.extend_from_slice(text.as_bytes());
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    Char(char),
    Backspace,
    Enter,
    Escape,
    Tab,
    Left,
    Right,
    Up,
    Down,
    Delete,
    Home,
    End,
}

/// 함께 누른 키들
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

impl Mods {
    /// 단축키용: Ctrl 또는 Cmd를 눌렀는가
    pub fn command(self) -> bool {
        self.ctrl || self.meta
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Event {
    /// 창의 안쪽 크기나 테마가 바뀌었다. 창이 열린 직후에도 한 번 온다.
    Resize { w: f32, h: f32, dark: bool },
    /// `button`: 0 왼쪽, 1 가운데, 2 오른쪽
    PointerDown { x: f32, y: f32, button: i32 },
    PointerMove { x: f32, y: f32 },
    PointerUp { x: f32, y: f32 },
    Key { key: Key, mods: Mods },
    /// 사용자가 창을 닫으려 한다. 정리하고 종료해야 한다 (곧 강제로 종료된다).
    Close,
}

fn decode(raw: [i32; 4]) -> Option<Event> {
    let [kind, a, b, c] = raw;
    // 포인터의 좌표는 1/16 픽셀 단위로 온다.
    let (x, y) = (a as f32 / 16.0, b as f32 / 16.0);
    Some(match kind {
        1 => Event::Resize { w: a as f32, h: b as f32, dark: c != 0 },
        2 => Event::PointerDown { x, y, button: c },
        3 => Event::PointerMove { x, y },
        4 => Event::PointerUp { x, y },
        5 => Event::Key {
            key: match a {
                -1 => Key::Backspace,
                -2 => Key::Enter,
                -3 => Key::Escape,
                -4 => Key::Tab,
                -5 => Key::Left,
                -6 => Key::Right,
                -7 => Key::Up,
                -8 => Key::Down,
                -9 => Key::Delete,
                -10 => Key::Home,
                -11 => Key::End,
                code => Key::Char(char::from_u32(u32::try_from(code).ok()?)?),
            },
            mods: Mods { shift: b & 1 != 0, ctrl: b & 2 != 0, alt: b & 4 != 0, meta: b & 8 != 0 },
        },
        6 => Event::Close,
        _ => return None,
    })
}

/// 이 프로세스의 창. 프로세스마다 하나만 열 수 있다.
pub struct Window(());

impl Window {
    /// `w`×`h`는 바라는 안쪽 크기다. 실제 크기는 곧 `Event::Resize`로 온다.
    pub fn open(title: &str, w: u32, h: u32) -> io::Result<Window> {
        crate::check(unsafe { sys_gui_open(title.as_ptr(), title.len(), w as i32, h as i32) })?;
        Ok(Window(()))
    }

    /// 창의 내용을 이 묶음으로 바꿔 그린다.
    pub fn present(&self, frame: &Frame) -> io::Result<()> {
        crate::check(unsafe { sys_gui_draw(frame.buf.as_ptr(), frame.buf.len()) }).map(|_| ())
    }

    fn wait(&self, timeout_ms: i32) -> Option<Event> {
        loop {
            let mut raw = [0i32; 4];
            if unsafe { sys_gui_event(raw.as_mut_ptr(), timeout_ms) } <= 0 {
                return None;
            }
            // 모르는 종류의 이벤트는 건너뛴다 (나중에 규약에 추가된 것일 수 있다).
            if let Some(event) = decode(raw) {
                return Some(event);
            }
        }
    }

    /// 다음 입력이 올 때까지 멈춰 기다린다. 창을 쓸 수 없게 되면 `None`.
    pub fn next_event(&self) -> Option<Event> {
        self.wait(-1)
    }

    /// 다음 입력을 최대 `ms` 밀리초 기다린다. 그동안 아무것도 없으면 `None` (움직이는 화면을 그릴 때 쓴다).
    pub fn next_event_within(&self, ms: u32) -> Option<Event> {
        self.wait(ms.min(i32::MAX as u32) as i32)
    }

    /// 이미 와 있는 입력이 있으면 가져온다. 기다리지 않는다.
    pub fn poll_event(&self) -> Option<Event> {
        self.wait(0)
    }
}
