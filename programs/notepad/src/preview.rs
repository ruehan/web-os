//! 마크다운을 읽기 좋게 그린다: 글자의 폭을 재서 줄을 나누고, 제목·목록·표·코드 블록을 배치한다.
//!
//! 화면 쪽의 미리보기(src/ui/editor/Preview.tsx와 .preview 스타일)와 같은 모양을 내도록 크기와 여백을 맞췄다.
//! 배치와 그리기를 한 번에 한다. `draw`를 끄면 그리지 않고 높이만 잰다 (스크롤의 끝을 알기 위해).

use crate::markdown::{self, Block, Inline, List};
use crate::ui::{Rect, Ui};
use crate::vault;
use std::collections::HashMap;
use webos::gui::{Align, Color, Role, Style};

/// 미리보기에서 누를 수 있는 것
#[derive(Clone, PartialEq, Debug)]
pub enum Target {
    /// [[메모 링크]]
    Link(String),
    Tag(String),
    /// 체크 목록의 체크 (원문의 줄 번호)
    Toggle(usize),
}

pub struct Laid {
    /// 문서 전체의 높이
    pub height: f32,
    /// 제목들: (원문의 줄, 문서 위에서부터의 거리)
    pub headings: Vec<(usize, f32)>,
}

const PAD_X: f32 = 20.0;
const PAD_Y: f32 = 16.0;
const SIZE: f32 = 13.0;
const LINE: f32 = 22.0;
/// 문단, 목록, 인용 아래의 여백 (0.9em)
const GAP: f32 = 11.7;
const HEADING_SIZES: [f32; 6] = [22.0, 18.0, 15.0, 13.0, 13.0, 13.0];
const CODE_SIZE: f32 = 12.5;
const CODE_LINE: f32 = 20.0;
const INDENT: f32 = 19.5;
/// 넣기가 서로를 가리킬 때 끝없이 그리지 않도록 깊이를 제한한다.
const EMBED_DEPTH: usize = 3;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Plain,
    Code,
    Link,
    /// 아직 없는 메모를 가리키는 링크
    Missing,
    Tag,
    Muted,
}

/// 같은 모양으로 이어지는 글 한 토막
struct Span {
    text: String,
    style: Style,
    kind: Kind,
    target: Option<Target>,
    /// 글이 아니라 그림이면: 파일의 경로와 원래 크기
    image: Option<Picture>,
}

/// 그릴 수 있는 그림: 파일의 절대 경로, 너비, 높이
pub type Picture = (String, f32, f32);

/// 줄을 나눌 수 있는 가장 작은 단위: 낱말 하나, 한글 한 글자, 또는 공백
struct Atom {
    span: usize,
    text: String,
    space: bool,
    w: f32,
}

/// 그림의 위아래 여백
const IMAGE_GAP: f32 = 5.0;

/// 한 줄 위의, 한 번에 그릴 토막
struct Seg {
    span: usize,
    x: f32,
    w: f32,
    text: String,
    /// 그림이면 그릴 높이 (폭은 w)
    image_h: Option<f32>,
}

/// 띄어쓰기 없이도 글자 사이에서 줄을 바꿀 수 있는 글자인가 (한글, 한자, 가나 등)
fn breaks_anywhere(c: char) -> bool {
    c >= '\u{1100}'
}

pub struct Preview<'u, 't, A> {
    ui: &'u mut Ui<'t, A>,
    files: &'u [String],
    texts: &'u HashMap<String, String>,
    act: &'u dyn Fn(Target) -> A,
    /// 링크의 대상이 보관함의 그림이면 그 그림을 찾아 준다.
    image: &'u dyn Fn(&str) -> Option<Picture>,
    view: Rect,
    draw: bool,
    /// 다음에 그릴 자리 (화면 좌표)
    y: f32,
    /// 지금 블록이 그 모임의 첫 블록인가 (첫 블록은 위 여백이 없다)
    first: bool,
    /// 앞 블록의 아래 여백. 다음 블록의 위 여백과 겹쳐서, 둘 중 큰 쪽만큼만 띈다.
    gap: f32,
    headings: Vec<(usize, f32)>,
}

