//! 문자열 포함 여부로 줄을 고른다 (정규식이 아닌 글자 그대로의 검색).

use std::io::{self, Write};
use std::process::exit;

fn main() {
    let args = coreutils::args();
    let flag = |c: char| args.iter().any(|a| a.starts_with('-') && a.len() > 1 && a.contains(c));
    let (ignore_case, invert, numbers, count_only) = (flag('i'), flag('v'), flag('n'), flag('c'));
    let mut rest = args.iter().filter(|a| !(a.starts_with('-') && a.len() > 1)).cloned();
    let Some(pattern) = rest.next() else {
        eprintln!("usage: grep [-i] [-v] [-n] [-c] PATTERN [FILE...]");
        exit(2);
    };
    let files: Vec<String> = rest.collect();
    let pattern = if ignore_case { pattern.to_lowercase() } else { pattern };
    let show_name = files.len() > 1;

    let mut out = io::stdout().lock();
    let mut matched = false;
    let ok = coreutils::each_input("grep", &files, |name, input| {
        let mut hits = 0usize;
        let mut buf = Vec::new();
        let mut number = 0usize;
        loop {
            buf.clear();
            if input.read_until(b'\n', &mut buf)? == 0 {
                break;
            }
            number += 1;
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end_matches('\n');
            let found = if ignore_case { line.to_lowercase().contains(&pattern) } else { line.contains(&pattern) };
            if found == invert {
                continue;
            }
            hits += 1;
            if count_only {
                continue;
            }
            if show_name {
                write!(out, "{name}:")?;
            }
            if numbers {
                write!(out, "{number}:")?;
            }
            writeln!(out, "{line}")?;
        }
        if count_only {
            if show_name {
                write!(out, "{name}:")?;
            }
            writeln!(out, "{hits}")?;
        }
        matched |= hits > 0;
        Ok(())
    });
    exit(if !ok { 2 } else if matched { 0 } else { 1 });
}
