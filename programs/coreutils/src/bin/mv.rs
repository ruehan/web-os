use std::fs;
use std::path::Path;
use std::process::exit;

fn main() {
    let args = coreutils::args();
    let [sources @ .., target] = args.as_slice() else {
        eprintln!("usage: mv SOURCE... TARGET");
        exit(1);
    };
    if sources.is_empty() {
        eprintln!("usage: mv SOURCE... TARGET");
        exit(1);
    }
    let into_dir = fs::metadata(target).map(|m| m.is_dir()).unwrap_or(false);
    if sources.len() > 1 && !into_dir {
        eprintln!("mv: {target}: Not a directory");
        exit(1);
    }
    let mut code = 0;
    for source in sources {
        // 대상이 디렉터리면 그 안에 같은 이름으로 옮긴다.
        let dest = match Path::new(source).file_name() {
            Some(name) if into_dir => format!("{target}/{}", name.to_string_lossy()),
            _ => target.clone(),
        };
        if let Err(e) = fs::rename(source, &dest) {
            coreutils::warn("mv", source, &e);
            code = 1;
        }
    }
    exit(code);
}
