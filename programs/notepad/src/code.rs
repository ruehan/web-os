//! 코드 블록의 문법 색상. 정확한 문법 분석이 아니라, 주석·문자열·숫자·예약어처럼 눈에 띄어야 하는 것만 가려낸다.
//! 화면 쪽 편집기의 분석기(src/ui/editor/highlight.ts)와 같은 규칙이다.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Comment,
    Str,
    Number,
    Keyword,
    /// 변수나 키의 이름
    Name,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Sh,
    Json,
    Js,
    Rust,
}

/// 코드 블록의 언어 이름(```rust 등)을 아는 언어로 바꾼다.
pub fn lang_of(name: &str) -> Option<Lang> {
    Some(match name.to_lowercase().as_str() {
        "sh" | "bash" | "shell" | "zsh" => Lang::Sh,
        "json" => Lang::Json,
        "js" | "javascript" | "ts" | "typescript" | "jsx" | "tsx" => Lang::Js,
        "rs" | "rust" => Lang::Rust,
        _ => return None,
    })
}

const SH: &str = "if then else elif fi for while until do done case esac in function return export unset cd exit echo";
const JS: &str = "as async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof interface let new null of return static super switch this throw true try type typeof undefined var void while yield";
const RUST: &str = "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while";

fn is_keyword(lang: Lang, word: &str) -> bool {
    let list = match lang {
        Lang::Sh => SH,
        Lang::Js => JS,
        Lang::Rust => RUST,
        Lang::Json => "true false null",
    };
    list.split(' ').any(|k| k == word)
}

/// `quote`로 시작하는 문자열의 길이. 닫히지 않으면 줄 끝까지(여러 줄을 허용하면 글 끝까지)다.
fn string_len(s: &str, quote: char, multiline: bool) -> usize {
    let mut chars = s.char_indices().skip(1);
    while let Some((at, c)) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '\n' if !multiline => return at,
            c if c == quote => return at + c.len_utf8(),
            _ => {}
        }
    }
    s.len()
}

fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// 색을 입힐 범위들 (시작, 끝, 종류). 자리는 바이트 위치이고, 앞에서부터 겹치지 않게 나온다.
pub fn highlight(text: &str, lang: Lang) -> Vec<(usize, usize, Kind)> {
    let mut out = Vec::new();
    let mut at = 0;
    let mut before: Option<char> = None;
    while at < text.len() {
        let rest = &text[at..];
        let c = rest.chars().next().expect("not at the end");
        let c_like = matches!(lang, Lang::Js | Lang::Rust);
        let after_word = before.is_some_and(word_char);
        let found: Option<(usize, Kind)> = if c_like && rest.starts_with("//") {
            Some((rest.find('\n').unwrap_or(rest.len()), Kind::Comment))
        } else if c_like && rest.starts_with("/*") {
            Some((rest[2..].find("*/").map_or(rest.len(), |end| end + 4), Kind::Comment))
        } else if lang == Lang::Sh && c == '#' && before.is_none_or(char::is_whitespace) {
            // 셸의 #은 낱말 처음에 올 때만 주석이다 (echo a#b 의 #은 아니다).
            Some((rest.find('\n').unwrap_or(rest.len()), Kind::Comment))
        } else if c == '"' {
            let len = string_len(rest, '"', false);
            // JSON에서 뒤에 콜론이 오는 문자열은 이름(키)이다.
            let key = lang == Lang::Json && rest[len..].trim_start().starts_with(':');
            Some((len, if key { Kind::Name } else { Kind::Str }))
        } else if c == '\'' && matches!(lang, Lang::Js | Lang::Sh) {
            Some((string_len(rest, '\'', false), Kind::Str))
        } else if c == '`' && lang == Lang::Js {
            Some((string_len(rest, '`', true), Kind::Str))
        } else if c == '\'' && lang == Lang::Rust {
            // 러스트의 작은따옴표는 문자('a')와 수명('a)에 모두 쓰이므로 문자 꼴일 때만 문자열로 본다.
            let mut chars = rest.chars().skip(1);
            let inner = match chars.next() {
                Some('\\') => chars.next().map(|e| 1 + e.len_utf8()),
                Some(ch) if ch != '\'' && ch != '\n' => Some(ch.len_utf8()),
                _ => None,
            };
            inner.filter(|inner| rest[1 + inner..].starts_with('\'')).map(|inner| (inner + 2, Kind::Str))
        } else if lang == Lang::Sh && c == '$' {
            let len = if rest.starts_with("${") {
                rest.find(['}', '\n']).map_or(rest.len(), |end| end + rest[end..].starts_with('}') as usize)
            } else {
                1 + rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || "_?$#@*".contains(c))).unwrap_or(rest.len() - 1)
            };
            (len > 1).then_some((len, Kind::Name))
        } else if !after_word && (c.is_ascii_digit() || (c == '-' && rest[1..].starts_with(|d: char| d.is_ascii_digit()))) {
            let digits = &rest[(c == '-') as usize..];
            let len = digits.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.')).unwrap_or(digits.len());
            Some((len + (c == '-') as usize, Kind::Number))
        } else if !after_word && (c.is_ascii_alphabetic() || c == '_' || c == '$') {
            let more = |c: char| word_char(c) || (lang == Lang::Sh && c == '-');
            let len = rest.find(|c: char| !more(c)).unwrap_or(rest.len());
            if is_keyword(lang, &rest[..len]) {
                Some((len, Kind::Keyword))
            } else {
                // 예약어가 아닌 낱말은 색 없이 통째로 지나간다 (낱말 속의 숫자가 숫자로 보이지 않게).
                before = rest[..len].chars().next_back();
                at += len;
                continue;
            }
        } else {
            None
        };
        match found {
            Some((len, kind)) if len > 0 => {
                out.push((at, at + len, kind));
                before = rest[..len].chars().next_back();
                at += len;
            }
            _ => {
                before = Some(c);
                at += c.len_utf8();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(text: &str, lang: Lang) -> Vec<(&str, Kind)> {
        highlight(text, lang).into_iter().map(|(from, to, kind)| (&text[from..to], kind)).collect()
    }

    #[test]
    fn colors_rust() {
        assert_eq!(
            tokens("fn main() { // 시작\n    let x1 = -42; let c = 'a'; let s: &'a str = \"hi\\\"\"; }", Lang::Rust),
            [
                ("fn", Kind::Keyword),
                ("// 시작", Kind::Comment),
                ("let", Kind::Keyword),
                ("-42", Kind::Number),
                ("let", Kind::Keyword),
                ("'a'", Kind::Str),
                ("let", Kind::Keyword),
                ("\"hi\\\"\"", Kind::Str),
            ]
        );
        assert_eq!(tokens("/* 여러\n줄 */ x", Lang::Rust), [("/* 여러\n줄 */", Kind::Comment)]);
    }

    #[test]
    fn colors_shell() {
        assert_eq!(
            tokens("# 주석\necho a#b $HOME ${x} 'it' | head -3; if true", Lang::Sh),
            [
                ("# 주석", Kind::Comment),
                ("echo", Kind::Keyword),
                ("$HOME", Kind::Name),
                ("${x}", Kind::Name),
                ("'it'", Kind::Str),
                ("-3", Kind::Number),
                ("if", Kind::Keyword),
            ]
        );
    }

    #[test]
    fn colors_json_and_js() {
        assert_eq!(
            tokens("{\"name\": \"값\", \"n\": 1.5, \"ok\": true}", Lang::Json),
            [("\"name\"", Kind::Name), ("\"값\"", Kind::Str), ("\"n\"", Kind::Name), ("1.5", Kind::Number), ("\"ok\"", Kind::Name), ("true", Kind::Keyword)]
        );
        assert_eq!(tokens("const s = `a\nb` + 'c'", Lang::Js), [("const", Kind::Keyword), ("`a\nb`", Kind::Str), ("'c'", Kind::Str)]);
        assert_eq!((lang_of("TS"), lang_of("bash"), lang_of("python")), (Some(Lang::Js), Some(Lang::Sh), None));
    }
}
