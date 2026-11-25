fn main() {
    let code = std::env::args()
        .nth(1)
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(1);
    std::process::exit(code);
}
