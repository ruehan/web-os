//! 메모를 쓸 때의 편의 동작: 목록에서 Enter를 치면 다음 항목이 이어지고, Tab으로 들여 쓴다.
//! 글과 커서 위치(바이트)를 받아 바뀐 글과 커서 위치를 돌려주는 계산만 한다.
//! 화면 쪽 메모 앱의 것(src/ui/notes/editing.ts)과 같은 규칙이다.

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Edit {
    pub text: String,
    /// 바뀐 뒤의 선택 범위 (커서만 있으면 둘이 같다)
    pub start: usize,
    pub end: usize,
}

const INDENT: &str = "  ";

fn line_start(text: &str, pos: usize) -> usize {
    text[..pos].rfind('\n').map_or(0, |at| at + 1)
}

fn line_end(text: &str, pos: usize) -> usize {
    text[pos..].find('\n').map_or(text.len(), |at| pos + at)
}

/// 목록의 한 줄을 나눈다: 들여쓰기, 목록 표시(- * + 또는 1.), 체크 상자("[ ] "), 내용
fn list_line(line: &str) -> Option<(&str, &str, Option<&str>, &str)> {
    let body = line.trim_start();
    let indent = &line[..line.len() - body.len()];
    let marker_len = match body.chars().next()? {
        '-' | '*' | '+' => 1,
        c if c.is_ascii_digit() => {
            let digits = body.bytes().take_while(u8::is_ascii_digit).count();
            if body.as_bytes().get(digits) != Some(&b'.') {
                return None;
            }
            digits + 1
        }
        _ => return None,
    };
    let (marker, rest) = body.split_at(marker_len);
    let after = rest.trim_start();
    if after.len() == rest.len() {
        return None; // 표시 뒤에 공백이 있어야 목록이다
    }
    let boxed = matches!(after.get(..3), Some("[ ]" | "[x]" | "[X]"));
    let content = if boxed { after[3..].trim_start() } else { after };
    if boxed && content.len() < after.len() - 3 {
        return Some((indent, marker, Some(&after[..after.len() - content.len()]), content));
    }
    Some((indent, marker, None, after))
}

/// 목록 항목에서 Enter를 쳤을 때. 목록이 아니면 `None` (보통의 줄바꿈에 맡긴다).
///  - 내용이 있는 항목: 같은 들여쓰기와 표시로 다음 항목을 시작한다. 번호 목록은 번호를 하나 올리고, 체크 목록은 빈 상자로 시작한다.
///  - 내용이 없는 항목: 목록을 끝낸다 (표시를 지운다). 들여 쓴 항목이면 한 단계 내어 쓴다.
pub fn continue_list(text: &str, pos: usize) -> Option<Edit> {
    let (from, to) = (line_start(text, pos), line_end(text, pos));
    let (indent, marker, task, content) = list_line(&text[from..to])?;
    // 표시 앞이나 한가운데에서 친 Enter는 보통의 줄바꿈이다.
    if pos < from + indent.len() + marker.len() + 1 {
        return None;
    }
    if content.trim().is_empty() {
        let kept = match indent.strip_prefix(INDENT) {
            Some(less) => format!("{less}{marker} {}", task.unwrap_or("")),
            None => String::new(),
        };
        let at = from + kept.len();
        return Some(Edit { text: format!("{}{kept}{}", &text[..from], &text[to..]), start: at, end: at });
    }
    let next_marker = match marker.strip_suffix('.').and_then(|n| n.parse::<u64>().ok()) {
        Some(number) => format!("{}.", number + 1),
        None => marker.to_string(),
    };
    let insert = format!("\n{indent}{next_marker} {}", if task.is_some() { "[ ] " } else { "" });
    let at = pos + insert.len();
    Some(Edit { text: format!("{}{insert}{}", &text[..pos], &text[pos..]), start: at, end: at })
}

/// Tab / Shift+Tab. 선택한 줄들(또는 커서가 있는 목록 항목)을 한 단계 들여 쓰거나 내어 쓴다.
/// 목록도 아니고 여러 줄을 고른 것도 아니면, Tab은 그 자리에 공백 두 칸을 넣는다.
pub fn indent(text: &str, start: usize, end: usize, outdent: bool) -> Edit {
    let (from, to) = (line_start(text, start), line_end(text, end));
    let block = &text[from..to];
    if !block.contains('\n') && !outdent && list_line(block).is_none() {
        let at = start + INDENT.len();
        return Edit { text: format!("{}{INDENT}{}", &text[..start], &text[end..]), start: at, end: at };
    }
    let (mut first, mut total) = (0isize, 0isize);
    let lines: Vec<String> = block
        .split('\n')
        .enumerate()
        .map(|(i, line)| {
            let (delta, changed) = if outdent {
                let removable = if line.starts_with('\t') { 1 } else { line.bytes().take(2).take_while(|b| *b == b' ').count() };
                (-(removable as isize), line[removable..].to_string())
            } else if line.trim().is_empty() {
                (0, line.to_string()) // 빈 줄은 들여 쓰지 않는다 (줄 끝 공백이 생기지 않게)
            } else {
                (INDENT.len() as isize, format!("{INDENT}{line}"))
            };
            if i == 0 {
                first = delta;
            }
            total += delta;
            changed
        })
        .collect();
    let shifted = |pos: usize, by: isize| pos.saturating_add_signed(by).max(from);
    Edit { text: format!("{}{}{}", &text[..from], lines.join("\n"), &text[to..]), start: shifted(start, first), end: shifted(end, total) }
}

