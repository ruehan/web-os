//! 작은 정규식 엔진. 되돌아가며 맞춰 보는 방식이다 (grep이 쓴다).
//!
//! 지원하는 것: 글자 그대로, `.`, `[abc]` `[a-z]` `[^…]`, `^` `$`, `*` `+` `?` `{m,n}`, `|`, `( )`,
//! `\d` `\w` `\s`(대문자는 그 반대), 그리고 `\.`처럼 기호를 글자로 쓰는 것.

#[derive(Debug, Clone, PartialEq)]
enum Class {
    Range(char, char),
    Digit(bool),
    Word(bool),
    Space(bool),
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Char(char),
    Any,
    Set(Vec<Class>, bool),
    Start,
    End,
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    /// 최소, 최대 (없으면 끝없이)
    Repeat(Box<Node>, usize, Option<usize>),
}

pub struct Regex {
    node: Node,
    ignore_case: bool,
}

struct Parser<'a> {
    chars: &'a [char],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        let found = self.peek() == Some(c);
        self.at += found as usize;
        found
    }

    fn alt(&mut self) -> Result<Node, String> {
        let mut options = vec![self.concat()?];
        while self.eat('|') {
            options.push(self.concat()?);
        }
        Ok(if options.len() == 1 { options.remove(0) } else { Node::Alt(options) })
    }

    fn concat(&mut self) -> Result<Node, String> {
        let mut items = Vec::new();
        while !matches!(self.peek(), None | Some('|' | ')')) {
            items.push(self.repeat()?);
        }
        Ok(Node::Concat(items))
    }

    fn repeat(&mut self) -> Result<Node, String> {
        let mut node = self.atom()?;
        loop {
            let (min, max) = match self.peek() {
                Some('*') => self.single(0, None),
                Some('+') => self.single(1, None),
                Some('?') => self.single(0, Some(1)),
                Some('{') => match self.bounds() {
                    Some(bounds) => bounds,
                    None => break, // 횟수 꼴이 아니면 글자 그대로의 {
                },
                _ => break,
            };
            if matches!(node, Node::Start | Node::End) {
                return Err("nothing to repeat".into());
            }
            node = Node::Repeat(Box::new(node), min, max);
        }
        Ok(node)
    }

    /// 한 글자짜리 되풀이 기호(`*` `+` `?`)를 지나간다.
    fn single(&mut self, min: usize, max: Option<usize>) -> (usize, Option<usize>) {
        self.at += 1;
        (min, max)
    }

    /// `{m}` `{m,}` `{m,n}` 꼴의 되풀이 횟수를 읽고 닫는 괄호까지 지나간다. 그런 꼴이 아니면 아무것도 하지 않는다.
    fn bounds(&mut self) -> Option<(usize, Option<usize>)> {
        let rest: String = self.chars[self.at + 1..].iter().take_while(|c| **c != '}').collect();
        let length = rest.chars().count();
        if self.chars.get(self.at + 1 + length) != Some(&'}') {
            return None;
        }
        let bounds = match rest.split_once(',') {
            Some((min, "")) => (min.parse().ok()?, None),
            Some((min, max)) => (min.parse().ok()?, Some(max.parse().ok()?)),
            None => (rest.parse().ok()?, Some(rest.parse().ok()?)),
        };
        self.at += length + 2;
        Some(bounds)
    }

    fn escape(&mut self) -> Result<Result<Class, char>, String> {
        let c = self.peek().ok_or("pattern ends with a backslash")?;
        self.at += 1;
        Ok(match c {
            'd' => Ok(Class::Digit(true)),
            'D' => Ok(Class::Digit(false)),
            'w' => Ok(Class::Word(true)),
            'W' => Ok(Class::Word(false)),
            's' => Ok(Class::Space(true)),
            'S' => Ok(Class::Space(false)),
            'n' => Err('\n'),
            't' => Err('\t'),
            other => Err(other),
        })
    }

    fn atom(&mut self) -> Result<Node, String> {
        let c = self.peek().ok_or("unexpected end of pattern")?;
        self.at += 1;
        Ok(match c {
            '(' => {
                let inner = self.alt()?;
                if !self.eat(')') {
                    return Err("missing )".into());
                }
                inner
            }
            '[' => self.set()?,
            '.' => Node::Any,
            '^' => Node::Start,
            '$' => Node::End,
            '*' | '+' | '?' => return Err("nothing to repeat".into()),
            '\\' => match self.escape()? {
                Ok(class) => Node::Set(vec![class], false),
                Err(c) => Node::Char(c),
            },
            c => Node::Char(c),
        })
    }

    fn set(&mut self) -> Result<Node, String> {
        let negate = self.eat('^');
        let mut items = Vec::new();
        let mut first = true;
        loop {
            let c = self.peek().ok_or("missing ]")?;
            self.at += 1;
            if c == ']' && !first {
                break;
            }
            first = false;
            let low = if c == '\\' {
                match self.escape()? {
                    Ok(class) => {
                        items.push(class);
                        continue;
                    }
                    Err(c) => c,
                }
            } else {
                c
            };
            // a-z 꼴의 범위. 끝의 -는 글자 그대로다.
            if self.peek() == Some('-') && !matches!(self.chars.get(self.at + 1), None | Some(']')) {
                self.at += 1;
                let high = self.peek().ok_or("missing ]")?;
                self.at += 1;
                items.push(Class::Range(low, high));
            } else {
                items.push(Class::Range(low, low));
            }
        }
        Ok(Node::Set(items, negate))
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Regex {
    pub fn new(pattern: &str, ignore_case: bool) -> Result<Regex, String> {
        let chars: Vec<char> = pattern.chars().collect();
        let mut parser = Parser { chars: &chars, at: 0 };
        let node = parser.alt()?;
        if parser.at < chars.len() {
            return Err("unmatched )".into());
        }
        Ok(Regex { node, ignore_case })
    }

    /// 글자 그대로 찾는 패턴 (기호에 특별한 뜻이 없다)
    pub fn literal(text: &str, ignore_case: bool) -> Regex {
        Regex { node: Node::Concat(text.chars().map(Node::Char).collect()), ignore_case }
    }

    fn same(&self, a: char, b: char) -> bool {
        a == b || (self.ignore_case && a.to_lowercase().eq(b.to_lowercase()))
    }

    fn in_class(&self, class: &Class, c: char) -> bool {
        match class {
            Class::Range(low, high) => {
                (*low..=*high).contains(&c)
                    || (self.ignore_case && c.to_lowercase().chain(c.to_uppercase()).any(|c| (*low..=*high).contains(&c)))
            }
            Class::Digit(want) => c.is_ascii_digit() == *want,
            Class::Word(want) => is_word(c) == *want,
            Class::Space(want) => c.is_whitespace() == *want,
        }
    }

    /// `node`를 `i`에서부터 맞춰 보고, 맞은 끝자리마다 `then`을 부른다. `then`이 참이면 거기서 끝낸다.
    fn step(&self, node: &Node, text: &[char], i: usize, then: &mut dyn FnMut(usize) -> bool) -> bool {
        match node {
            Node::Char(c) => i < text.len() && self.same(text[i], *c) && then(i + 1),
            Node::Any => i < text.len() && then(i + 1),
            Node::Set(items, negate) => i < text.len() && items.iter().any(|class| self.in_class(class, text[i])) != *negate && then(i + 1),
            Node::Start => i == 0 && then(i),
            Node::End => i == text.len() && then(i),
            Node::Concat(items) => self.sequence(items, text, i, then),
            Node::Alt(options) => options.iter().any(|option| self.step(option, text, i, then)),
            Node::Repeat(inner, min, max) => self.repeat(inner, *min, *max, 0, text, i, then),
        }
    }

    fn sequence(&self, items: &[Node], text: &[char], i: usize, then: &mut dyn FnMut(usize) -> bool) -> bool {
        match items.split_first() {
            None => then(i),
            Some((first, rest)) => self.step(first, text, i, &mut |j| self.sequence(rest, text, j, then)),
        }
    }

    /// 될 수 있는 한 많이 되풀이해 보고, 뒤가 맞지 않으면 하나씩 줄여 본다.
    #[allow(clippy::too_many_arguments)]
    fn repeat(&self, inner: &Node, min: usize, max: Option<usize>, count: usize, text: &[char], i: usize, then: &mut dyn FnMut(usize) -> bool) -> bool {
        if max.is_none_or(|max| count < max) {
            // 빈 글에 맞는 것을 끝없이 되풀이하지 않도록, 나아간 경우에만 더 되풀이한다.
            let more = self.step(inner, text, i, &mut |j| j > i && self.repeat(inner, min, max, count + 1, text, j, then));
            if more {
                return true;
            }
        }
        count >= min && then(i)
    }

    /// 글에서 처음으로 맞는 곳 (시작과 끝의 글자 순번)
    pub fn find(&self, text: &[char]) -> Option<(usize, usize)> {
        (0..=text.len()).find_map(|start| {
            let mut end = None;
            self.step(&self.node, text, start, &mut |e| {
                end = Some(e);
                true
            });
            end.map(|end| (start, end))
        })
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.find(&text.chars().collect::<Vec<_>>()).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(pattern: &str, text: &str) -> bool {
        Regex::new(pattern, false).expect("valid pattern").is_match(text)
    }

    fn found(pattern: &str, text: &str) -> Option<String> {
        let chars: Vec<char> = text.chars().collect();
        Regex::new(pattern, false).expect("valid pattern").find(&chars).map(|(from, to)| chars[from..to].iter().collect())
    }

    #[test]
    fn matches_plain_text_and_wildcards() {
        assert!(hit("프로세스", "커널이 프로세스를 띄운다"));
        assert!(!hit("프로세서", "커널이 프로세스를 띄운다"));
        assert!(hit("a.c", "abc") && hit("a.c", "a한c") && !hit("a.c", "ac"));
        assert!(hit("", "아무 글"));
    }

    #[test]
    fn anchors_to_the_start_and_end() {
        assert!(hit("^fn ", "fn main()") && !hit("^fn ", "pub fn main()"));
        assert!(hit(";$", "let a = 1;") && !hit(";$", "let a = 1; // 끝"));
        assert!(hit("^$", "") && !hit("^$", " "));
    }

    #[test]
    fn repeats() {
        assert_eq!(found("ab*c", "xxabbbcx").as_deref(), Some("abbbc"));
        assert_eq!(found("ab+c", "ac abc").as_deref(), Some("abc"));
        assert_eq!(found("colou?r", "color colour").as_deref(), Some("color"));
        assert_eq!(found("a{2,3}", "a aa aaaa").as_deref(), Some("aa"));
        assert_eq!(found("[0-9]{3}", "12 3456").as_deref(), Some("345"));
        // 될 수 있는 한 길게 맞추되, 뒤가 맞도록 줄인다.
        assert_eq!(found("<.*>", "a <b> <c> d").as_deref(), Some("<b> <c>"));
        assert_eq!(found("a*", "baaa").as_deref(), Some(""));
        // 횟수 꼴이 아닌 { 는 글자다.
        assert!(hit("fn main\\(\\) {", "fn main() {"));
    }

    #[test]
    fn sets_and_classes() {
        assert!(hit("[abc]x", "bx") && !hit("[abc]x", "dx"));
        assert!(hit("[^0-9]", "a") && !hit("^[^0-9]+$", "a1"));
        assert_eq!(found("\\d+", "pid 1234 끝").as_deref(), Some("1234"));
        assert_eq!(found("\\w+", "  한글_word9 뒤").as_deref(), Some("한글_word9"));
        assert!(hit("a\\sb", "a b") && hit("\\S", "x") && !hit("\\S", "  "));
        assert!(hit("[a-c-]", "-") && hit("[]]", "]"));
        assert!(hit("1\\.5", "1.5") && !hit("1\\.5", "135"));
    }

    #[test]
    fn alternatives_and_groups() {
        assert!(hit("cat|dog", "hotdog") && !hit("cat|dog", "cow"));
        assert_eq!(found("(ab)+", "xababab").as_deref(), Some("ababab"));
        assert!(hit("^(read|write)\\(", "write(1)") && !hit("^(read|write)\\(", "rewrite(1)"));
    }

    #[test]
    fn ignores_case_when_asked() {
        let re = Regex::new("hello [a-z]+", true).expect("valid");
        assert!(re.is_match("Say HELLO World"));
        assert!(Regex::literal("a.c", false).is_match("xa.c") && !Regex::literal("a.c", false).is_match("abc"));
        assert!(Regex::literal("ABC", true).is_match("xabcx"));
    }

    #[test]
    fn rejects_broken_patterns() {
        for bad in ["(ab", "ab)", "[ab", "*a", "a\\"] {
            assert!(Regex::new(bad, false).is_err(), "{bad} should be rejected");
        }
    }
}