/// `view` 안에 `text`를 그린다. `scroll`만큼 위로 밀린 채로 그리고, 보이지 않는 부분은 건너뛴다.
/// `interactive`가 꺼져 있으면 체크를 누를 수 없다.
#[allow(clippy::too_many_arguments)]
pub fn render<A: Clone>(
    ui: &mut Ui<A>,
    files: &[String],
    texts: &HashMap<String, String>,
    text: &str,
    view: Rect,
    scroll: f32,
    draw: bool,
    interactive: bool,
    act: &dyn Fn(Target) -> A,
    image: &dyn Fn(&str) -> Option<Picture>,
) -> Laid {
    let top = view.y - scroll;
    let mut preview = Preview { ui, files, texts, act, image, view, draw, y: top + PAD_Y, first: true, gap: 0.0, headings: Vec::new() };
    let blocks = markdown::parse(text);
    preview.blocks(&blocks, view.x + PAD_X, (view.w - PAD_X * 2.0).max(40.0), 0, interactive);
    let headings = preview.headings.iter().map(|&(line, y)| (line, y - top)).collect();
    Laid { height: preview.y - top + PAD_Y, headings }
}

impl<A: Clone> Preview<'_, '_, A> {
    fn visible(&self, y: f32, h: f32) -> bool {
        self.draw && y + h >= self.view.y && y <= self.view.bottom()
    }

    /// 블록 위의 여백. 모임의 첫 블록에는 없다.
    fn margin(&mut self, above: f32) {
        if !self.first {
            self.y += above.max(self.gap);
        }
        self.first = false;
        self.gap = 0.0;
    }

    fn spans(&self, items: &[Inline], style: Style, out: &mut Vec<Span>) {
        let plain = |text: &str, kind: Kind| Span { text: text.to_string(), style, kind, target: None, image: None };
        // 보관함 안의 그림은 그 자리에 그리고, 찾을 수 없으면 그렇다고 적는다.
        let picture = |target: &str, alt: &str| match (self.image)(target) {
            Some(found) => Span { image: Some(found), ..plain(alt, Kind::Plain) },
            None => plain(&format!("그림을 찾을 수 없음: {target}"), Kind::Muted),
        };
        for item in items {
            match item {
                Inline::Text(text) => out.push(plain(text, Kind::Plain)),
                Inline::Code(text) => out.push(Span { style: Style { mono: true, ..style }, ..plain(text, Kind::Code) }),
                Inline::Strong(children) => self.spans(children, Style { bold: true, ..style }, out),
                Inline::Em(children) => self.spans(children, Style { italic: true, ..style }, out),
                Inline::Link { children, .. } => {
                    // 바깥 사이트로 가는 링크: 모양만 링크다 (프로그램이 브라우저의 탭을 열 수는 없다).
                    let from = out.len();
                    self.spans(children, style, out);
                    for span in &mut out[from..] {
                        if span.kind == Kind::Plain {
                            span.kind = Kind::Link;
                        }
                    }
                }
                // 바깥 사이트의 그림은 가져올 수 없다 (이 페이지는 다른 출처의 자원을 막아 둔 상태다). 설명만 보여 준다.
                Inline::Image { src, alt } if src.contains("://") => out.push(plain(if alt.is_empty() { src } else { alt }, Kind::Muted)),
                Inline::Image { src, alt } => out.push(picture(src, alt)),
                Inline::Wiki { target, label, embed: true } if markdown::is_image_name(target) => out.push(picture(target, label)),
                Inline::Wiki { target, label, .. } => {
                    let exists = vault::resolve_link(target, self.files).is_some();
                    out.push(Span { target: Some(Target::Link(target.clone())), ..plain(label, if exists { Kind::Link } else { Kind::Missing }) });
                }
                Inline::Tag(name) => out.push(Span { target: Some(Target::Tag(name.clone())), ..plain(&format!("#{name}"), Kind::Tag) }),
            }
        }
    }

    /// 토막의 글자 크기와, 양옆에 두는 여백
    fn metrics(kind: Kind, size: f32) -> (f32, f32) {
        match kind {
            Kind::Code => (size * 0.96, 5.0),
            Kind::Tag => (size * 0.92, 7.0),
            _ => (size, 0.0),
        }
    }

