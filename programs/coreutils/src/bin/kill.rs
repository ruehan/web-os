use std::process::exit;

fn main() {
    let args = coreutils::args();
    if args.is_empty() {
        eprintln!("usage: kill PID...");
        exit(1);
    }
    let mut code = 0;
    for arg in &args {
        let result = match arg.parse::<i32>() {
            Ok(pid) => webos::kill(pid),
            Err(_) => Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
        };
        if let Err(e) = result {
            coreutils::warn("kill", arg, &e);
            code = 1;
        }
    }
    exit(code);
}
