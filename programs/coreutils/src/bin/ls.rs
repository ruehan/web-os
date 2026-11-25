use std::fs;
use std::io::{self, IsTerminal};
use std::process::exit;

struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
}

fn list(path: &str, all: bool) -> io::Result<Vec<Entry>> {
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        return Ok(vec![Entry { name: path.to_string(), is_dir: false, size: meta.len() }]);
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !all && name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata()?;
        entries.push(Entry { name, is_dir: meta.is_dir(), size: meta.len() });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn main() {
    let args = coreutils::args();
    let flag = |c: char| args.iter().any(|a| a.starts_with('-') && a.contains(c));
    let (long, all) = (flag('l'), flag('a'));
    let mut paths: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if paths.is_empty() {
        paths.push(".".to_string());
    }

    let tty = io::stdout().is_terminal();
    let shown = |e: &Entry| {
        if e.is_dir && tty {
            format!("\x1b[1;34m{}\x1b[0m", e.name)
        } else {
            e.name.clone()
        }
    };

    let mut code = 0;
    for (i, path) in paths.iter().enumerate() {
        let entries = match list(path, all) {
            Ok(entries) => entries,
            Err(e) => {
                coreutils::warn("ls", path, &e);
                code = 1;
                continue;
            }
        };
        if paths.len() > 1 {
            println!("{}{path}:", if i > 0 { "\n" } else { "" });
        }
        if long {
            for e in &entries {
                println!("{} {:>8} {}", if e.is_dir { 'd' } else { '-' }, e.size, shown(e));
            }
        } else if tty {
            // 터미널에서는 한 줄에, 파이프로 넘길 때는 한 줄에 하나씩 출력한다.
            if !entries.is_empty() {
                println!("{}", entries.iter().map(shown).collect::<Vec<_>>().join("  "));
            }
        } else {
            for e in &entries {
                println!("{}", e.name);
            }
        }
    }
    exit(code);
}
