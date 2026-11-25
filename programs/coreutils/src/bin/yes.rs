use std::io::{self, BufWriter, Write};

fn main() {
    let args = coreutils::args();
    let text = if args.is_empty() { "y".to_string() } else { args.join(" ") };
    let mut out = BufWriter::with_capacity(8192, io::stdout().lock());
    while writeln!(out, "{text}").is_ok() {}
}
