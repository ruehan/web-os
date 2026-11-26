//! 마크다운을 화면에 그릴 수 있는 구조로 해석한다. 자주 쓰는 문법을 다룬다:
//! 제목, 문단, 목록(체크 목록과 들여 쓴 목록 포함), 인용, 코드 블록, 표, 구분선,
//! 그리고 줄 안의 굵게·기울임·코드·링크·그림·[[메모 링크]]·#태그.
//! 화면 쪽 편집기의 해석기(src/ui/editor/markdown.ts)와 같은 규칙이다.

#[derive(Clone, PartialEq, Debug)]
pub enum Inline {
    Text(String),
    Code(String),
    Strong(Vec<Inline>),
    Em(Vec<Inline>),
    Link { href: String, children: Vec<Inline> },
    /// ![설명](주소)
    Image { src: String, alt: String },
    /// [[대상|표시]]: 다른 메모로 가는 링크. embed면 ![[대상]] 꼴로, 그 자리에 내용을 넣는다.
    Wiki { target: String, label: String, embed: bool },
    Tag(String),
}

#[derive(Clone, PartialEq, Debug)]
pub struct ListItem {
    pub children: Vec<Inline>,
    /// 체크 목록(- [ ] / - [x])이면 체크 여부
    pub checked: Option<bool>,
    /// 원문에서 이 항목이 있는 줄 (0부터). 체크를 눌렀을 때 그 줄을 고치는 데 쓴다.
    pub line: usize,
    /// 이 항목 아래에 들여 쓴 목록
    pub sub: Option<List>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct List {
    pub ordered: bool,
    pub items: Vec<ListItem>,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Block {
    /// line: 원문에서 이 제목이 있는 줄 (0부터)
    Heading { level: usize, children: Vec<Inline>, line: usize },
    Paragraph(Vec<Inline>),
    Code { text: String, lang: String },
    List(List),
    /// 한 줄에 ![[메모]]만 있는 경우: 그 자리에 그 메모의 내용을 넣는다.
    Embed { target: String, label: String },
    Quote(Vec<Inline>),
    Table { head: Vec<Vec<Inline>>, rows: Vec<Vec<Vec<Inline>>> },
    Rule,
}

const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];

/// 이름이 그림 파일의 것인가
pub fn is_image_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

/// [[대상#제목|표시]] 의 안쪽을 대상과 표시 이름으로 나눈다.
fn wikilink(inner: &str, embed: bool) -> Inline {
    let (before, label) = match inner.split_once('|') {
        Some((before, label)) => (before, label.trim()),
        None => (inner, inner.trim()),
    };
    let target = before.split('#').next().unwrap_or("").trim().to_string();
    let label = if label.is_empty() { target.clone() } else { label.to_string() };
    Inline::Wiki { target, label, embed }
}

/// 태그에 쓸 수 있는 글자 (첫 글자, 그 뒤)
fn tag_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

fn tag_rest(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '/' | '-')
}

/// s의 맨 앞에서 시작하는 태그(# 다음)의 길이. `before`는 # 바로 앞의 글자.
fn tag_len(s: &str, before: Option<char>) -> Option<usize> {
    if before.is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '#' | '&' | '/')) {
        return None;
    }
    let rest = s.strip_prefix('#')?;
    if !rest.chars().next().is_some_and(tag_start) {
        return None;
    }
    Some(1 + rest.find(|c| !tag_rest(c)).unwrap_or(rest.len()))
}

/// s가 `open`으로 시작하면, `close`가 나오기 전까지의 안쪽을 돌려준다. 안쪽에 `stop`의 글자가 있으면 안 된다.
fn enclosed<'a>(s: &'a str, open: &str, close: &str, stop: &[char]) -> Option<&'a str> {
    let rest = s.strip_prefix(open)?;
    let end = rest.find(close)?;
    let inner = &rest[..end];
    (!inner.is_empty() && !inner.contains(stop)).then_some(inner)
}

/// 눌렀을 때 바깥으로 나가도 안전한 주소인가
fn safe_link(href: &str) -> bool {
    let lower = href.to_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("mailto:")
}

