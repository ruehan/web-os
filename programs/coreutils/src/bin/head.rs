use std::io::{self, Write};
use std::process::exit;

fn main() {
    let (count, files) = coreutils::take_count(coreutils::args(), 10);
    let mut out = io::stdout().lock();
    let ok = coreutils::each_input("head", &files, |_, input| {
        let mut line = Vec::new();
        for _ in 0..count {
            line.clear();
            if input.read_until(b'\n', &mut line)? == 0 {
                break;
            }
            out.write_all(&line)?;
        }
        Ok(())
    });
    exit(if ok { 0 } else { 1 });
}
