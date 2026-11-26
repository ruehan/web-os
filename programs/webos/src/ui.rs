//! 창을 그리는 프로그램들이 함께 쓰는 그리기 도우미: 시스템의 색, 글자 폭 기억, 단추 같은 공통 부품, 그리고 "어디를 누르면 무슨 일"의 기록.
//!
//! 화면은 매번 처음부터 다시 그린다. 그리면서 누를 수 있는 자리마다 `hit`으로 할 일을 적어 두고,
//! 입력이 오면 그 기록에서 포인터 아래의 것을 찾는다. 그래서 그리는 코드와 누르는 코드의 좌표가 어긋날 수 없다.

use std::collections::HashMap;
use crate::gui::{Align, Color, Frame, Role, Style, Window};

/// 시스템의 색 (src/ui/style.css의 디자인 토큰과 같은 값)
pub struct Theme {
    pub surface: Color,
    pub surface2: Color,
    pub hover: Color,
    pub line: Color,
    pub line_strong: Color,
    pub text: Color,
    pub muted: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub danger: Color,
    pub danger_soft: Color,
    // 문법 색상 (--syn-string 등)
    pub syn_string: Color,
    pub syn_number: Color,
    pub syn_keyword: Color,
    pub syn_name: Color,
}

pub const LIGHT: Theme = Theme {
    surface: Color::rgb(255, 255, 255),
    surface2: Color::rgb(244, 245, 248),
    hover: Color::rgba(20, 22, 40, 15),
    line: Color::rgba(20, 22, 40, 31),
    line_strong: Color::rgba(20, 22, 40, 56),
    text: Color::rgb(25, 26, 32),
    muted: Color::rgb(107, 110, 123),
    accent: Color::rgb(69, 83, 214),
    accent_soft: Color::rgba(69, 83, 214, 31),
    danger: Color::rgb(194, 51, 42),
    danger_soft: Color::rgba(194, 51, 42, 31),
    syn_string: Color::rgb(26, 127, 55),
    syn_number: Color::rgb(138, 97, 0),
    syn_keyword: Color::rgb(139, 63, 199),
    syn_name: Color::rgb(15, 123, 138),
};

pub const DARK: Theme = Theme {
    surface: Color::rgb(23, 24, 29),
    surface2: Color::rgb(30, 32, 38),
    hover: Color::rgba(255, 255, 255, 18),
    line: Color::rgba(255, 255, 255, 26),
    line_strong: Color::rgba(255, 255, 255, 46),
    text: Color::rgb(232, 232, 236),
    muted: Color::rgb(141, 144, 156),
    accent: Color::rgb(142, 155, 255),
    accent_soft: Color::rgba(142, 155, 255, 41),
    danger: Color::rgb(255, 143, 133),
    danger_soft: Color::rgba(255, 143, 133, 41),
    syn_string: Color::rgb(111, 208, 140),
    syn_number: Color::rgb(229, 192, 123),
    syn_keyword: Color::rgb(201, 155, 245),
    syn_name: Color::rgb(102, 207, 220),
};

/// 모서리의 둥글기 (--radius-s)
pub const RADIUS: f32 = 6.0;
/// 단추의 높이와 글자 크기 (.tool)
pub const TOOL_H: f32 = 26.0;
pub const TOOL_SIZE: f32 = 12.0;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    pub fn contains(&self, (x, y): (f32, f32)) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }

    pub fn mid_y(&self) -> f32 {
        self.y + self.h / 2.0
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    /// 두 사각형이 겹치는 부분
    pub fn clipped(&self, by: &Rect) -> Rect {
        let (x, y) = (self.x.max(by.x), self.y.max(by.y));
        Rect::new(x, y, (self.right().min(by.right()) - x).max(0.0), (self.bottom().min(by.bottom()) - y).max(0.0))
    }
}

/// 글의 폭을 재되, 한 번 잰 것은 기억해 둔다 (잴 때마다 화면 쪽에 물어봐야 하므로).
#[derive(Default)]
pub struct Widths {
    known: HashMap<(String, u32, Style), f32>,
}