/// s의 맨 앞에서 시작하는 서식을 찾는다: 그 조각과, 원문에서 차지한 길이.
/// 순서가 중요하다: 그림과 넣기를 링크보다 먼저 찾아야 느낌표가 떨어져 나가지 않는다.
fn inline_at(s: &str, before: Option<char>) -> Option<(Inline, usize)> {
    if let Some(code) = enclosed(s, "`", "`", &['\n']) {
        return Some((Inline::Code(code.to_string()), code.len() + 2));
    }
    if let Some(inner) = enclosed(s, "![[", "]]", &[']', '\n']) {
        return Some((wikilink(inner, true), inner.len() + 5));
    }
    if let Some(inner) = enclosed(s, "[[", "]]", &[']', '\n']) {
        return Some((wikilink(inner, false), inner.len() + 4));
    }
    // [글](주소) 꼴의 두 부분. 글은 비어 있어도 되는지(그림)를 호출하는 쪽이 정한다.
    let bracketed = |s: &str, open: &str| -> Option<(String, String, usize)> {
        let rest = s.strip_prefix(open)?;
        let end = rest.find(']')?;
        let label = &rest[..end];
        let after = rest[end + 1..].strip_prefix('(')?;
        let close = after.find(')')?;
        let href = &after[..close];
        (!label.contains('\n') && !href.contains(char::is_whitespace))
            .then(|| (label.to_string(), href.to_string(), open.len() + end + 2 + close + 1))
    };
    if let Some((alt, src, len)) = bracketed(s, "![") {
        return Some((Inline::Image { src, alt }, len));
    }
    if let Some(inner) = enclosed(s, "**", "**", &['\n']).filter(|inner| !inner.contains('*')) {
        return Some((Inline::Strong(parse_inline(inner)), inner.len() + 4));
    }
    for mark in ["*", "_"] {
        let found = enclosed(s, mark, mark, &['\n']).filter(|inner| !inner.starts_with(char::is_whitespace));
        if let Some(inner) = found {
            return Some((Inline::Em(parse_inline(inner)), inner.len() + 2));
        }
    }
    if let Some((label, href, len)) = bracketed(s, "[").filter(|(label, ..)| !label.is_empty()) {
        let piece = if safe_link(&href) { Inline::Link { href, children: parse_inline(&label) } } else { Inline::Text(label) };
        return Some((piece, len));
    }
    tag_len(s, before).map(|len| (Inline::Tag(s[1..len].to_string()), len))
}

pub fn parse_inline(text: &str) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    let mut plain = String::new();
    let mut at = 0;
    let mut before = None;
    while at < text.len() {
        let rest = &text[at..];
        let ch = rest.chars().next().expect("not at the end");
        // 서식은 이 글자들로만 시작한다.
        let found = if matches!(ch, '`' | '!' | '[' | '*' | '_' | '#') { inline_at(rest, before) } else { None };
        match found {
            Some((piece, len)) => {
                match piece {
                    // 링크로 만들지 않은 글은 앞뒤의 글과 합친다.
                    Inline::Text(text) => plain.push_str(&text),
                    piece => {
                        if !plain.is_empty() {
                            out.push(Inline::Text(std::mem::take(&mut plain)));
                        }
                        out.push(piece);
                    }
                }
                before = rest[..len].chars().next_back();
                at += len;
            }
            None => {
                plain.push(ch);
                before = Some(ch);
                at += ch.len_utf8();
            }
        }
    }
    if !plain.is_empty() {
        out.push(Inline::Text(plain));
    }
    out
}

/// 목록의 한 줄: (들여쓰기의 깊이, 순서 있는 목록인가, 내용)
fn list_item(line: &str) -> Option<(usize, bool, &str)> {
    let body = line.trim_start();
    // 탭은 공백 두 칸으로 친다.
    let indent = line[..line.len() - body.len()].chars().map(|c| if c == '\t' { 2 } else { 1 }).sum();
    let (ordered, rest) = match body.chars().next()? {
        '-' | '*' | '+' => (false, &body[1..]),
        c if c.is_ascii_digit() => (true, body.trim_start_matches(|c: char| c.is_ascii_digit()).strip_prefix('.')?),
        _ => return None,
    };
    let content = rest.trim_start();
    (content.len() < rest.len()).then_some((indent, ordered, content))
}

/// 체크 목록의 내용: (체크 여부, 글)
fn task(content: &str) -> Option<(bool, &str)> {
    let checked = match content.get(..3)? {
        "[ ]" => false,
        "[x]" | "[X]" => true,
        _ => return None,
    };
    let rest = &content[3..];
    let text = rest.trim_start();
    (text.len() < rest.len()).then_some((checked, text))
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    let rest = &line[level..];
    if !(1..=6).contains(&level) || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some((level, rest.trim().trim_end_matches('#').trim_end()))
}

