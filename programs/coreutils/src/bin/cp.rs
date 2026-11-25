use std::fs;
use std::io;
use std::path::Path;
use std::process::exit;

fn copy(source: &str, dest: &str, recursive: bool) -> io::Result<()> {
    if !fs::metadata(source)?.is_dir() {
        return fs::copy(source, dest).map(|_| ());
    }
    if !recursive {
        return Err(io::Error::other("Is a directory (use -r)"));
    }
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        copy(&format!("{source}/{name}"), &format!("{dest}/{name}"), true)?;
    }
    Ok(())
}

fn main() {
    let args = coreutils::args();
    let recursive = args.iter().any(|a| a == "-r");
    let paths: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let [sources @ .., target] = paths.as_slice() else {
        eprintln!("usage: cp [-r] SOURCE... TARGET");
        exit(1);
    };
    if sources.is_empty() {
        eprintln!("usage: cp [-r] SOURCE... TARGET");
        exit(1);
    }
    let into_dir = fs::metadata(target).map(|m| m.is_dir()).unwrap_or(false);
    if sources.len() > 1 && !into_dir {
        eprintln!("cp: {target}: Not a directory");
        exit(1);
    }
    let mut code = 0;
    for source in sources {
        let dest = match Path::new(source.as_str()).file_name() {
            Some(name) if into_dir => format!("{target}/{}", name.to_string_lossy()),
            _ => target.to_string(),
        };
        if let Err(e) = copy(source, &dest, recursive) {
            coreutils::warn("cp", source, &e);
            code = 1;
        }
    }
    exit(code);
}
