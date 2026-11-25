fn main() {
    let mut args = coreutils::args();
    let newline = args.first().map(String::as_str) != Some("-n");
    if !newline {
        args.remove(0);
    }
    print!("{}{}", args.join(" "), if newline { "\n" } else { "" });
}
