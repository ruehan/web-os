//! 와일드카드(`*`, `?`)가 든 단어를 실제로 있는 파일 이름들로 펼친다.
//!
//! `*`는 글자 몇 개든(없어도), `?`는 글자 하나와 맞는다. 둘 다 `/`를 넘지 않으므로
//! 경로의 각 부분(디렉터리 단계)마다 따로 맞춰 본다. 따옴표 안에 쓰거나 백슬래시를 붙인 것은 글자 그대로다.

use std::fs;

/// 단어의 글자 하나. `wild`면 따옴표 밖에 쓴 `*` 또는 `?`다.
type Glyph = (char, bool);

/// 단어를 펼친다. `wild`는 와일드카드인 글자의 위치(글자 순번)들이다.
/// 맞는 파일이 하나도 없으면 단어를 글자 그대로 돌려준다.
pub fn expand(word: &str, wild: &[usize]) -> Vec<String> {
    if wild.is_empty() {
        return vec![word.to_string()];
    }
    let glyphs: Vec<Glyph> = word.chars().enumerate().map(|(i, c)| (c, wild.contains(&i))).collect();
    let parts: Vec<&[Glyph]> = glyphs.split(|&(c, w)| c == '/' && !w).filter(|part| !part.is_empty()).collect();

    // 지금까지 맞은 경로들. 한 단계씩 내려가며 걸러 낸다.
    let mut found = vec![if word.starts_with('/') { "/".to_string() } else { String::new() }];
    for (depth, part) in parts.iter().enumerate() {
        let last = depth == parts.len() - 1;
        let mut next = Vec::new();
        for base in &found {
            if part.iter().all(|&(_, w)| !w) {
                // 와일드카드가 없는 부분은 그 이름이 있는지만 확인한다.
                let path = join(base, &part.iter().map(|&(c, _)| c).collect::<String>());
                if fs::metadata(&path).is_ok() {
                    next.push(path);
                }
                continue;
            }
            let Ok(entries) = fs::read_dir(if base.is_empty() { "." } else { base }) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                // 점으로 시작하는 숨김 파일은 패턴도 점으로 시작할 때만 맞는다.
                if name.starts_with('.') && part[0] != ('.', false) {
                    continue;
                }
                if !matches(part, &name.chars().collect::<Vec<_>>()) {
                    continue;
                }
                // 뒤에 단계가 더 남았으면 디렉터리여야 내려갈 수 있다.
                if !last && !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                next.push(join(base, &name));
            }
        }
        found = next;
        if found.is_empty() {
            return vec![word.to_string()];
        }
    }
    found.sort();
    found
}

fn join(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// 이름 전체가 패턴과 맞는가
fn matches(pattern: &[Glyph], name: &[char]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        // `*`: 아무것도 삼키지 않거나, 한 글자를 삼키고 계속 시도한다.
        Some((&('*', true), rest)) => matches(rest, name) || (!name.is_empty() && matches(pattern, &name[1..])),
        Some((&('?', true), rest)) => !name.is_empty() && matches(rest, &name[1..]),
        Some((&(c, _), rest)) => name.first() == Some(&c) && matches(rest, &name[1..]),
    }
}