fn is_rule(line: &str) -> bool {
    let line = line.trim();
    line.len() >= 3 && ["-", "*", "_"].iter().any(|mark| line.chars().all(|c| mark.starts_with(c)))
}

fn is_table_row(line: &str) -> bool {
    let line = line.trim();
    line.len() >= 2 && line.starts_with('|') && line.ends_with('|')
}

/// 표의 머리줄 아래에 오는 |---|:--:| 꼴의 줄인가
fn is_table_rule(line: &str) -> bool {
    let line = line.trim();
    let line = line.strip_prefix('|').unwrap_or(line);
    let line = line.strip_suffix('|').unwrap_or(line);
    line.split('|').all(|cell| {
        let cell = cell.trim();
        let dashes = cell.strip_prefix(':').unwrap_or(cell);
        let dashes = dashes.strip_suffix(':').unwrap_or(dashes);
        !dashes.is_empty() && dashes.bytes().all(|b| b == b'-')
    })
}

/// 표의 한 줄을 칸으로 나눈다. 양 끝의 | 는 떼고, \| 는 글자로 본다.
fn cells(line: &str) -> Vec<Vec<Inline>> {
    let line = line.trim();
    let line = line.strip_prefix('|').unwrap_or(line);
    let line = line.strip_suffix('|').unwrap_or(line);
    let mut out = vec![String::new()];
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if chars.peek() == Some(&'|') => {
                chars.next();
                out.last_mut().expect("never empty").push('|');
            }
            '|' => out.push(String::new()),
            ch => out.last_mut().expect("never empty").push(ch),
        }
    }
    out.iter().map(|cell| parse_inline(cell.trim())).collect()
}

fn fence(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix("```")?;
    Some(rest.split_whitespace().next().unwrap_or(""))
}

/// 이만큼 더 들여 쓰면 아래 단계의 목록으로 본다.
const SUB_INDENT: usize = 2;

/// i번째 줄에서 시작하는 목록을 읽는다. 같은 깊이의 항목이 이어지는 동안 모으고,
/// 더 깊이 들여 쓴 항목들은 바로 앞 항목의 아래 목록으로 넣는다. 읽은 다음 줄의 번호를 함께 돌려준다.
fn read_list(lines: &[&str], start: usize) -> (List, usize) {
    let (base, ordered, _) = list_item(lines[start]).expect("starts at a list item");
    let mut items: Vec<ListItem> = Vec::new();
    let mut i = start;
    while i < lines.len() {
        let Some((depth, numbered, content)) = list_item(lines[i]) else { break };
        if depth >= base + SUB_INDENT && !items.is_empty() {
            let (sub, after) = read_list(lines, i);
            items.last_mut().expect("not empty").sub = Some(sub);
            i = after;
            continue;
        }
        // 덜 들여 쓴 줄은 바깥 목록의 것이고, 표시의 종류가 바뀌면 다른 목록이다.
        if depth < base || numbered != ordered {
            break;
        }
        let (checked, text) = match task(content) {
            Some((checked, text)) => (Some(checked), text),
            None => (None, content),
        };
        items.push(ListItem { children: parse_inline(text), checked, line: i, sub: None });
        i += 1;
    }
    (List { ordered, items }, i)
}

