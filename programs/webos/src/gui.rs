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
    #[link_name = "gui_text"]
    fn sys_gui_text(field: u32, offset: usize, buf: *mut u8, len: usize, version: *mut u32) -> i32;
    #[link_name = "gui_set_text"]
    fn sys_gui_set_text(field: u32, text: *const u8, len: usize) -> i32;
    #[link_name = "gui_measure"]
    fn sys_gui_measure(req: *const u8, len: usize, out: *mut f32, cap: usize) -> i32;
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

impl Color {
    /// 같은 색을 다른 불투명도(0~255)로
    pub const fn alpha(self, a: u8) -> Color {
        Color((self.0 & !0xff) | a as u32)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Left = 0,
    Center = 1,
    Right = 2,
}

/// 글자의 꾸밈
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub struct Style {
    pub bold: bool,
    /// 고정폭 글꼴
    pub mono: bool,
    pub italic: bool,
    /// 가운데 줄 긋기
    pub strike: bool,
    pub underline: bool,
}

impl Style {
    pub const PLAIN: Style = Style { bold: false, mono: false, italic: false, strike: false, underline: false };
    pub const BOLD: Style = Style { bold: true, ..Style::PLAIN };
    pub const MONO: Style = Style { mono: true, ..Style::PLAIN };
}

/// 그림 속의 자리가 무엇인지 (`Frame::region`)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Button = 0,
    Tab = 1,
    TreeItem = 2,
    Option = 3,
    Checkbox = 4,
    Link = 5,
}

/// 메뉴의 한 줄 (`Frame::menu`)
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct MenuItem {
    pub label: String,
    pub disabled: bool,
    /// 지우기처럼 되돌릴 수 없는 일
    pub danger: bool,
    pub separator: bool,
}

impl MenuItem {
    pub fn new(label: &str) -> MenuItem {
        MenuItem { label: label.to_string(), ..MenuItem::default() }
    }

    pub fn danger(label: &str) -> MenuItem {
        MenuItem { danger: true, ..MenuItem::new(label) }
    }

    pub fn separator() -> MenuItem {
        MenuItem { separator: true, ..MenuItem::default() }
    }

    pub fn disabled_if(mut self, disabled: bool) -> MenuItem {
        self.disabled = disabled;
        self
    }
}