impl Widths {
    pub fn of(&mut self, window: &Window, texts: &[&str], size: f32, style: Style) -> Vec<f32> {
        // 줄 긋기는 폭을 바꾸지 않는다.
        let style = Style { strike: false, underline: false, ..style };
        let key = |text: &str| (text.to_string(), size.to_bits(), style);
        let mut unknown: Vec<&str> = texts.iter().copied().filter(|t| !self.known.contains_key(&key(t))).collect();
        unknown.sort_unstable();
        unknown.dedup();
        for (text, width) in unknown.iter().zip(window.measure_styled(&unknown, size, style)) {
            self.known.insert(key(text), width);
        }
        texts.iter().map(|t| self.known[&key(t)]).collect()
    }
}

/// 단추의 종류
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Plain,
    /// 가장 자주 쓰는 일 (강조색 테두리)
    Primary,
    /// 되돌릴 수 없는 일
    Danger,
}

/// 한 번의 그리기. `A`는 누를 수 있는 자리에 적어 두는 "할 일"이다.
pub struct Ui<'a, A> {
    pub f: Frame,
    pub theme: &'a Theme,
    pub hits: Vec<(Rect, A)>,
    pub widths: Widths,
    window: Window,
    mouse: Option<(f32, f32)>,
    /// 지금 걸려 있는 clip. 가려진 곳은 눌리지 않아야 한다.
    clip: Option<Rect>,
}