    /// 글을 폭에 맞춰 여러 줄로 나눠 그린다. `self.y`가 그린 만큼 내려간다.
    #[allow(clippy::too_many_arguments)]
    fn inline(&mut self, items: &[Inline], x: f32, width: f32, size: f32, line_h: f32, color: Color, base: Style) {
        let mut spans = Vec::new();
        self.spans(items, base, &mut spans);

        // 1. 줄을 나눌 수 있는 단위로 쪼갠다.
        let mut atoms: Vec<Atom> = Vec::new();
        for (i, span) in spans.iter().enumerate() {
            if matches!(span.kind, Kind::Code | Kind::Tag) || span.image.is_some() {
                atoms.push(Atom { span: i, text: span.text.clone(), space: false, w: 0.0 });
                continue;
            }
            let mut word = String::new();
            let flush = |word: &mut String, atoms: &mut Vec<Atom>| {
                if !word.is_empty() {
                    atoms.push(Atom { span: i, text: std::mem::take(word), space: false, w: 0.0 });
                }
            };
            for ch in span.text.chars() {
                if ch.is_whitespace() {
                    flush(&mut word, &mut atoms);
                    atoms.push(Atom { span: i, text: " ".into(), space: true, w: 0.0 });
                } else if breaks_anywhere(ch) {
                    flush(&mut word, &mut atoms);
                    atoms.push(Atom { span: i, text: ch.to_string(), space: false, w: 0.0 });
                } else {
                    word.push(ch);
                }
            }
            flush(&mut word, &mut atoms);
        }

        // 2. 폭을 잰다. 화면 쪽에 묻는 횟수를 줄이려고 같은 모양끼리 모아 한 번에 묻는다.
        let mut groups: HashMap<(u32, Style), Vec<usize>> = HashMap::new();
        for (i, atom) in atoms.iter().enumerate() {
            let span = &spans[atom.span];
            if span.image.is_some() {
                continue; // 그림의 폭은 재지 않아도 안다
            }
            groups.entry((Self::metrics(span.kind, size).0.to_bits(), span.style)).or_default().push(i);
        }
        for ((bits, style), members) in groups {
            let texts: Vec<&str> = members.iter().map(|&i| atoms[i].text.as_str()).collect();
            let widths = self.ui.widths_of(&texts, f32::from_bits(bits), style);
            for (i, w) in members.into_iter().zip(widths) {
                atoms[i].w = w + Self::metrics(spans[atoms[i].span].kind, size).1 * 2.0;
            }
        }

        // 3. 줄에 담는다.
        let mut lines: Vec<Vec<Seg>> = vec![Vec::new()];
        let mut at = 0.0;
        for atom in atoms {
            if let Some((_, natural_w, natural_h)) = &spans[atom.span].image {
                // 그림은 한 줄을 통째로 쓴다. 폭이 넘치면 비율을 지켜 줄인다.
                let w = natural_w.min(width).max(1.0);
                let h = natural_h * w / natural_w.max(1.0);
                if lines.last().is_some_and(|line| !line.is_empty()) {
                    lines.push(Vec::new());
                }
                lines.last_mut().expect("never empty").push(Seg { span: atom.span, x: 0.0, w, text: atom.text, image_h: Some(h) });
                lines.push(Vec::new());
                at = 0.0;
                continue;
            }
            let line = lines.last_mut().expect("never empty");
            if atom.space && line.is_empty() {
                continue; // 줄 머리의 공백은 버린다
            }
            if !atom.space && at + atom.w > width && !line.is_empty() {
                lines.push(Vec::new());
                at = 0.0;
            }
            let line = lines.last_mut().expect("never empty");
            let joins = !matches!(spans[atom.span].kind, Kind::Code | Kind::Tag);
            match line.last_mut() {
                Some(last) if last.span == atom.span && joins => {
                    last.text.push_str(&atom.text);
                    last.w += atom.w;
                }
                _ => line.push(Seg { span: atom.span, x: at, w: atom.w, text: atom.text, image_h: None }),
            }
            at += atom.w;
        }

        // 4. 그린다.
        let theme = self.ui.theme;
        let blank = lines.iter().all(|line| line.is_empty());
        for line in lines {
            // 그림 뒤에 남은 빈 줄은 자리를 차지하지 않는다 (아무것도 없는 문단만 한 줄을 쓴다).
            if line.is_empty() && !blank {
                continue;
            }
            let line_h = line.iter().find_map(|seg| seg.image_h).map_or(line_h, |h| h + IMAGE_GAP * 2.0);
            let (top, mid) = (self.y, self.y + line_h / 2.0);
            self.y += line_h;
            if !self.visible(top, line_h) {
                continue;
            }
            for seg in line {
                let span = &spans[seg.span];
                if let (Some((path, ..)), Some(h)) = (&span.image, seg.image_h) {
                    self.ui.f.image(x, top + IMAGE_GAP, seg.w, h, path);
                    continue;
                }
                let (seg_size, pad) = Self::metrics(span.kind, size);
                let rect = Rect::new(x + seg.x, mid - seg_size * 0.75, seg.w, seg_size * 1.5);
                let (ink, style) = match span.kind {
                    Kind::Plain => (color, span.style),
                    Kind::Muted => (theme.muted, span.style),
                    Kind::Link => (theme.accent, Style { underline: true, ..span.style }),
                    Kind::Missing => (theme.muted, Style { underline: true, ..span.style }),
                    Kind::Code => {
                        self.ui.f.rect(rect.x, rect.y, rect.w, rect.h, 4.0, theme.surface2);
                        (color, Style { strike: false, ..span.style })
                    }
                    Kind::Tag => {
                        self.ui.f.rect(rect.x, rect.y, rect.w, rect.h, rect.h / 2.0, theme.accent_soft);
                        (theme.accent, Style { strike: false, ..span.style })
                    }
                };
                self.ui.f.styled(x + seg.x + pad, mid, seg_size, ink, Align::Left, style, &seg.text);
                if let Some(target) = &span.target {
                    let role = if span.kind == Kind::Tag { Role::Button } else { Role::Link };
                    self.ui.target(rect, role, false, seg.text.trim(), (self.act)(target.clone()));
                }
            }
        }
    }