/// 글 입력 칸 하나. `Frame::field`로 놓는다.
pub struct Field<'a> {
    /// 프로그램이 정하는 번호. 글을 주고받을 때 이 번호로 가리킨다.
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// 글자 크기
    pub size: f32,
    pub color: Color,
    pub background: Color,
    /// 여러 줄을 쓸 수 있는가
    pub multiline: bool,
    /// 고정폭 글꼴
    pub mono: bool,
    pub bold: bool,
    /// 이 묶음을 그릴 때 커서를 이 칸으로 옮긴다. 옮기고 싶을 때의 묶음 하나에만 켠다.
    pub focus: bool,
    /// `focus`와 함께: 글 전체를 고른 채로 커서를 옮긴다.
    pub select: bool,
    /// 화면 낭독기 등에 알려 줄 이름
    pub label: &'a str,
    /// 비어 있을 때 흐리게 보이는 글
    pub placeholder: &'a str,
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
        self.styled(x, y, size, color, align, Style { bold, ..Style::PLAIN }, text);
    }

    /// `text`와 같되 꾸밈(고정폭, 기울임, 줄 긋기)을 정한다.
    #[allow(clippy::too_many_arguments)]
    pub fn styled(&mut self, x: f32, y: f32, size: f32, color: Color, align: Align, style: Style, text: &str) {
        self.op(6);
        self.f(&[x, y, size]);
        self.u(color.0);
        self.buf.push(
            align as u8
                | (style.bold as u8) << 2
                | (style.mono as u8) << 3
                | (style.italic as u8) << 4
                | (style.strike as u8) << 5
                | (style.underline as u8) << 6,
        );
        self.s(text);
    }

    fn s(&mut self, text: &str) {
        self.u(text.len() as u32);
        self.buf.extend_from_slice(text.as_bytes());
    }

    /// 그림의 이 자리가 무엇인지 알린다 (그려지는 것은 없다). 화면 낭독기가 읽고 누를 수 있게 된다.
    /// `on`은 골라진 탭·항목, 눌려 있는 단추, 체크된 상자를 뜻한다.
    #[allow(clippy::too_many_arguments)]
    pub fn region(&mut self, x: f32, y: f32, w: f32, h: f32, role: Role, on: bool, disabled: bool, label: &str) {
        self.op(10);
        self.f(&[x, y, w, h]);
        self.buf.push(role as u8);
        self.buf.push(on as u8 | (disabled as u8) << 1);
        self.s(label);
    }

    /// 입력 칸의 커서를 옮긴다 (`start`와 `end`가 다르면 그 사이를 고른다). 자리는 글의 바이트 위치다.
    /// 화면 쪽은 커서가 보이도록 칸을 스크롤하고 초점을 준다. 옮기고 싶을 때의 묶음 하나에만 넣는다.
    pub fn select(&mut self, field: u32, start: usize, end: usize) {
        self.op(12);
        self.u(field);
        self.u(start as u32);
        self.u(end as u32);
    }

    /// 이 자리에 시스템의 메뉴를 띄운다. 고른 것은 `Event::Menu`로 온다. 띄우고 싶을 때의 묶음 하나에만 넣는다.
    pub fn menu(&mut self, x: f32, y: f32, items: &[MenuItem]) {
        self.op(11);
        self.f(&[x, y]);
        self.u(items.len() as u32);
        for item in items {
            self.buf.push(item.disabled as u8 | (item.danger as u8) << 1 | (item.separator as u8) << 2);
            self.s(&item.label);
        }
    }

    /// 이 뒤로는 사각형 안에만 그려진다. 다 그리면 `unclip`을 부른다.
    pub fn clip(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.op(7);
        self.f(&[x, y, w, h]);
    }

    pub fn unclip(&mut self) {
        self.op(8);
    }

    /// 이 자리에 글 입력 칸을 놓는다. 칸은 묶음에 들어 있는 동안만 있다.
    /// 글의 내용은 `Window::set_text`로 정하고, 사용자가 고치면 `Event::Input`이 온다.
    pub fn field(&mut self, field: &Field) {
        self.op(9);
        self.u(field.id);
        self.f(&[field.x, field.y, field.w, field.h, field.size]);
        self.u(field.color.0);
        self.u(field.background.0);
        self.buf.push(
            field.multiline as u8 | (field.mono as u8) << 1 | (field.focus as u8) << 2 | (field.bold as u8) << 3 | (field.select as u8) << 4,
        );
        self.s(field.label);
        self.s(field.placeholder);
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
    /// `button`: 0 왼쪽, 1 가운데, 2 오른쪽. `clicks`: 같은 자리를 연달아 누른 횟수 (두 번 누르기는 2).
    PointerDown { x: f32, y: f32, button: i32, clicks: i32 },
    PointerMove { x: f32, y: f32 },
    PointerUp { x: f32, y: f32 },
    Key { key: Key, mods: Mods },
    /// 사용자가 창을 닫으려 한다. 정리하고 종료해야 한다 (곧 강제로 종료된다).
    Close,
    /// 마우스 휠이나 두 손가락 밀기. `dy`는 세로로 민 양 (아래가 양수).
    Wheel { x: f32, y: f32, dy: f32 },
    /// 입력 칸의 글이 바뀌었다. `Window::text`로 가져온다.
    Input { field: u32 },
    /// 창이 입력을 받게 됐거나(true) 다른 창으로 넘어갔다(false).
    Focus(bool),
    /// 입력 칸에 커서가 들어갔거나(true) 나갔다(false).
    FieldFocus { field: u32, on: bool },
    /// `Frame::menu`로 띄운 메뉴에서 고른 줄의 순번. 고르지 않고 닫았으면 `None`.
    Menu(Option<usize>),
    /// 포인터가 그림 밖으로 나갔다.
    PointerLeave,
}