pub fn parse(text: &str) -> Vec<Block> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut blocks = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    fn flush(paragraph: &mut Vec<&str>, blocks: &mut Vec<Block>) {
        if paragraph.is_empty() {
            return;
        }
        let mut children = parse_inline(&paragraph.join(" "));
        paragraph.clear();
        // 한 줄에 메모 넣기(![[메모]])만 있으면 문단이 아니라 넣기 블록이다. 그림은 줄 안에 그대로 둔다.
        match children.as_slice() {
            [Inline::Wiki { target, embed: true, .. }] if !is_image_name(target) => {
                let Some(Inline::Wiki { target, label, .. }) = children.pop() else { unreachable!() };
                blocks.push(Block::Embed { target, label });
            }
            _ => blocks.push(Block::Paragraph(children)),
        }
    }

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(lang) = fence(line) {
            flush(&mut paragraph, &mut blocks);
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() && fence(lines[i]).is_none() {
                body.push(lines[i]);
                i += 1;
            }
            blocks.push(Block::Code { text: body.join("\n"), lang: lang.to_string() });
        } else if let Some((level, title)) = heading(line) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Heading { level, children: parse_inline(title), line: i });
        } else if is_rule(line) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Rule);
        } else if is_table_row(line) && lines.get(i + 1).is_some_and(|next| is_table_rule(next)) {
            // 표: 머리줄 바로 아래에 |---|---| 꼴의 줄이 있어야 표로 본다.
            flush(&mut paragraph, &mut blocks);
            let head = cells(line);
            let mut rows = Vec::new();
            i += 2;
            while i < lines.len() && is_table_row(lines[i]) {
                rows.push(cells(lines[i]));
                i += 1;
            }
            blocks.push(Block::Table { head, rows });
            continue;
        } else if line.trim_start().starts_with('>') {
            flush(&mut paragraph, &mut blocks);
            let mut body = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                let rest = &lines[i].trim_start()[1..];
                body.push(rest.strip_prefix(char::is_whitespace).unwrap_or(rest));
                i += 1;
            }
            blocks.push(Block::Quote(parse_inline(&body.join(" "))));
            continue;
        } else if list_item(line).is_some() {
            flush(&mut paragraph, &mut blocks);
            let (list, after) = read_list(&lines, i);
            blocks.push(Block::List(list));
            i = after;
            continue;
        } else if line.trim().is_empty() {
            flush(&mut paragraph, &mut blocks);
        } else {
            paragraph.push(line.trim());
        }
        i += 1;
    }
    flush(&mut paragraph, &mut blocks);
    blocks
}

/// 체크 목록의 한 줄에서 체크를 뒤집은 글을 돌려준다. 그 줄이 체크 목록이 아니면 그대로다.
pub fn toggle_task(text: &str, line: usize) -> String {
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if let Some(current) = lines.get_mut(line) {
        if let Some((_, _, content)) = list_item(current) {
            if let Some((checked, _)) = task(content) {
                let at = current.len() - content.len() + 1;
                current.replace_range(at..at + 1, if checked { " " } else { "x" });
            }
        }
    }
    lines.join("\n")
}

/// 편집 화면에서 색을 달리 보여 줄 조각의 종류
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Token {
    Heading,
    Quote,
    /// 목록의 표시 (-, 1.)
    Mark,
    Code,
    /// 링크, 메모 링크, 그림
    Link,
    Emphasis,
}

/// 원문에서 색을 입힐 범위들 (시작, 끝, 종류). 자리는 바이트 위치이고, 앞에서부터 겹치지 않게 나온다.
/// 줄 단위로 본다: 제목, 인용, 목록, 코드 블록을 가리고, 줄 안에서는 강조와 링크를 찾는다.
pub fn highlight(text: &str) -> Vec<(usize, usize, Token)> {
    let mut out = Vec::new();
    let mut fenced = false;
    let mut start = 0;
    for line in text.split('\n') {
        let end = start + line.len();
        let whole = |token| (start, end, token);
        if fence(line).is_some() {
            fenced = !fenced;
            out.push(whole(Token::Code));
        } else if fenced {
            out.push(whole(Token::Code));
        } else if heading(line).is_some() {
            out.push(whole(Token::Heading));
        } else if line.trim_start().starts_with('>') {
            out.push(whole(Token::Quote));
        } else {
            // 목록의 표시까지, 그리고 그 뒤의 줄 안 서식들
            let mut at = match list_item(line) {
                Some((_, _, content)) => {
                    let marker = line.len() - content.len();
                    out.push((start, start + marker, Token::Mark));
                    marker
                }
                None => 0,
            };
            let mut before = line[..at].chars().next_back();
            while at < line.len() {
                let rest = &line[at..];
                let ch = rest.chars().next().expect("not at the end");
                let found = if matches!(ch, '`' | '!' | '[' | '*' | '_') { inline_at(rest, before) } else { None };
                let step = match found {
                    Some((piece, len)) => {
                        let token = match piece {
                            Inline::Code(_) => Some(Token::Code),
                            Inline::Strong(_) | Inline::Em(_) => Some(Token::Emphasis),
                            Inline::Wiki { .. } | Inline::Image { .. } | Inline::Link { .. } | Inline::Text(_) => Some(Token::Link),
                            Inline::Tag(_) => None,
                        };
                        if let Some(token) = token {
                            out.push((start + at, start + at + len, token));
                        }
                        len
                    }
                    None => ch.len_utf8(),
                };
                before = rest[..step].chars().next_back();
                at += step;
            }
        }
        start = end + 1;
    }
    out.retain(|(from, to, _)| to > from);
    out
}

