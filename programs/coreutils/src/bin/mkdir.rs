use std::fs;
use std::process::exit;

fn main() {
    let args = coreutils::args();
    let parents = args.iter().any(|a| a == "-p");
    let mut code = 0;
    for dir in args.iter().filter(|a| !a.starts_with('-')) {
        let result = if parents { fs::create_dir_all(dir) } else { fs::create_dir(dir) };
        if let Err(e) = result {
            coreutils::warn("mkdir", dir, &e);
            code = 1;
        }
    }
    exit(code);
}