fn decode(raw: [i32; 4]) -> Option<Event> {
    let [kind, a, b, c] = raw;
    // 포인터의 좌표는 1/16 픽셀 단위로 온다.
    let (x, y) = (a as f32 / 16.0, b as f32 / 16.0);
    Some(match kind {
        1 => Event::Resize { w: a as f32, h: b as f32, dark: c != 0 },
        2 => Event::PointerDown { x, y, button: c & 0xff, clicks: (c >> 8) + 1 },
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
        7 => Event::Wheel { x, y, dy: c as f32 },
        8 => Event::Input { field: a as u32 },
        9 => Event::Focus(a != 0),
        10 => Event::FieldFocus { field: a as u32, on: b != 0 },
        11 => Event::Menu(usize::try_from(a).ok()),
        12 => Event::PointerLeave,
        _ => return None,
    })
}

/// 이 프로세스의 창. 프로세스마다 하나만 열 수 있다.
#[derive(Clone, Copy)]
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

    /// 입력 칸의 글을 정한다 (파일을 열었을 때 등).
    pub fn set_text(&self, field: u32, text: &str) -> io::Result<()> {
        crate::check(unsafe { sys_gui_set_text(field, text.as_ptr(), text.len()) }).map(|_| ())
    }

    /// 입력 칸에 지금 적혀 있는 글
    pub fn text(&self, field: u32) -> io::Result<String> {
        // 긴 글은 여러 번에 나눠 읽는다. 읽는 사이에 사용자가 또 고쳤으면(판 번호가 달라짐) 처음부터 다시 읽는다.
        'again: loop {
            let mut bytes = Vec::new();
            let mut first = None;
            loop {
                let mut chunk = [0u8; 32 * 1024];
                let mut version = 0u32;
                let n = crate::check(unsafe { sys_gui_text(field, bytes.len(), chunk.as_mut_ptr(), chunk.len(), &mut version) })? as usize;
                if *first.get_or_insert(version) != version {
                    continue 'again;
                }
                if n == 0 {
                    return String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
                }
                bytes.extend_from_slice(&chunk[..n]);
            }
        }
    }

    /// 글들이 화면에서 차지할 폭. 글자를 그리는 것은 화면 쪽이라 폭도 화면 쪽에 물어봐야 안다.
    /// 물어볼 때마다 프로세스가 잠깐 멈추므로, 여러 글을 한 번에 묻는 것이 좋다.
    pub fn measure(&self, texts: &[&str], size: f32, bold: bool) -> Vec<f32> {
        self.measure_styled(texts, size, Style { bold, ..Style::PLAIN })
    }

    /// `measure`와 같되 꾸밈(고정폭, 기울임)까지 정한다.
    pub fn measure_styled(&self, texts: &[&str], size: f32, style: Style) -> Vec<f32> {
        if texts.is_empty() {
            return Vec::new();
        }
        let mut req = Vec::new();
        req.extend_from_slice(&size.to_le_bytes());
        req.push(style.bold as u8 | (style.mono as u8) << 1 | (style.italic as u8) << 2);
        for text in texts {
            req.extend_from_slice(&(text.len() as u32).to_le_bytes());
            req.extend_from_slice(text.as_bytes());
        }
        let mut widths = vec![0f32; texts.len()];
        let got = unsafe { sys_gui_measure(req.as_ptr(), req.len(), widths.as_mut_ptr(), widths.len()) };
        if got < texts.len() as i32 {
            // 잴 수 없으면 글자 수로 어림한다.
            for (width, text) in widths.iter_mut().zip(texts) {
                *width = text.chars().count() as f32 * size * 0.6;
            }
        }
        widths
    }
}
