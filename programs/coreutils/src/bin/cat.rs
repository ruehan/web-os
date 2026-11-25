use std::io::{self, Write};
use std::process::exit;

fn main() {
    let files = coreutils::args();
    let mut out = io::stdout().lock();
    let ok = coreutils::each_input("cat", &files, |_, input| io::copy(input, &mut out).map(|_| ()));
    let _ = out.flush();
    exit(if ok { 0 } else { 1 });
}
