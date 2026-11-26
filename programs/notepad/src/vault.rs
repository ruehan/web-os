//! 메모 보관함의 규칙: 어떤 파일이 메모이고 그림인지, [[링크]]가 어느 파일을 가리키는지,
//! 이름이 바뀌면 링크를 어떻게 고치는지. 화면이나 파일 접근 없이 글자만 다룬다.


/// 붙여 넣은 그림이 저장되는 폴더 (보관함 기준)
pub const ATTACHMENTS: &str = "attachments";

const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];

pub fn base_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..at])
}

/// 확장자 (소문자). 점으로 시작하는 이름의 그 점은 확장자의 시작이 아니다.
pub fn ext_of(path: &str) -> String {
    let name = base_of(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// 확장자를 뗀 파일 이름. 메모의 제목이다.
pub fn stem_of(path: &str) -> &str {
    let name = base_of(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Dir,
    Note,
    Image,
    Other,
}

pub fn kind_of(path: &str) -> Kind {
    let ext = ext_of(path);
    if ext == "md" || ext == "txt" {
        Kind::Note
    } else if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Kind::Image
    } else {
        Kind::Other
    }
}

/// 목록, 탭, 제목에 보이는 이름: 메모는 확장자를 뗀다.
pub fn shown(path: &str) -> &str {
    if kind_of(path) == Kind::Note {
        stem_of(path)
    } else {
        base_of(path)
    }
}

/// path가 dir 자신이거나 그 아래에 있는가
pub fn is_inside(path: &str, dir: &str) -> bool {
    dir.is_empty() || path == dir || (path.starts_with(dir) && path.as_bytes().get(dir.len()) == Some(&b'/'))
}

pub use webos::ui::natural_cmp;

/// 글에 든 [[링크]] 하나
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Link {
    /// 가리키는 대상: 메모 이름이나 보관함 기준 경로
    pub target: String,
    /// ![[...]] 꼴: 링크가 아니라 그 자리에 내용을 넣는다
    pub embed: bool,
    /// 글에서 링크 전체(!부터 ]]까지)의 자리
    pub start: usize,
    pub end: usize,
    /// 대상 부분의 자리 (다듬기 전)
    target_span: (usize, usize),
}

/// 글에 든 [[링크]]들. 표시 이름(|...)과 제목 위치(#...)는 떼고 대상만 돌려준다.
pub fn parse_links(text: &str) -> Vec<Link> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = text[at..].find("[[") {
        let open = at + found;
        let from = open + 2;
        let take = |start: usize, stop: &[u8]| start + bytes[start..].iter().position(|b| stop.contains(b)).unwrap_or(bytes.len() - start);
        let mut end = take(from, b"]|#\n");
        let target_end = end;
        if bytes.get(end) == Some(&b'#') {
            end = take(end + 1, b"]|\n");
        }
        if bytes.get(end) == Some(&b'|') {
            end = take(end + 1, b"]\n");
        }
        if target_end > from && text[end..].starts_with("]]") {
            let embed = open > 0 && bytes[open - 1] == b'!';
            out.push(Link {
                target: text[from..target_end].trim().to_string(),
                embed,
                start: open - embed as usize,
                end: end + 2,
                target_span: (from, target_end),
            });
            at = end + 2;
        } else {
            at = from;
        }
    }
    out
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn without_ext(path: &str) -> &str {
    let ext = ext_of(path);
    if ext.is_empty() {
        path
    } else {
        &path[..path.len() - ext.len() - 1]
    }
}

/// 링크가 가리키는 파일을 찾는다. 폴더를 적었으면 그 경로와 맞는 것을, 이름만 적었으면
/// 어느 폴더에 있든 이름이 같은 것을 고른다. 확장자는 생략할 수 있고 대소문자는 가리지 않는다.
/// 같은 이름이 여럿이면 메모가 그림보다 먼저고, 그다음은 경로가 짧은(위쪽 폴더의) 것이 이긴다.
pub fn resolve_link<'a>(target: &str, paths: &'a [String]) -> Option<&'a str> {
    let wanted = target.trim().trim_start_matches('/');
    if wanted.is_empty() {
        return None;
    }
    paths
        .iter()
        .map(String::as_str)
        .filter(|path| {
            if wanted.contains('/') {
                same(path, wanted) || same(without_ext(path), wanted)
            } else {
                same(base_of(path), wanted) || same(stem_of(path), wanted)
            }
        })
        .min_by(|a, b| {
            (kind_of(a) != Kind::Note).cmp(&(kind_of(b) != Kind::Note)).then(a.len().cmp(&b.len())).then(a.cmp(b))
        })
}

/// 파일 이름이 바뀌었을 때, 그 파일을 가리키던 링크를 새 이름으로 고친 글을 돌려준다.
/// 이름만 적었던 링크는 새 이름으로, 경로로 적었던 링크는 새 경로로 바꾼다. 표시 이름과 제목 위치는 그대로 둔다.
pub fn rename_links(text: &str, old_path: &str, new_path: &str, paths: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for link in parse_links(text) {
        let raw = &text[link.target_span.0..link.target_span.1];
        if resolve_link(raw, paths) != Some(old_path) {
            continue;
        }
        let renamed = if raw.contains('/') {
            if kind_of(new_path) == Kind::Note { without_ext(new_path) } else { new_path }
        } else {
            shown(new_path)
        };
        out.push_str(&text[copied..link.target_span.0]);
        out.push_str(renamed);
        copied = link.target_span.1;
    }
    out.push_str(&text[copied..]);
    out
}

