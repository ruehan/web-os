use std::collections::VecDeque;
use std::io::{self, Write};
use std::process::exit;

fn main() {
    let (count, files) = coreutils::take_count(coreutils::args(), 10);
    let mut out = io::stdout().lock();
    let ok = coreutils::each_input("tail", &files, |_, input| {
        let mut kept: VecDeque<Vec<u8>> = VecDeque::new();
        loop {
            let mut line = Vec::new();
            if input.read_until(b'\n', &mut line)? == 0 {
                break;
            }
            kept.push_back(line);
            if kept.len() > count {
                kept.pop_front();
            }
        }
        kept.iter().try_for_each(|line| out.write_all(line))
    });
    exit(if ok { 0 } else { 1 });
}
