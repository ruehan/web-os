use std::fs::OpenOptions;
use std::process::exit;

fn main() {
    let mut code = 0;
    for path in coreutils::args() {
        if let Err(e) = OpenOptions::new().create(true).append(true).open(&path) {
            coreutils::warn("touch", &path, &e);
            code = 1;
        }
    }
    exit(code);
}
