//! 셸. 명령 줄을 해석해 프로세스를 띄우고, 파이프와 리다이렉션으로 연결한다.
//!
//! 지원: 파이프(|), 리다이렉션(< > >>), 순차·조건 실행(; && ||), 배경 실행(&),
//! 따옴표와 백슬래시, 변수($VAR ${VAR} $? $$), 주석(#), 스크립트 파일 실행.

use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, IsTerminal, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::exit;

const NOT_FOUND: i32 = 127;
const CANNOT_RUN: i32 = 126;
const ENOEXEC: i32 = 45;

#[derive(Clone, Copy, PartialEq)]
enum Conn {
    Seq,
    And,
    Or,
}

/// `;` `&&` `||` `&` 로 나뉜 한 조각. 조각 하나가 파이프라인 하나다.
struct Item {
    text: String,
    conn: Conn,
    background: bool,
}

enum Tok {
    Word(String),
    Pipe,
    In,
    Out,
    Append,
}

#[derive(Default)]
struct Cmd {
    assigns: Vec<(String, String)>,
    args: Vec<String>,
    stdin: Option<String>,
    /// (경로, 이어 쓰기 여부)
    stdout: Option<(String, bool)>,
}

struct Shell {
    vars: BTreeMap<String, String>,
    status: i32,
    pid: i32,
    /// $0, $1, ... (스크립트 인자)
    params: Vec<String>,
}

fn main() {
    webos::init();
    let args: Vec<String> = env::args().collect();
    let mut sh = Shell {
        vars: env::vars().collect(),
        status: 0,
        pid: webos::getpid(),
        params: vec!["sh".to_string()],
    };

    if args.len() >= 3 && args[1] == "-c" {
        sh.run_line(&args[2]);
        exit(sh.status);
    }
    if args.len() >= 2 {
        match fs::read_to_string(&args[1]) {
            Ok(script) => {
                sh.params = args[1..].to_vec();
                for line in script.lines() {
                    sh.run_line(line);
                }
                exit(sh.status);
            }
            Err(e) => {
                eprintln!("sh: {}: {}", args[1], webos::describe(&e));
                exit(NOT_FOUND);
            }
        }
    }

    let interactive = io::stdin().is_terminal();
    if interactive {
        if let Ok(motd) = fs::read_to_string("/etc/motd") {
            print!("{motd}");
        }
    }
    let mut line = String::new();
    loop {
        if interactive {
            while let Some((pid, code)) = webos::try_wait_any() {
                println!("[{pid}] done ({code})");
            }
            print!("{}", sh.prompt());
            let _ = io::stdout().flush();
        }
        line.clear();
        match io::stdin().lock().read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => sh.run_line(line.trim_end_matches('\n')),
        }
    }
    if interactive {
        println!("exit");
    }
    exit(sh.status);
}

impl Shell {
    fn var(&self, name: &str) -> String {
        self.vars.get(name).cloned().unwrap_or_default()
    }

    fn prompt(&self) -> String {
        let cwd = self.var("PWD");
        let home = self.var("HOME");
        let shown = match cwd.strip_prefix(&home) {
            Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => format!("~{rest}"),
            _ => cwd,
        };
        format!("\x1b[32m{}@webos\x1b[0m:\x1b[34m{}\x1b[0m$ ", self.var("USER"), shown)
    }

    fn run_line(&mut self, line: &str) {
        for item in split_list(line) {
            let skip = match item.conn {
                Conn::Seq => false,
                Conn::And => self.status != 0,
                Conn::Or => self.status == 0,
            };
            if skip || item.text.trim().is_empty() {
                continue;
            }
            self.status = match self.parse(&item.text) {
                Ok(cmds) => self.run_pipeline(cmds, item.background),
                Err(msg) => {
                    eprintln!("sh: {msg}");
                    2
                }
            };
        }
    }

    // ───────────── 해석 ─────────────

