use std::fs;
use std::io;
use std::process::exit;

fn remove(path: &str, recursive: bool) -> io::Result<()> {
    if !fs::metadata(path)?.is_dir() {
        return fs::remove_file(path);
    }
    if !recursive {
        return Err(io::Error::other("Is a directory (use -r)"));
    }
    for entry in fs::read_dir(path)? {
        let child = format!("{path}/{}", entry?.file_name().to_string_lossy());
        remove(&child, true)?;
    }
    fs::remove_dir(path)
}

fn main() {
    let args = coreutils::args();
    let flag = |c: char| args.iter().any(|a| a.starts_with('-') && a.contains(c));
    let (recursive, force) = (flag('r'), flag('f'));
    let mut code = 0;
    for path in args.iter().filter(|a| !a.starts_with('-')) {
        match remove(path, recursive) {
            Err(e) if force && e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                coreutils::warn("rm", path, &e);
                code = 1;
            }
            Ok(()) => {}
        }
    }
    exit(code);
}