    fn list(&mut self, list: &List, x: f32, width: f32, level: usize, interactive: bool) {
        let theme = self.ui.theme;
        for (i, item) in list.items.iter().enumerate() {
            let (top, mid) = (self.y, self.y + LINE / 2.0);
            let item_x = x + INDENT;
            if self.visible(top, LINE) {
                match item.checked {
                    Some(checked) => {
                        // 체크 상자는 글머리 기호의 자리에 온다.
                        let b = Rect::new(item_x - 17.0, mid - 6.5, 13.0, 13.0);
                        if checked {
                            self.ui.f.rect(b.x, b.y, b.w, b.h, 3.0, theme.accent);
                            self.ui.f.line(&[(b.x + 3.0, b.y + 6.8), (b.x + 5.6, b.y + 9.4), (b.x + 10.0, b.y + 4.0)], theme.surface, 1.6);
                        } else {
                            self.ui.f.rect(b.x, b.y, b.w, b.h, 3.0, theme.surface);
                            self.ui.f.frame(b.x, b.y, b.w, b.h, 3.0, theme.line_strong, 1.0);
                        }
                        if interactive {
                            self.ui.target(b, Role::Checkbox, checked, "완료", (self.act)(Target::Toggle(item.line)));
                        } else {
                            self.ui.f.region(b.x, b.y, b.w, b.h, Role::Checkbox, checked, true, "완료");
                        }
                    }
                    None if list.ordered => {
                        self.ui.f.styled(item_x - 6.0, mid, SIZE, theme.text, Align::Right, Style::PLAIN, &format!("{}.", i + 1));
                    }
                    None => {
                        self.ui.f.circle(item_x - 10.0, mid, 2.4, theme.text);
                        // 안쪽 목록의 글머리는 속이 빈 동그라미다.
                        if level > 0 {
                            self.ui.f.circle(item_x - 10.0, mid, 1.4, theme.surface);
                        }
                    }
                }
            }
            // 체크된 항목만 흐리게 긋는다. 그 아래에 들여 쓴 항목들은 각자의 체크를 따른다.
            let done = item.checked == Some(true);
            let (color, style) = if done { (theme.muted, Style { strike: true, ..Style::PLAIN }) } else { (theme.text, Style::PLAIN) };
            self.inline(&item.children, item_x, (width - INDENT).max(40.0), SIZE, LINE, color, style);
            if let Some(sub) = &item.sub {
                self.list(sub, item_x, (width - INDENT).max(40.0), level + 1, interactive);
            }
        }
    }

