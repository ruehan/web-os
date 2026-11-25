//! 실행 중인 프로세스를 실시간으로 보여 준다. /proc 을 1초마다 다시 읽는다.
//!
//! 키: ↑↓ (또는 j k) 선택, x 선택한 프로세스 종료, q 나가기.

use std::collections::HashMap;
use std::fs;
use std::io::IsTerminal;
use webos::term::{self, Event, Key, Keys, Screen};

const REFRESH_MS: u32 = 1000;

struct Proc {
    pid: i32,
    ppid: String,
    state: char,
    tty: String,
    /// 시작한 뒤 지난 시간 (초)
    age: f64,
    command: String,
}

fn uptime() -> f64 {
    fs::read_to_string("/proc/uptime").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0)
}

fn snapshot() -> Vec<Proc> {
    let now = uptime();
    let mut pids: Vec<i32> = fs::read_dir("/proc")
        .map(|entries| entries.flatten().filter_map(|e| e.file_name().to_string_lossy().parse().ok()).collect())
        .unwrap_or_default();
    pids.sort();
    // 목록을 읽는 사이에 끝난 프로세스는 건너뛴다.
    pids.into_iter()
        .filter_map(|pid| {
            let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
            let fields: HashMap<&str, &str> =
                status.lines().filter_map(|l| l.split_once(':')).map(|(k, v)| (k, v.trim())).collect();
            let cmdline = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
            let command = cmdline
                .split(|&b| b == 0)
                .filter(|arg| !arg.is_empty())
                .map(|arg| String::from_utf8_lossy(arg).into_owned())
                .collect::<Vec<_>>()
                .join(" ");
            let started: f64 = fields.get("StartTime").and_then(|s| s.parse().ok()).unwrap_or(now);
            Some(Proc {
                pid,
                ppid: fields.get("PPid").unwrap_or(&"?").to_string(),
                state: fields.get("State").and_then(|s| s.chars().next()).unwrap_or('?'),
                tty: fields.get("Tty").unwrap_or(&"?").to_string(),
                age: (now - started).max(0.0),
                command,
            })
        })
        .collect()
}

const HEADER: &str = "  PID  PPID S TTY     TIME COMMAND";

fn row(p: &Proc) -> String {
    format!("{:>5} {:>5} {} {:<3} {:>8.1} {}", p.pid, p.ppid, p.state, p.tty, p.age, p.command)
}

fn summary(procs: &[Proc]) -> String {
    let running = procs.iter().filter(|p| p.state == 'R').count();
    format!("가동 {:.0}초 · 프로세스 {}개 (실행 {}, 대기 {})", uptime(), procs.len(), running, procs.len() - running)
}

/// 터미널이 아닌 곳(파이프, 파일)으로 내보낼 때는 한 번만 출력한다.
fn batch() {
    let procs = snapshot();
    println!("{}", summary(&procs));
    println!("{HEADER}");
    for p in &procs {
        println!("{}", row(p));
    }
}

fn draw(procs: &[Proc], selected: usize, first: usize, message: &str) {
    let (cols, rows) = webos::window_size();
    let body = rows.saturating_sub(4);
    let mut out = String::from("\x1b[H");
    let mut line = |text: &str, inverse: bool| {
        if inverse {
            out.push_str("\x1b[7m");
        }
        out.push_str(&term::fit(text, cols));
        out.push_str("\x1b[0m\r\n");
    };
    line(&summary(procs), false);
    line("", false);
    line(HEADER, true);
    for i in 0..body {
        match procs.get(first + i) {
            Some(p) => line(&row(p), first + i == selected),
            None => line("", false),
        }
    }
    // 마지막 줄에는 줄바꿈을 붙이지 않는다 (화면이 한 줄 밀려 올라간다).
    let hint = if message.is_empty() { "↑↓ 선택   x 선택한 프로세스 종료   q 나가기" } else { message };
    out.push_str(&format!("\x1b[90m{}\x1b[0m", term::fit(hint, cols)));
    term::print(&out);
}

fn main() {
    coreutils::args();
    if !std::io::stdout().is_terminal() || !std::io::stdin().is_terminal() {
        return batch();
    }
    let Ok(_screen) = Screen::enter() else {
        return batch();
    };
    let mut keys = Keys::new();
    // 선택은 줄 번호가 아니라 pid로 기억한다. 목록이 바뀌어도 같은 프로세스를 가리켜야 한다.
    let mut selected_pid = webos::getpid();
    let mut first = 0;
    let mut message = String::new();

    loop {
        let procs = snapshot();
        let mut selected = procs.iter().position(|p| p.pid == selected_pid).unwrap_or(0).min(procs.len().saturating_sub(1));
        let (_, rows) = webos::window_size();
        let body = rows.saturating_sub(4).max(1);
        // 선택한 줄이 보이도록 목록을 민다.
        if selected < first {
            first = selected;
        } else if selected >= first + body {
            first = selected + 1 - body;
        }
        draw(&procs, selected, first, &message);

        match keys.read_timeout(REFRESH_MS) {
            Event::Timeout => {
                message.clear();
                continue;
            }
            Event::Closed => break,
            Event::Key(key) => {
                message.clear();
                match key {
                    Key::Char('q') | Key::Ctrl('c') | Key::Esc => break,
                    Key::Up | Key::Char('k') => selected = selected.saturating_sub(1),
                    Key::Down | Key::Char('j') => selected = (selected + 1).min(procs.len().saturating_sub(1)),
                    Key::Home => selected = 0,
                    Key::End => selected = procs.len().saturating_sub(1),
                    Key::Char('x') => {
                        if let Some(p) = procs.get(selected) {
                            message = match webos::kill(p.pid) {
                                Ok(()) => format!("{}번 프로세스({})를 종료했습니다.", p.pid, p.command),
                                Err(e) => format!("{}번 프로세스를 종료하지 못했습니다: {}", p.pid, webos::describe(&e)),
                            };
                        }
                    }
                    _ => {}
                }
                if let Some(p) = procs.get(selected) {
                    selected_pid = p.pid;
                }
            }
        }
    }
}