/// 고른 글을 앞뒤 기호로 감싼다 (굵게, 기울임, 링크). 감싼 안쪽이 고른 채로 남는다.
pub fn wrap(text: &str, start: usize, end: usize, before: &str, after: &str) -> Edit {
    Edit {
        text: format!("{}{before}{}{after}{}", &text[..start], &text[start..end], &text[end..]),
        start: start + before.len(),
        end: end + before.len(),
    }
}

/// 커서가 닫히지 않은 `[[` 안에 있으면, 그 안쪽이 시작하는 자리와 지금까지 친 글자
pub fn open_link(text: &str, pos: usize) -> Option<(usize, &str)> {
    let before = text.get(..pos)?;
    let from = before.rfind("[[")? + 2;
    let typed = &before[from..];
    (!typed.contains(['[', ']', '\n', '|', '#'])).then_some((from, typed))
}

/// `[[` 뒤에 친 글자를 `name`으로 바꿔 링크를 완성한다. 뒤에 이미 `]]`가 있으면 다시 붙이지 않는다.
pub fn complete_link(text: &str, from: usize, pos: usize, name: &str) -> Edit {
    let closed = text[pos..].starts_with("]]");
    let at = from + name.len() + 2;
    Edit { text: format!("{}{name}{}{}", &text[..from], if closed { "" } else { "]]" }, &text[pos..]), start: at, end: at }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(text: &str, at: usize) -> Option<Edit> {
        Some(Edit { text: text.to_string(), start: at, end: at })
    }

    #[test]
    fn continues_lists_on_enter() {
        assert_eq!(continue_list("- 우유", 8), edit("- 우유\n- ", 11));
        assert_eq!(continue_list("  3. 셋", 8), edit("  3. 셋\n  4. ", 14));
        assert_eq!(continue_list("- [x] 한 일", 13), edit("- [x] 한 일\n- [ ] ", 20));
        // 줄의 가운데에서 치면 뒤쪽이 다음 항목으로 간다.
        assert_eq!(continue_list("* ab", 3), edit("* a\n* b", 6));
        // 목록이 아니거나, 표시 앞에서 친 것은 보통의 줄바꿈이다.
        assert_eq!(continue_list("그냥 글", 6), None);
        assert_eq!(continue_list("- 우유", 1), None);
        assert_eq!(continue_list("-우유", 7), None);
    }

    #[test]
    fn ends_the_list_on_an_empty_item() {
        assert_eq!(continue_list("- 우유\n- ", 11), edit("- 우유\n", 9));
        // 들여 쓴 항목은 한 단계 내어 쓴다.
        assert_eq!(continue_list("- a\n  - ", 8), edit("- a\n- ", 6));
        assert_eq!(continue_list("  - [ ] ", 8), edit("- [ ] ", 6));
    }

    #[test]
    fn indents_and_outdents() {
        assert_eq!(indent("- a", 3, 3, false), Edit { text: "  - a".into(), start: 5, end: 5 });
        assert_eq!(indent("  - a", 5, 5, true), Edit { text: "- a".into(), start: 3, end: 3 });
        // 여러 줄을 고르면 모두 옮긴다. 빈 줄은 그대로 둔다.
        assert_eq!(indent("a\n\nb", 0, 4, false), Edit { text: "  a\n\n  b".into(), start: 2, end: 8 });
        assert_eq!(indent("  a\n b\nc", 2, 7, true), Edit { text: "a\nb\nc".into(), start: 0, end: 4 });
        // 목록이 아닌 한 줄에서는 공백 두 칸을 넣는다.
        assert_eq!(indent("글", 3, 3, false), Edit { text: "글  ".into(), start: 5, end: 5 });
        assert_eq!(indent("글", 3, 3, true), Edit { text: "글".into(), start: 3, end: 3 });
    }

    #[test]
    fn wraps_the_selection() {
        assert_eq!(wrap("가 나 다", 4, 7, "**", "**"), Edit { text: "가 **나** 다".into(), start: 6, end: 9 });
        assert_eq!(wrap("ab", 1, 1, "[[", "]]"), Edit { text: "a[[]]b".into(), start: 3, end: 3 });
    }

    #[test]
    fn finds_and_completes_an_open_link() {
        assert_eq!(open_link("보기 [[회", 12), Some((9, "회")));
        assert_eq!(open_link("[[", 2), Some((2, "")));
        assert_eq!(open_link("[[회의]] 뒤", 13), None);
        assert_eq!(open_link("[[회의|보", 12), None);
        assert_eq!(open_link("그냥", 6), None);
        assert_eq!(complete_link("보기 [[회", 9, 12, "회의록"), Edit { text: "보기 [[회의록]]".into(), start: 20, end: 20 });
        // 뒤에 이미 ]]가 있으면 그 뒤로 커서만 옮긴다.
        assert_eq!(complete_link("[[회]] 끝", 2, 5, "회의록"), Edit { text: "[[회의록]] 끝".into(), start: 13, end: 13 });
    }
}
