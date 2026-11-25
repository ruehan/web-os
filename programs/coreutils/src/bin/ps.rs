//! /proc 을 읽어 실행 중인 프로세스를 나열한다.

use std::collections::HashMap;
use std::fs;

struct Proc {
    pid: u32,
    fields: HashMap<String, String>,
    command: String,
}

fn read(pid: u32) -> Option<Proc> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let fields = status
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_string(), value.trim().to_string()))
        .collect();
    // 인자는 NUL 문자로 구분되어 있다.
    let cmdline = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let command = cmdline
        .split(|&b| b == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    Some(Proc { pid, fields, command })
}

fn main() {
    coreutils::args();
    let Ok(entries) = fs::read_dir("/proc") else {
        eprintln!("ps: /proc is not available");
        std::process::exit(1);
    };
    let mut pids: Vec<u32> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse().ok())
        .collect();
    pids.sort();

    println!("{:>5} {:>5} {:<4} {:<3} COMMAND", "PID", "PPID", "STAT", "TTY");
    // 목록을 읽는 사이에 끝난 프로세스는 건너뛴다.
    for proc in pids.into_iter().filter_map(read) {
        let field = |name: &str| proc.fields.get(name).map(String::as_str).unwrap_or("?");
        let state = field("State").chars().next().unwrap_or('?');
        println!("{:>5} {:>5} {:<4} {:<3} {}", proc.pid, field("PPid"), state, field("Tty"), proc.command);
    }
}