    fn parse(&self, text: &str) -> Result<Vec<Cmd>, String> {
        let mut cmds = vec![Cmd::default()];
        let mut toks = self.tokenize(text)?.into_iter();
        while let Some(tok) = toks.next() {
            let cmd = cmds.last_mut().unwrap();
            let mut target = |what: &str| match toks.next() {
                Some(Tok::Word(w)) => Ok(w),
                _ => Err(format!("syntax error: expected a file name after `{what}`")),
            };
            match tok {
                Tok::Word(w) => match split_assignment(&w) {
                    Some(pair) if cmd.args.is_empty() => cmd.assigns.push(pair),
                    _ => cmd.args.push(w),
                },
                Tok::In => cmd.stdin = Some(target("<")?),
                Tok::Out => cmd.stdout = Some((target(">")?, false)),
                Tok::Append => cmd.stdout = Some((target(">>")?, true)),
                Tok::Pipe => {
                    if cmd.args.is_empty() {
                        return Err("syntax error near `|`".to_string());
                    }
                    cmds.push(Cmd::default());
                }
            }
        }
        if cmds.len() > 1 && cmds.last().unwrap().args.is_empty() {
            return Err("syntax error: command expected after `|`".to_string());
        }
        Ok(cmds)
    }

    /// 단어와 연산자로 나누면서 따옴표를 벗기고 변수를 펼친다.
    fn tokenize(&self, text: &str) -> Result<Vec<Tok>, String> {
        let chars: Vec<char> = text.chars().collect();
        let mut toks = Vec::new();
        let mut cur = String::new();
        // 빈 따옴표("")도 단어 하나로 쳐야 하므로 내용과 별도로 추적한다.
        let mut in_word = false;
        let mut i = 0;

        macro_rules! flush {
            () => {
                if in_word {
                    toks.push(Tok::Word(std::mem::take(&mut cur)));
                    in_word = false;
                }
            };
        }

        while i < chars.len() {
            let c = chars[i];
            i += 1;
            match c {
                ' ' | '\t' => flush!(),
                '|' => {
                    flush!();
                    toks.push(Tok::Pipe);
                }
                '<' => {
                    flush!();
                    toks.push(Tok::In);
                }
                '>' => {
                    flush!();
                    if chars.get(i) == Some(&'>') {
                        i += 1;
                        toks.push(Tok::Append);
                    } else {
                        toks.push(Tok::Out);
                    }
                }
                '\'' => {
                    in_word = true;
                    loop {
                        match chars.get(i) {
                            None => return Err("syntax error: unterminated quote".to_string()),
                            Some('\'') => break,
                            Some(&ch) => cur.push(ch),
                        }
                        i += 1;
                    }
                    i += 1;
                }
                '"' => {
                    in_word = true;
                    loop {
                        match chars.get(i) {
                            None => return Err("syntax error: unterminated quote".to_string()),
                            Some('"') => break,
                            Some('\\') if matches!(chars.get(i + 1), Some('"' | '\\' | '$')) => {
                                cur.push(chars[i + 1]);
                                i += 2;
                            }
                            Some('$') => {
                                i += 1;
                                cur.push_str(&self.expand(&chars, &mut i));
                            }
                            Some(&ch) => {
                                cur.push(ch);
                                i += 1;
                            }
                        }
                    }
                    i += 1;
                }
                '\\' => {
                    if let Some(&ch) = chars.get(i) {
                        cur.push(ch);
                        in_word = true;
                        i += 1;
                    }
                }
                '$' => {
                    let value = self.expand(&chars, &mut i);
                    if !value.is_empty() {
                        cur.push_str(&value);
                        in_word = true;
                    }
                }
                '~' if !in_word && matches!(chars.get(i), None | Some('/' | ' ' | '\t')) => {
                    cur.push_str(&self.var("HOME"));
                    in_word = true;
                }
                _ => {
                    cur.push(c);
                    in_word = true;
                }
            }
        }
        if in_word {
            toks.push(Tok::Word(cur));
        }
        Ok(toks)
    }

    /// `$` 바로 다음 위치에서 변수 이름을 읽어 값을 돌려준다.
    fn expand(&self, chars: &[char], i: &mut usize) -> String {
        let is_name = |c: char| c.is_ascii_alphanumeric() || c == '_';
        match chars.get(*i) {
            Some('?') => {
                *i += 1;
                self.status.to_string()
            }
            Some('$') => {
                *i += 1;
                self.pid.to_string()
            }
            Some(&d) if d.is_ascii_digit() => {
                *i += 1;
                self.params.get(d as usize - '0' as usize).cloned().unwrap_or_default()
            }
            Some('{') => {
                let start = *i + 1;
                let mut end = start;
                while end < chars.len() && chars[end] != '}' {
                    end += 1;
                }
                *i = (end + 1).min(chars.len());
                self.var(&chars[start..end].iter().collect::<String>())
            }
            Some(&c) if is_name(c) => {
                let start = *i;
                while *i < chars.len() && is_name(chars[*i]) {
                    *i += 1;
                }
                self.var(&chars[start..*i].iter().collect::<String>())
            }
            _ => "$".to_string(),
        }
    }