/// 같은 폴더에 이미 있는 이름을 피해 "이름", "이름 2", "이름 3" … 중 비어 있는 것을 고른다.
pub fn unique_name(taken: &[&str], stem: &str, ext: &str) -> String {
    (1..)
        .map(|n| {
            let number = if n > 1 { format!(" {n}") } else { String::new() };
            let dot = if ext.is_empty() { "" } else { "." };
            format!("{stem}{number}{dot}{ext}")
        })
        .find(|name| !taken.iter().any(|t| same(t, name)))
        .expect("some name is free")
}

/// 파일 이름으로 쓸 수 없는 이름이면 그 이유
pub fn name_problem(name: &str) -> Option<&'static str> {
    if name.trim().is_empty() {
        Some("이름을 적어 주세요.")
    } else if name.contains(['/', '\\']) {
        Some("이름에는 / 와 \\ 를 쓸 수 없습니다.")
    } else if name.contains(['[', ']', '|', '#', '^']) {
        Some("이름에는 [ ] | # ^ 를 쓸 수 없습니다 (링크에서 특별한 뜻으로 쓰입니다).")
    } else if name.starts_with('.') {
        Some("이름은 점으로 시작할 수 없습니다.")
    } else {
        None
    }
}

/// 파일이나 폴더를 다른 폴더로 옮길 수 있는지 본다. 옮길 수 없으면 이유를, 옮길 필요가 없으면(이미 거기 있음)
/// 빈 문자열을 돌려준다. 옮길 수 있으면 `None`.
pub fn move_problem(path: &str, dest: &str, taken: &[&str]) -> Option<&'static str> {
    if dir_of(path) == dest {
        Some("")
    } else if !dest.is_empty() && is_inside(dest, path) {
        Some("폴더를 자기 자신 안으로 옮길 수는 없습니다.")
    } else if taken.iter().any(|name| same(name, base_of(path))) {
        Some("옮길 곳에 같은 이름이 이미 있습니다.")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn splits_paths() {
        assert_eq!((dir_of("a/b/c.md"), base_of("a/b/c.md"), stem_of("a/b/c.md"), ext_of("a/b/C.MD")), ("a/b", "c.md", "c", "md".to_string()));
        assert_eq!((dir_of("c"), stem_of(".숨김"), ext_of(".숨김")), ("", ".숨김", String::new()));
        assert!(is_inside("a/b", "a") && is_inside("a", "a") && !is_inside("ab", "a") && is_inside("x", ""));
    }

    #[test]
    fn orders_names_like_a_person() {
        let mut names = vec!["메모 10", "메모 2", "메모", "Beta", "alpha"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["메모", "메모 2", "메모 10", "alpha", "Beta"]);
    }

    #[test]
    fn finds_links() {
        let links = parse_links("앞 [[회의]] ![[그림.png]] [[폴더/계획#목표|보기]] [[]] [[열린");
        let got: Vec<(&str, bool)> = links.iter().map(|l| (l.target.as_str(), l.embed)).collect();
        assert_eq!(got, [("회의", false), ("그림.png", true), ("폴더/계획", false)]);
        assert_eq!(&"앞 [[회의]] ![[그림.png]]"[links[1].start..links[1].end], "![[그림.png]]");
    }

    #[test]
    fn resolves_links() {
        let all = paths(&["회의.md", "깊은/회의.md", "회의.png", "폴더/계획.md"]);
        assert_eq!(resolve_link("회의", &all), Some("회의.md"));
        assert_eq!(resolve_link("회의.png", &all), Some("회의.png"));
        assert_eq!(resolve_link("깊은/회의", &all), Some("깊은/회의.md"));
        assert_eq!(resolve_link("계획", &all), Some("폴더/계획.md"));
        assert_eq!(resolve_link("없음", &all), None);
    }

    #[test]
    fn rewrites_links_when_a_note_is_renamed() {
        let all = paths(&["회의.md", "폴더/계획.md"]);
        assert_eq!(rename_links("[[회의]] [[회의|보기]] [[계획]]", "회의.md", "모임.md", &all), "[[모임]] [[모임|보기]] [[계획]]");
        assert_eq!(rename_links("[[폴더/계획#목표]]", "폴더/계획.md", "다른/계획.md", &all), "[[다른/계획#목표]]");
    }

    #[test]
    fn picks_free_names_and_rejects_bad_ones() {
        assert_eq!(unique_name(&["제목 없음.md", "제목 없음 2.md"], "제목 없음", "md"), "제목 없음 3.md");
        assert_eq!(unique_name(&[], "새 폴더", ""), "새 폴더");
        assert!(name_problem("a/b").is_some() && name_problem("[x]").is_some() && name_problem(" ").is_some() && name_problem("좋은 이름").is_none());
        assert_eq!(move_problem("a/b.md", "a", &[]), Some(""));
        assert!(move_problem("a", "a/b", &[]).unwrap().contains("자기 자신"));
        assert_eq!(move_problem("a/b.md", "", &["c.md"]), None);
    }
}