    fn table(&mut self, head: &[Vec<Inline>], rows: &[Vec<Vec<Inline>>], x: f32, width: f32) {
        let theme = self.ui.theme;
        let columns = head.len().max(1);
        // 칸의 폭: 내용이 한 줄에 다 들어가는 폭을 재고, 표가 넘치면 같은 비율로 줄인다.
        let mut natural = vec![0f32; columns];
        let was_drawing = std::mem::replace(&mut self.draw, false);
        let y = self.y;
        for (bold, row) in std::iter::once((true, head)).chain(rows.iter().map(|row| (false, row.as_slice()))) {
            for (i, cell) in row.iter().take(columns).enumerate() {
                let mut spans = Vec::new();
                self.spans(cell, Style { bold, ..Style::PLAIN }, &mut spans);
                let mut w = 0.0;
                for span in &spans {
                    let (size, pad) = Self::metrics(span.kind, SIZE);
                    w += self.ui.width(&span.text, size, span.style) + pad * 2.0;
                }
                natural[i] = natural[i].max(w + 1.0);
            }
        }
        (self.draw, self.y) = (was_drawing, y);
        const CELL_PAD: f32 = 10.0;
        let total: f32 = natural.iter().map(|w| w + CELL_PAD * 2.0).sum();
        let scale = if total > width { width / total } else { 1.0 };
        let widths: Vec<f32> = natural.iter().map(|w| ((w + CELL_PAD * 2.0) * scale).max(30.0)).collect();
        let table_w: f32 = widths.iter().sum();

        let table_top = self.y;
        for (is_head, row) in std::iter::once((true, head)).chain(rows.iter().map(|row| (false, row.as_slice()))) {
            let top = self.y;
            // 칸의 높이는 내용이 가장 긴 칸을 따른다. 머리줄의 바탕을 먼저 깔아야 하므로 한 번은 재기만 한다.
            for pass in 0..2 {
                let was_drawing = self.draw;
                self.draw = was_drawing && pass == 1;
                let mut bottom = top + LINE + 8.0;
                let mut cell_x = x;
                for (i, w) in widths.iter().enumerate() {
                    self.y = top + 4.0;
                    if let Some(cell) = row.get(i) {
                        self.inline(cell, cell_x + CELL_PAD, (w - CELL_PAD * 2.0).max(10.0), SIZE, LINE, theme.text, Style { bold: is_head, ..Style::PLAIN });
                    }
                    bottom = bottom.max(self.y + 4.0);
                    cell_x += w;
                }
                self.draw = was_drawing;
                self.y = bottom;
                if pass == 0 && is_head && self.visible(top, bottom - top) {
                    self.ui.f.rect(x, top, table_w, bottom - top, 0.0, theme.surface2);
                }
            }
            if self.visible(self.y - 1.0, 1.0) {
                self.ui.f.rect(x, self.y - 1.0, table_w, 1.0, 0.0, theme.line);
            }
        }
        // 바깥 테두리와 칸 사이의 세로줄
        if self.visible(table_top, self.y - table_top) {
            self.ui.f.rect(x, table_top, table_w, 1.0, 0.0, theme.line);
            let mut line_x = x;
            for w in std::iter::once(&0.0).chain(widths.iter()) {
                line_x += w;
                self.ui.f.rect(line_x.min(x + table_w - 1.0), table_top, 1.0, self.y - table_top, 0.0, theme.line);
            }
        }
    }