    // ───────────── 실행 ─────────────

    fn run_pipeline(&mut self, mut cmds: Vec<Cmd>, background: bool) -> i32 {
        if cmds.len() == 1 {
            let cmd = &mut cmds[0];
            if cmd.args.is_empty() {
                // 명령 없이 `이름=값`만 있으면 셸 변수를 바꾼다.
                self.vars.extend(cmd.assigns.drain(..));
                return 0;
            }
            if let Some(code) = self.builtin(&cmd.args) {
                return code;
            }
        }

        let mut paths = Vec::new();
        for cmd in &cmds {
            match self.resolve(&cmd.args[0]) {
                Some(path) => paths.push(path),
                None => {
                    eprintln!("sh: {}: command not found", cmd.args[0]);
                    return NOT_FOUND;
                }
            }
        }

        let last = cmds.len() - 1;
        let mut pids = Vec::new();
        let mut pgid = webos::PGID_NEW;
        let mut status = 0;
        // 앞 명령의 출력을 읽는 파이프 끝. 다음 명령의 표준 입력이 된다.
        let mut upstream: Option<OwnedFd> = None;

        for (i, cmd) in cmds.iter().enumerate() {
            let mut downstream = None;
            let mut pipe_out = None;
            if i < last {
                match webos::pipe() {
                    Ok((r, w)) => {
                        downstream = Some(r);
                        pipe_out = Some(w);
                    }
                    Err(e) => {
                        eprintln!("sh: pipe: {}", webos::describe(&e));
                        status = CANNOT_RUN;
                        break;
                    }
                }
            }

            match self.launch(cmd, &paths[i], upstream.as_ref(), pipe_out.as_ref(), pgid, !background) {
                Ok(pid) => {
                    if pgid == webos::PGID_NEW {
                        pgid = pid;
                    }
                    pids.push(pid);
                    status = 0;
                }
                Err(msg) => {
                    eprintln!("sh: {msg}");
                    status = CANNOT_RUN;
                }
            }
            // 여기서 셸이 쥐고 있던 파이프 끝이 닫힌다. 닫지 않으면 읽는 쪽이 EOF를 받지 못한다.
            upstream = downstream;
        }
        drop(upstream);

        if background {
            if let Some(pid) = pids.last() {
                println!("[{pid}]");
            }
            return status;
        }
        for (i, pid) in pids.iter().enumerate() {
            let code = webos::wait(*pid).unwrap_or(CANNOT_RUN);
            if i == pids.len() - 1 && status == 0 {
                status = code;
            }
        }
        let _ = webos::set_foreground(self.pid);
        status
    }

    fn launch(
        &self,
        cmd: &Cmd,
        path: &str,
        pipe_in: Option<&OwnedFd>,
        pipe_out: Option<&OwnedFd>,
        pgid: i32,
        foreground: bool,
    ) -> Result<i32, String> {
        let describe = |p: &str, e: io::Error| format!("{p}: {}", webos::describe(&e));
        let in_file = match &cmd.stdin {
            Some(p) => Some(File::open(p).map_err(|e| describe(p, e))?),
            None => None,
        };
        let out_file = match &cmd.stdout {
            Some((p, append)) => Some(
                OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(!append)
                    .append(*append)
                    .open(p)
                    .map_err(|e| describe(p, e))?,
            ),
            None => None,
        };

        let mut vars = self.vars.clone();
        vars.extend(cmd.assigns.iter().cloned());
        let env: Vec<(String, String)> = vars.into_iter().collect();

        let stdin = in_file.as_ref().map(|f| f.as_raw_fd()).or(pipe_in.map(|f| f.as_raw_fd())).unwrap_or(0);
        let stdout = out_file.as_ref().map(|f| f.as_raw_fd()).or(pipe_out.map(|f| f.as_raw_fd())).unwrap_or(1);
        let spawn = |path: &str, args: &[String]| {
            webos::spawn(&webos::Spawn { path, args, env: &env, stdin, stdout, stderr: 2, pgid, foreground })
        };

        match spawn(path, &cmd.args) {
            // 실행 파일이 아니면 셸 스크립트로 보고 sh에게 맡긴다.
            Err(e) if e.raw_os_error() == Some(ENOEXEC) => {
                let mut args = vec!["sh".to_string(), path.to_string()];
                args.extend(cmd.args[1..].iter().cloned());
                spawn("/bin/sh", &args).map_err(|e| describe(&cmd.args[0], e))
            }
            other => other.map_err(|e| describe(&cmd.args[0], e)),
        }
    }

