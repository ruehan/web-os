//! 패턴에 맞는 줄을 고른다. 패턴은 정규식이다 (-F를 주면 글자 그대로 찾는다).

use coreutils::regex::Regex;
use std::io::{self, Write};
use std::process::exit;

fn main() {
    let args = coreutils::args();
    let flag = |c: char| args.iter().any(|a| a.starts_with('-') && a.len() > 1 && a.contains(c));
    let (ignore_case, invert, numbers, count_only, fixed) = (flag('i'), flag('v'), flag('n'), flag('c'), flag('F'));
    let mut rest = args.iter().filter(|a| !(a.starts_with('-') && a.len() > 1)).cloned();
    let Some(pattern) = rest.next() else {
        eprintln!("usage: grep [-i] [-v] [-n] [-c] [-F] PATTERN [FILE...]");
        exit(2);
    };
    let files: Vec<String> = rest.collect();
    let regex = if fixed {
        Regex::literal(&pattern, ignore_case)
    } else {
        match Regex::new(&pattern, ignore_case) {
            Ok(regex) => regex,
            Err(problem) => {
                eprintln!("grep: {pattern}: {problem}");
                exit(2);
            }
        }
    };
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
            if regex.is_match(line) == invert {
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