    fn blocks(&mut self, blocks: &[Block], x: f32, width: f32, depth: usize, interactive: bool) {
        let theme = self.ui.theme;
        for block in blocks {
            match block {
                Block::Heading { level, children, line } => {
                    let size = HEADING_SIZES[(level - 1).min(5)];
                    self.margin(size * 1.4);
                    if depth == 0 {
                        self.headings.push((*line, self.y));
                    }
                    self.inline(children, x, width, size, (size * 1.3).round(), theme.text, Style::BOLD);
                    self.gap = size * 0.5;
                }
                Block::Paragraph(children) => {
                    self.margin(0.0);
                    self.inline(children, x, width, SIZE, LINE, theme.text, Style::PLAIN);
                    self.gap = GAP;
                }
                Block::Quote(children) => {
                    self.margin(0.0);
                    let top = self.y;
                    self.inline(children, x + 15.0, (width - 15.0).max(40.0), SIZE, LINE, theme.muted, Style::PLAIN);
                    if self.visible(top, self.y - top) {
                        self.ui.f.rect(x, top, 3.0, self.y - top, 0.0, theme.line_strong);
                    }
                    self.gap = GAP;
                }
                Block::Code { text, .. } => {
                    self.margin(0.0);
                    let lines: Vec<&str> = text.split('\n').collect();
                    let h = lines.len() as f32 * CODE_LINE + 20.0;
                    if self.visible(self.y, h) {
                        self.ui.f.rect(x, self.y, width, h, 10.0, theme.surface2);
                        // 긴 줄은 블록 안에서 잘린다.
                        self.ui.f.clip(x, self.y, width - 6.0, h);
                        for (i, line) in lines.iter().enumerate() {
                            let mid = self.y + 10.0 + i as f32 * CODE_LINE + CODE_LINE / 2.0;
                            if self.visible(mid - CODE_LINE / 2.0, CODE_LINE) {
                                self.ui.f.styled(x + 12.0, mid, CODE_SIZE, theme.text, Align::Left, Style::MONO, &line.replace('\t', "  "));
                            }
                        }
                        self.ui.f.unclip();
                    }
                    self.y += h;
                    self.gap = GAP;
                }
                Block::List(list) => {
                    self.margin(0.0);
                    self.list(list, x, width, 0, interactive);
                    self.gap = GAP;
                }
                Block::Rule => {
                    self.margin(18.0);
                    if self.visible(self.y, 1.0) {
                        self.ui.f.rect(x, self.y, width, 1.0, 0.0, theme.line);
                    }
                    self.y += 1.0;
                    self.gap = 18.0;
                }
                Block::Table { head, rows } => {
                    self.margin(0.0);
                    self.table(head, rows, x, width);
                    self.gap = GAP;
                }
                Block::Embed { target, label } => {
                    self.margin(0.0);
                    let body = vault::resolve_link(target, self.files)
                        .filter(|path| vault::kind_of(path) == vault::Kind::Note)
                        .and_then(|path| self.texts.get(path))
                        .filter(|_| depth < EMBED_DEPTH);
                    let Some(body) = body else {
                        // 넣을 메모가 없으면 보통의 링크로 보여 준다.
                        let link = [Inline::Wiki { target: target.clone(), label: label.clone(), embed: false }];
                        self.inline(&link, x, width, SIZE, LINE, theme.text, Style::PLAIN);
                        self.gap = GAP;
                        continue;
                    };
                    let inner = markdown::parse(body);
                    let title = [Inline::Wiki { target: target.clone(), label: label.clone(), embed: false }];
                    let top = self.y;
                    // 바탕을 먼저 깔아야 하므로, 한 번은 높이만 재고 다시 그린다.
                    for pass in 0..2 {
                        let drawing = self.draw && pass == 1;
                        let was_drawing = std::mem::replace(&mut self.draw, drawing);
                        self.y = top + 8.0;
                        self.inline(&title, x + 15.0, (width - 27.0).max(40.0), 12.0, 18.0, theme.text, Style::BOLD);
                        self.y += 6.0;
                        let was_first = std::mem::replace(&mut self.first, true);
                        // 넣어져 보이는 글에서는 체크를 누를 수 없다 (그 메모가 아니라 지금 메모를 고치게 되므로).
                        self.blocks(&inner, x + 15.0, (width - 27.0).max(40.0), depth + 1, false);
                        self.first = was_first;
                        // 마지막 블록의 아래 여백은 치지 않는다.
                        let bottom = self.y + 8.0;
                        self.gap = 0.0;
                        self.draw = was_drawing;
                        if pass == 0 && self.visible(top, bottom - top) {
                            self.ui.f.rect(x, top, width, bottom - top, RADIUS, theme.surface2);
                            self.ui.f.rect(x, top, 3.0, bottom - top, 0.0, theme.accent);
                        }
                        self.y = bottom;
                    }
                    self.gap = GAP;
                }
            }
        }
    }
}

use crate::ui::RADIUS;