    /// 명령 이름을 실행 파일의 절대 경로로 바꾼다.
    fn resolve(&self, name: &str) -> Option<String> {
        let is_file = |p: &str| fs::metadata(p).map(|m| m.is_file()).unwrap_or(false);
        if name.contains('/') {
            let path = normalize(&self.var("PWD"), name);
            return is_file(&path).then_some(path);
        }
        self.var("PATH")
            .split(':')
            .filter(|dir| !dir.is_empty())
            .map(|dir| format!("{dir}/{name}"))
            .find(|p| is_file(p))
    }

    /// 셸 자신의 상태를 바꿔야 해서 별도 프로세스로 실행할 수 없는 명령들.
    fn builtin(&mut self, args: &[String]) -> Option<i32> {
        match args[0].as_str() {
            "cd" => {
                let target = args.get(1).cloned().unwrap_or_else(|| self.var("HOME"));
                let path = normalize(&self.var("PWD"), &target);
                match fs::metadata(&path) {
                    Ok(m) if m.is_dir() => {
                        let _ = env::set_current_dir(&path);
                        self.vars.insert("PWD".to_string(), path);
                        Some(0)
                    }
                    Ok(_) => {
                        eprintln!("sh: cd: {target}: Not a directory");
                        Some(1)
                    }
                    Err(e) => {
                        eprintln!("sh: cd: {target}: {}", webos::describe(&e));
                        Some(1)
                    }
                }
            }
            "exit" => {
                let code = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(self.status);
                exit(code);
            }
            "export" => {
                self.vars.extend(args[1..].iter().filter_map(|a| split_assignment(a)));
                Some(0)
            }
            "unset" => {
                for name in &args[1..] {
                    self.vars.remove(name);
                }
                Some(0)
            }
            _ => None,
        }
    }
}

/// 줄을 `;` `&&` `||` `&` 기준으로 나눈다. 따옴표 안은 건드리지 않는다.
fn split_list(line: &str) -> Vec<Item> {
    let chars: Vec<char> = line.chars().collect();
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut conn = Conn::Seq;
    let mut quote: Option<char> = None;
    let mut word_start = true;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        i += 1;

        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' && q == '"' {
                if let Some(n) = next {
                    cur.push(n);
                    i += 1;
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }

        let mut end = |cur: &mut String, conn: &mut Conn, next_conn: Conn, background: bool| {
            items.push(Item { text: std::mem::take(cur), conn: *conn, background });
            *conn = next_conn;
        };
        match c {
            '\\' => {
                cur.push(c);
                if let Some(n) = next {
                    cur.push(n);
                    i += 1;
                }
                word_start = false;
            }
            '\'' | '"' => {
                quote = Some(c);
                cur.push(c);
                word_start = false;
            }
            '#' if word_start => break,
            ';' => {
                end(&mut cur, &mut conn, Conn::Seq, false);
                word_start = true;
            }
            '&' if next == Some('&') => {
                i += 1;
                end(&mut cur, &mut conn, Conn::And, false);
                word_start = true;
            }
            '&' => {
                end(&mut cur, &mut conn, Conn::Seq, true);
                word_start = true;
            }
            '|' if next == Some('|') => {
                i += 1;
                end(&mut cur, &mut conn, Conn::Or, false);
                word_start = true;
            }
            _ => {
                cur.push(c);
                word_start = c == ' ' || c == '\t' || c == '|';
            }
        }
    }
    items.push(Item { text: cur, conn, background: false });
    items
}

/// `NAME=value` 꼴이면 (이름, 값)을 돌려준다.
fn split_assignment(word: &str) -> Option<(String, String)> {
    let (name, value) = word.split_once('=')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    let valid = (first.is_ascii_alphabetic() || first == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid.then(|| (name.to_string(), value.to_string()))
}

/// 경로를 base 기준 절대 경로로 만들고 `.` 과 `..` 을 정리한다.
fn normalize(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') { path.to_string() } else { format!("{base}/{path}") };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}
