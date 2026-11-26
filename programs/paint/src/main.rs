//! 그림판. 창의 모든 것(도구 막대, 단추, 그림)을 이 프로그램이 직접 그리고,
//! 마우스와 키보드 입력을 시스템 콜로 받아 처리한다. 저장하면 SVG 파일이 된다.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs, io, process};
use webos::gui::{Align, Color, Event, Frame, Key, Window};

const PAPER: Color = Color::rgb(255, 255, 255);
/// 고를 수 있는 색. 마지막의 흰색은 지우개 구실을 한다.
const COLORS: [Color; 7] = [
    Color::rgb(28, 29, 32),
    Color::rgb(217, 58, 49),
    Color::rgb(224, 138, 0),
    Color::rgb(42, 157, 75),
    Color::rgb(45, 91, 216),
    Color::rgb(139, 63, 199),
    PAPER,
];
const WIDTHS: [f32; 3] = [2.0, 5.0, 12.0];

const ROW: f32 = 40.0;
const PAD: f32 = 10.0;
const STATUS: f32 = 26.0;

/// 창의 테마에 맞춘 도구 막대의 색들
struct Theme {
    bar: Color,
    line: Color,
    text: Color,
    muted: Color,
    button: Color,
    accent: Color,
}

const LIGHT: Theme = Theme {
    bar: Color::rgb(244, 245, 248),
    line: Color::rgb(214, 216, 224),
    text: Color::rgb(25, 26, 32),
    muted: Color::rgb(107, 110, 123),
    button: Color::rgb(255, 255, 255),
    accent: Color::rgb(69, 83, 214),
};

const DARK: Theme = Theme {
    bar: Color::rgb(30, 32, 38),
    line: Color::rgb(58, 60, 70),
    text: Color::rgb(232, 232, 236),
    muted: Color::rgb(141, 144, 156),
    button: Color::rgb(44, 46, 54),
    accent: Color::rgb(142, 155, 255),
};

#[derive(Clone, Copy, PartialEq)]
enum Tool {
    Color(usize),
    Width(usize),
    Undo,
    Clear,
    Save,
}

impl Tool {
    fn width(self) -> f32 {
        match self {
            Tool::Color(_) => 30.0,
            Tool::Width(_) => 34.0,
            Tool::Undo => 72.0,
            Tool::Clear => 84.0,
            Tool::Save => 52.0,
        }
    }

    /// 이 도구 앞에 띄울 간격 (종류가 바뀌는 곳은 넓게)
    fn gap(self) -> f32 {
        match self {
            Tool::Color(0) => 0.0,
            Tool::Width(0) | Tool::Undo => 14.0,
            Tool::Color(_) => 2.0,
            _ => 6.0,
        }
    }
}

struct Placed {
    tool: Tool,
    x: f32,
    y: f32,
    w: f32,
}

struct Stroke {
    color: Color,
    width: f32,
    /// 그림 영역의 왼쪽 위를 (0, 0)으로 한 좌표
    points: Vec<(f32, f32)>,
}

struct Paint {
    w: f32,
    h: f32,
    dark: bool,
    strokes: Vec<Stroke>,
    /// 지금 긋고 있는 중인가 (마지막 획이 아직 끝나지 않았다)
    drawing: bool,
    color: usize,
    width: usize,
    status: String,
    /// 한 번 저장한 뒤에는 같은 파일에 덮어쓴다.
    file: Option<PathBuf>,
    changed: bool,
}

impl Paint {
    /// 도구들을 왼쪽부터 놓고, 창이 좁아 넘치면 다음 줄로 내린다. 도구 막대의 높이도 함께 돌려준다.
    fn layout(&self) -> (Vec<Placed>, f32) {
        let mut tools: Vec<Tool> = (0..COLORS.len()).map(Tool::Color).collect();
        tools.extend((0..WIDTHS.len()).map(Tool::Width));
        tools.extend([Tool::Undo, Tool::Clear, Tool::Save]);

        let mut placed = Vec::new();
        let (mut x, mut y) = (PAD, 0.0);
        for tool in tools {
            let w = tool.width();
            if x > PAD && x + tool.gap() + w > self.w - PAD {
                x = PAD;
                y += ROW;
            } else if x > PAD {
                x += tool.gap();
            }
            placed.push(Placed { tool, x, y, w });
            x += w;
        }
        (placed, y + ROW)
    }