/// 코드(``` 블록과 `줄 안 코드`)를 뺀 글. 코드 안의 #이나 [[ ]]는 태그나 링크가 아니다.
pub fn without_code(text: &str) -> String {
    let mut out = String::new();
    let mut fenced = false;
    for line in text.split('\n') {
        if fence(line).is_some() {
            fenced = !fenced;
        } else if !fenced {
            let mut parts = line.split('`');
            // 짝이 맞는 ` 사이는 뺀다.
            while let Some(outside) = parts.next() {
                out.push_str(outside);
                match (parts.next(), parts.clone().next()) {
                    (Some(_), Some(_)) => {}
                    (Some(unclosed), None) => out.push_str(unclosed),
                    (None, _) => {}
                }
            }
        }
        out.push('\n');
    }
    out
}

/// 메모에 든 태그들 (# 없이, 중복 없이, 나온 순서대로)
pub fn tags_of(text: &str) -> Vec<String> {
    let text = without_code(text);
    let mut out: Vec<String> = Vec::new();
    let mut before = None;
    let mut at = 0;
    while at < text.len() {
        let ch = text[at..].chars().next().expect("not at the end");
        match if ch == '#' { tag_len(&text[at..], before) } else { None } {
            Some(len) => {
                let tag = &text[at + 1..at + len];
                if !out.iter().any(|t| t == tag) {
                    out.push(tag.to_string());
                }
                before = tag.chars().next_back();
                at += len;
            }
            None => {
                before = Some(ch);
                at += ch.len_utf8();
            }
        }
    }
    out
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Heading {
    pub level: usize,
    pub title: String,
    /// 원문에서의 줄 (0부터)
    pub line: usize,
}

/// 메모의 제목 줄들 (목차)
pub fn outline_of(text: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut fenced = false;
    for (line, content) in text.split('\n').enumerate() {
        if fence(content).is_some() {
            fenced = !fenced;
        } else if !fenced {
            if let Some((level, title)) = heading(content).filter(|(_, title)| !title.is_empty()) {
                out.push(Heading { level, title: title.to_string(), line });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Inline {
        Inline::Text(s.to_string())
    }

    #[test]
    fn reads_inline_marks() {
        assert_eq!(
            parse_inline("가 **굵게** *기울임* _또_ `코드 *그대로*` 끝"),
            [
                text("가 "),
                Inline::Strong(vec![text("굵게")]),
                text(" "),
                Inline::Em(vec![text("기울임")]),
                text(" "),
                Inline::Em(vec![text("또")]),
                text(" "),
                Inline::Code("코드 *그대로*".into()),
                text(" 끝"),
            ]
        );
        // 짝이 없는 기호는 글자 그대로다.
        assert_eq!(parse_inline("2 * 3 = 6, a_b"), [text("2 * 3 = 6, a_b")]);
    }

    #[test]
    fn reads_links_images_and_tags() {
        assert_eq!(
            parse_inline("[[회의]] [[폴더/계획#목표|계획 보기]] ![[그림.png]]"),
            [
                Inline::Wiki { target: "회의".into(), label: "회의".into(), embed: false },
                text(" "),
                Inline::Wiki { target: "폴더/계획".into(), label: "계획 보기".into(), embed: false },
                text(" "),
                Inline::Wiki { target: "그림.png".into(), label: "그림.png".into(), embed: true },
            ]
        );
        assert_eq!(
            parse_inline("[사이트](https://example.com) [위험](javascript:x) ![설명](a.png)"),
            [
                Inline::Link { href: "https://example.com".into(), children: vec![text("사이트")] },
                text(" 위험 "),
                Inline::Image { src: "a.png".into(), alt: "설명".into() },
            ]
        );
        assert_eq!(parse_inline("#업무 끝#아님 a#b #2024 #일/회의"), [Inline::Tag("업무".into()), text(" 끝#아님 a#b #2024 "), Inline::Tag("일/회의".into())]);
    }

    #[test]
    fn reads_blocks() {
        let blocks = parse("# 제목 #\n\n첫 줄\n둘째 줄\n\n> 인용\n> 계속\n\n---\n\n```rust\nlet a = 1;\n# 제목 아님\n```\n\n![[다른 메모]]\n\n![[그림.png]]");
        assert_eq!(blocks[0], Block::Heading { level: 1, children: vec![text("제목")], line: 0 });
        assert_eq!(blocks[1], Block::Paragraph(vec![text("첫 줄 둘째 줄")]));
        assert_eq!(blocks[2], Block::Quote(vec![text("인용 계속")]));
        assert_eq!(blocks[3], Block::Rule);
        assert_eq!(blocks[4], Block::Code { text: "let a = 1;\n# 제목 아님".into(), lang: "rust".into() });
        assert_eq!(blocks[5], Block::Embed { target: "다른 메모".into(), label: "다른 메모".into() });
        assert!(matches!(&blocks[6], Block::Paragraph(items) if matches!(items[0], Inline::Wiki { embed: true, .. })));
        assert_eq!(blocks.len(), 7);
    }

    #[test]
    fn reads_nested_and_task_lists() {
        let blocks = parse("- [ ] 할 일\n  - [x] 끝낸 일\n  - 그냥\n- 둘째\n1. 하나\n2. 둘");
        let Block::List(list) = &blocks[0] else { panic!("not a list") };
        assert!(!list.ordered);
        assert_eq!((list.items.len(), list.items[0].checked, list.items[0].line), (2, Some(false), 0));
        let sub = list.items[0].sub.as_ref().expect("a nested list");
        assert_eq!((sub.items[0].checked, sub.items[0].line, sub.items[1].checked), (Some(true), 1, None));
        assert!(matches!(&blocks[1], Block::List(List { ordered: true, items }) if items.len() == 2));
    }

    #[test]
    fn reads_tables() {
        let blocks = parse("| 이름 | 값 |\n|---|:-:|\n| a\\|b | **1** |\n| c | 2 |\n끝");
        let Block::Table { head, rows } = &blocks[0] else { panic!("not a table") };
        assert_eq!(head, &[vec![text("이름")], vec![text("값")]]);
        assert_eq!(rows[0], [vec![text("a|b")], vec![Inline::Strong(vec![text("1")])]]);
        assert_eq!(rows.len(), 2);
        assert_eq!(blocks[1], Block::Paragraph(vec![text("끝")]));
        // 아래에 구분 줄이 없으면 표가 아니다.
        assert!(matches!(parse("| a | b |")[0], Block::Paragraph(_)));
    }

    #[test]
    fn marks_what_to_color_in_the_source() {
        let text = "# 제목\n- **굵게** `코드` [[링크]]\n> 인용\n```\n# 코드 안\n```\n그냥 #태그";
        let got: Vec<(&str, Token)> = highlight(text).into_iter().map(|(from, to, token)| (&text[from..to], token)).collect();
        assert_eq!(
            got,
            [
                ("# 제목", Token::Heading),
                ("- ", Token::Mark),
                ("**굵게**", Token::Emphasis),
                ("`코드`", Token::Code),
                ("[[링크]]", Token::Link),
                ("> 인용", Token::Quote),
                ("```", Token::Code),
                ("# 코드 안", Token::Code),
                ("```", Token::Code),
            ]
        );
        assert!(highlight("").is_empty());
    }

    #[test]
    fn toggles_tasks() {
        let text = "- [ ] 하나\n  1. [x] 둘\n- 셋";
        assert_eq!(toggle_task(text, 0), "- [x] 하나\n  1. [x] 둘\n- 셋");
        assert_eq!(toggle_task(text, 1), "- [ ] 하나\n  1. [ ] 둘\n- 셋");
        assert_eq!(toggle_task(text, 2), text);
        assert_eq!(toggle_task(text, 9), text);
    }

    #[test]
    fn finds_tags_and_headings_outside_code() {
        let text = "# 계획 #업무\n`#코드` #업무 #개인\n```\n# 아님 #아님\n```\n## 둘째 ##\n#";
        assert_eq!(tags_of(text), ["업무", "개인"]);
        assert_eq!(
            outline_of(text),
            [Heading { level: 1, title: "계획 #업무".into(), line: 0 }, Heading { level: 2, title: "둘째".into(), line: 5 }]
        );
    }
}