impl<'a, A: Clone> Ui<'a, A> {
    pub fn new(window: Window, widths: Widths, theme: &'a Theme, mouse: Option<(f32, f32)>) -> Ui<'a, A> {
        Ui { f: Frame::new(), theme, hits: Vec::new(), widths, window, mouse, clip: None }
    }

    /// 포인터의 자리를 바꾼다. `None`이면 이 뒤로 그리는 것은 포인터가 올라간 표시를 하지 않는다.
    pub fn set_mouse(&mut self, mouse: Option<(f32, f32)>) {
        self.mouse = mouse;
    }

    pub fn width(&mut self, text: &str, size: f32, style: Style) -> f32 {
        self.widths.of(&self.window, &[text], size, style)[0]
    }

    /// 여러 글의 폭을 한 번에 잰다 (화면 쪽에 묻는 횟수를 줄인다).
    pub fn widths_of(&mut self, texts: &[&str], size: f32, style: Style) -> Vec<f32> {
        self.widths.of(&self.window, texts, size, style)
    }

    /// 폭에 맞지 않는 글은 뒤를 자르고 "…"를 붙인다.
    pub fn fit(&mut self, text: &str, size: f32, style: Style, room: f32) -> String {
        if self.width(text, size, style) <= room {
            return text.to_string();
        }
        // 글자마다의 폭을 더해 가며 들어가는 데까지만 남긴다.
        let chars: Vec<String> = text.chars().map(String::from).collect();
        let refs: Vec<&str> = chars.iter().map(String::as_str).collect();
        let each = self.widths.of(&self.window, &refs, size, style);
        let mut used = self.width("…", size, style);
        let mut out = String::new();
        for (ch, width) in chars.iter().zip(each) {
            if used + width > room {
                break;
            }
            used += width;
            out.push_str(ch);
        }
        out.push('…');
        out
    }

    pub fn text(&mut self, x: f32, y: f32, size: f32, color: Color, style: Style, text: &str) {
        self.f.styled(x, y, size, color, Align::Left, style, text);
    }

    /// 폭 `room` 안에 들어가게 줄여서 쓴다.
    #[allow(clippy::too_many_arguments)]
    pub fn label(&mut self, x: f32, y: f32, size: f32, color: Color, style: Style, room: f32, text: &str) {
        let fitted = self.fit(text, size, style, room.max(0.0));
        self.text(x, y, size, color, style, &fitted);
    }

    pub fn clip(&mut self, rect: Rect) {
        self.f.clip(rect.x, rect.y, rect.w, rect.h);
        self.clip = Some(rect);
    }

    pub fn unclip(&mut self) {
        self.f.unclip();
        self.clip = None;
    }

    /// 포인터가 이 자리 위에 있는가
    pub fn hot(&self, rect: Rect) -> bool {
        let rect = self.clip.map_or(rect, |clip| rect.clipped(&clip));
        self.mouse.is_some_and(|at| rect.contains(at))
    }

    /// 이 자리를 누르면 `action`이 일어난다. 나중에 적은 것이 위에 있다.
    pub fn hit(&mut self, rect: Rect, action: A) {
        let rect = self.clip.map_or(rect, |clip| rect.clipped(&clip));
        if rect.w > 0.0 && rect.h > 0.0 {
            self.hits.push((rect, action));
        }
    }

    /// 누를 수 있는 자리이면서, 화면 낭독기에도 무엇인지 알린다.
    pub fn target(&mut self, rect: Rect, role: Role, on: bool, label: &str, action: A) {
        let seen = self.clip.map_or(rect, |clip| rect.clipped(&clip));
        if seen.w > 0.0 && seen.h > 0.0 {
            self.f.region(seen.x, seen.y, seen.w, seen.h, role, on, false, label);
            self.hits.push((seen, action));
        }
    }

    pub fn tool_width(&mut self, label: &str) -> f32 {
        (self.width(label, TOOL_SIZE, Style::PLAIN) + 20.0).ceil()
    }

    /// 단추 하나 (.tool). 차지한 폭을 돌려준다. `action`이 없으면 누를 수 없는 흐린 단추다.
    pub fn tool(&mut self, x: f32, y: f32, label: &str, kind: Tool, pressed: bool, action: Option<A>) -> f32 {
        let w = self.tool_width(label);
        let rect = Rect::new(x, y, w, TOOL_H);
        let theme = self.theme;
        let enabled = action.is_some();
        let hot = enabled && self.hot(rect);
        let (border, color) = match kind {
            Tool::Plain if hot => (theme.line_strong, theme.text),
            Tool::Plain => (theme.line, theme.text),
            Tool::Primary => (theme.accent, theme.accent),
            Tool::Danger => (theme.danger, theme.danger),
        };
        let fade = |c: Color| if enabled { c } else { c.alpha((c.0 & 0xff) as u8 / 2) };
        self.f.rect(x, y, w, TOOL_H, RADIUS, theme.surface);
        if hot || pressed {
            self.f.rect(x, y, w, TOOL_H, RADIUS, if pressed { theme.accent_soft } else { theme.hover });
        }
        self.f.frame(x, y, w, TOOL_H, RADIUS, fade(border), 1.0);
        self.f.styled(x + w / 2.0, rect.mid_y(), TOOL_SIZE, fade(color), Align::Center, Style::PLAIN, label);
        match action {
            Some(action) => self.target(rect, Role::Button, pressed, label, action),
            None => self.f.region(x, y, w, TOOL_H, Role::Button, false, true, label),
        }
        w
    }

    /// 글자 없는 작은 × 단추. 포인터를 올리면 바탕이 생긴다.
    pub fn close_button(&mut self, rect: Rect, danger: bool, label: &str, action: A) {
        let theme = self.theme;
        let hot = self.hot(rect);
        if hot {
            self.f.rect(rect.x, rect.y, rect.w, rect.h, 4.0, if danger { theme.danger_soft } else { theme.hover });
        }
        let color = match (hot, danger) {
            (true, true) => theme.danger,
            (true, false) => theme.text,
            _ => theme.muted,
        };
        let (cx, cy, r) = (rect.x + rect.w / 2.0, rect.mid_y(), 2.8);
        self.f.line(&[(cx - r, cy - r), (cx + r, cy + r)], color, 1.1);
        self.f.line(&[(cx - r, cy + r), (cx + r, cy - r)], color, 1.1);
        self.target(rect, Role::Button, false, label, action);
    }

    /// 입력 칸의 테두리와 바탕 (칸 자체는 `Frame::field`로 그 안쪽에 놓는다)
    pub fn field_box(&mut self, rect: Rect, focused: bool) {
        let theme = self.theme;
        self.f.rect(rect.x, rect.y, rect.w, rect.h, RADIUS, theme.surface);
        self.f.frame(rect.x, rect.y, rect.w, rect.h, RADIUS, if focused { theme.accent } else { theme.line_strong }, if focused { 1.5 } else { 1.0 });
    }

    pub fn hline(&mut self, x: f32, y: f32, w: f32) {
        self.f.rect(x, y, w, 1.0, 0.0, self.theme.line);
    }

    pub fn vline(&mut self, x: f32, y: f32, h: f32) {
        self.f.rect(x, y, 1.0, h, 0.0, self.theme.line);
    }

    /// 20×20 칸에 그려진 선 그림을 (x, y)에 `scale`배로 그린다.
    pub fn icon(&mut self, x: f32, y: f32, scale: f32, color: Color, strokes: &[&[(f32, f32)]]) {
        for stroke in strokes {
            let points: Vec<(f32, f32)> = stroke.iter().map(|&(px, py)| (x + px * scale, y + py * scale)).collect();
            self.f.line(&points, color, 1.5 * scale);
        }
    }
}

/// 아이콘들 (src/ui/icons.tsx의 것을 꺾은선으로 옮겼다)
pub const FOLDER: &[&[(f32, f32)]] = &[&[
    (2.5, 6.0), (3.1, 4.6), (4.5, 4.0), (7.5, 4.0), (9.5, 6.0), (15.5, 6.0), (16.9, 6.6), (17.5, 8.0),
    (17.5, 14.0), (16.9, 15.4), (15.5, 16.0), (4.5, 16.0), (3.1, 15.4), (2.5, 14.0), (2.5, 6.0),
]];

pub const NOTE: &[&[(f32, f32)]] = &[
    &[(4.5, 3.5), (15.5, 3.5), (16.5, 4.5), (16.5, 12.0), (12.0, 16.5), (4.5, 16.5), (3.5, 15.5), (3.5, 4.5), (4.5, 3.5)],
    &[(16.5, 12.0), (13.0, 12.0), (12.0, 13.0), (12.0, 16.5)],
    &[(6.5, 7.0), (13.5, 7.0)],
    &[(6.5, 10.0), (10.5, 10.0)],
];

pub const FILE: &[&[(f32, f32)]] = &[
    &[
        (5.0, 4.5), (5.6, 3.1), (7.0, 2.5), (11.0, 2.5), (15.0, 6.5), (15.0, 15.5), (14.4, 16.9), (13.0, 17.5),
        (7.0, 17.5), (5.6, 16.9), (5.0, 15.5), (5.0, 4.5),
    ],
    &[(11.0, 2.5), (11.0, 6.5), (15.0, 6.5)],
];

pub const UP: &[&[(f32, f32)]] = &[&[(10.0, 15.5), (10.0, 4.5)], &[(5.5, 9.0), (10.0, 4.5), (14.5, 9.0)]];

/// 글자의 종류별 순서: 기호, 숫자, 한글, 그 밖의 글자 (한국어 사전의 순서)
fn rank(c: char) -> u8 {
    match c {
        '0'..='9' => 1,
        '\u{1100}'..='\u{11ff}' | '\u{3130}'..='\u{318f}' | '\u{ac00}'..='\u{d7a3}' => 2,
        c if c.is_alphabetic() => 3,
        _ => 0,
    }
}

/// 사람이 기대하는 이름순: 대소문자를 가리지 않고, 숫자는 수로 견주고("메모 2"가 "메모 10"보다 먼저), 한글이 영문보다 먼저다.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (a, b): (Vec<char>, Vec<char>) = (a.to_lowercase().chars().collect(), b.to_lowercase().chars().collect());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let number = |s: &[char], at: &mut usize| {
                let mut n = 0u64;
                while *at < s.len() && s[*at].is_ascii_digit() {
                    n = n.saturating_mul(10).saturating_add(s[*at] as u64 - '0' as u64);
                    *at += 1;
                }
                n
            };
            match number(&a, &mut i).cmp(&number(&b, &mut j)) {
                Ordering::Equal => continue,
                other => return other,
            }
        }
        match rank(a[i]).cmp(&rank(b[j])).then(a[i].cmp(&b[j])) {
            Ordering::Equal => {
                i += 1;
                j += 1;
            }
            other => return other,
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}