    fn draw(&self) -> Frame {
        let theme = if self.dark { &DARK } else { &LIGHT };
        let (tools, bar) = self.layout();
        let mut f = Frame::new();
        f.clear(PAPER);

        for stroke in &self.strokes {
            let points: Vec<(f32, f32)> = stroke.points.iter().map(|&(x, y)| (x, y + bar)).collect();
            match points[..] {
                // 누르기만 하고 뗀 곳은 점으로 찍는다.
                [(x, y)] => f.circle(x, y, stroke.width / 2.0, stroke.color),
                _ => f.line(&points, stroke.color, stroke.width),
            }
        }

        // 도구 막대. 그림 위에 덮어 그리므로, 그림 영역 밖으로 나간 획은 가려진다.
        f.rect(0.0, 0.0, self.w, bar, 0.0, theme.bar);
        f.rect(0.0, bar - 1.0, self.w, 1.0, 0.0, theme.line);
        for item in &tools {
            let (cx, cy) = (item.x + item.w / 2.0, item.y + ROW / 2.0);
            match item.tool {
                Tool::Color(i) => {
                    if i == self.color {
                        f.circle(cx, cy, 14.0, theme.accent);
                        f.circle(cx, cy, 12.0, theme.bar);
                    }
                    f.circle(cx, cy, 10.0, theme.line);
                    f.circle(cx, cy, 9.0, COLORS[i]);
                }
                Tool::Width(i) => {
                    let selected = i == self.width;
                    f.rect(item.x, item.y + 5.0, item.w, ROW - 10.0, 6.0, theme.button);
                    let edge = if selected { theme.accent } else { theme.line };
                    f.frame(item.x, item.y + 5.0, item.w, ROW - 10.0, 6.0, edge, if selected { 2.0 } else { 1.0 });
                    f.circle(cx, cy, WIDTHS[i] / 2.0 + 1.0, theme.text);
                }
                Tool::Undo | Tool::Clear | Tool::Save => {
                    let label = match item.tool {
                        Tool::Undo => "되돌리기",
                        Tool::Clear => "모두 지우기",
                        _ => "저장",
                    };
                    let usable = item.tool == Tool::Save || !self.strokes.is_empty();
                    f.rect(item.x, item.y + 5.0, item.w, ROW - 10.0, 6.0, theme.button);
                    f.frame(item.x, item.y + 5.0, item.w, ROW - 10.0, 6.0, theme.line, 1.0);
                    f.text(cx, cy, 13.0, if usable { theme.text } else { theme.muted }, Align::Center, false, label);
                }
            }
        }

        // 상태 줄
        let top = self.h - STATUS;
        f.rect(0.0, top, self.w, STATUS, 0.0, theme.bar);
        f.rect(0.0, top, self.w, 1.0, 0.0, theme.line);
        f.text(PAD, top + STATUS / 2.0, 12.0, theme.muted, Align::Left, false, &self.status);
        let count = format!("획 {}개", self.strokes.len());
        f.text(self.w - PAD, top + STATUS / 2.0, 12.0, theme.muted, Align::Right, false, &count);
        f
    }

    /// 입력 하나를 처리한다. 화면을 다시 그려야 하면 true.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Resize { w, h, dark } => {
                (self.w, self.h, self.dark) = (w, h, dark);
            }
            Event::PointerDown { x, y, button: 0, .. } => {
                let (tools, bar) = self.layout();
                if y < bar {
                    let hit = tools.iter().find(|t| x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + ROW);
                    match hit.map(|t| t.tool) {
                        Some(tool) => self.press(tool),
                        None => return false,
                    }
                } else if y < self.h - STATUS {
                    self.strokes.push(Stroke { color: COLORS[self.color], width: WIDTHS[self.width], points: vec![(x, y - bar)] });
                    self.drawing = true;
                    self.changed = true;
                } else {
                    return false;
                }
            }
            Event::PointerMove { x, y } if self.drawing => {
                let bar = self.layout().1;
                let points = &mut self.strokes.last_mut().expect("drawing implies a stroke").points;
                let (px, py) = *points.last().expect("a stroke starts with a point");
                // 거의 움직이지 않은 것은 버려서 점의 수를 줄인다.
                if (x - px).hypot(y - bar - py) < 1.5 {
                    return false;
                }
                points.push((x, y - bar));
            }
            Event::PointerUp { .. } if self.drawing => self.drawing = false,
            Event::Key { key: Key::Char(c), mods } if mods.command() => match c.to_ascii_lowercase() {
                'z' => self.press(Tool::Undo),
                's' => self.press(Tool::Save),
                _ => return false,
            },
            Event::Close => process::exit(0),
            _ => return false,
        }
        true
    }

    fn press(&mut self, tool: Tool) {
        match tool {
            Tool::Color(i) => self.color = i,
            Tool::Width(i) => self.width = i,
            Tool::Undo => {
                self.drawing = false;
                self.changed |= self.strokes.pop().is_some();
            }
            Tool::Clear => {
                self.drawing = false;
                self.changed |= !self.strokes.is_empty();
                self.strokes.clear();
            }
            Tool::Save => {
                self.status = match self.save() {
                    Ok(path) => {
                        self.changed = false;
                        format!("저장했습니다: {}", shorten(&path))
                    }
                    Err(e) => format!("저장하지 못했습니다: {}", webos::describe(&e)),
                };
                return;
            }
        }
        if self.changed && self.file.is_some() {
            self.status = "저장하지 않은 변경이 있습니다".into();
        }
    }

    fn save(&mut self) -> io::Result<PathBuf> {
        let path = match &self.file {
            Some(path) => path.clone(),
            None => {
                let home = env::var("HOME").unwrap_or_else(|_| "/home/guest".into());
                let dir = Path::new(&home).join("그림");
                fs::create_dir_all(&dir)?;
                // "그림 1.svg", "그림 2.svg", … 중 아직 없는 첫 이름
                (1..).map(|n| dir.join(format!("그림 {n}.svg"))).find(|p| !p.exists()).expect("some name is free")
            }
        };
        fs::write(&path, self.svg())?;
        self.file = Some(path.clone());
        Ok(path)
    }

    fn svg(&self) -> String {
        let (w, h) = (self.w, (self.h - self.layout().1 - STATUS).max(1.0));
        let mut out = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\">\n\
             <rect width=\"100%\" height=\"100%\" fill=\"{}\"/>\n",
            PAPER.hex()
        );
        for stroke in &self.strokes {
            let color = stroke.color.hex();
            if let [(x, y)] = stroke.points[..] {
                let _ = writeln!(out, "<circle cx=\"{x:.1}\" cy=\"{y:.1}\" r=\"{:.1}\" fill=\"{color}\"/>", stroke.width / 2.0);
                continue;
            }
            let _ = write!(
                out,
                "<polyline fill=\"none\" stroke=\"{color}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" points=\"",
                stroke.width
            );
            for (i, (x, y)) in stroke.points.iter().enumerate() {
                let _ = write!(out, "{}{x:.1},{y:.1}", if i == 0 { "" } else { " " });
            }
            out.push_str("\"/>\n");
        }
        out.push_str("</svg>\n");
        out
    }
}

/// 홈 아래의 경로는 "~/…"로 줄여 보여 준다.
fn shorten(path: &Path) -> String {
    let text = path.display().to_string();
    match env::var("HOME") {
        Ok(home) if text.starts_with(&home) => format!("~{}", &text[home.len()..]),
        _ => text,
    }
}

fn main() {
    webos::init();
    let window = match Window::open("그림판", 720, 480) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("paint: cannot open a window: {}", webos::describe(&e));
            process::exit(1);
        }
    };
    let mut paint = Paint {
        w: 720.0,
        h: 480.0,
        dark: false,
        strokes: Vec::new(),
        drawing: false,
        color: 0,
        width: 1,
        status: "끌어서 그립니다 · Ctrl+Z 되돌리기 · Ctrl+S 저장".into(),
        file: None,
        changed: false,
    };
    let _ = window.present(&paint.draw());
    while let Some(event) = window.next_event() {
        let mut redraw = paint.handle(event);
        // 밀려 있는 입력을 모두 처리한 뒤 한 번만 그린다.
        while let Some(event) = window.poll_event() {
            redraw |= paint.handle(event);
        }
        if redraw {
            let _ = window.present(&paint.draw());
        }
    }
}
