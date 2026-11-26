//! 프로세스를 끝내거나(-TERM, 기본), 멈추거나(-STOP), 다시 움직이게 한다(-CONT).

use std::process::exit;
use webos::Signal;

fn main() {
    let mut args = coreutils::args();
    let signal = match args.first().map(String::as_str) {
        Some("-STOP" | "-19") => Some(Signal::Stop),
        Some("-CONT" | "-18") => Some(Signal::Cont),
        Some("-TERM" | "-KILL" | "-15" | "-9") => Some(Signal::Term),
        _ => None,
    };
    if signal.is_some() {
        args.remove(0);
    }
    if args.is_empty() {
        eprintln!("usage: kill [-STOP | -CONT] PID...");
        exit(1);
    }
    let mut code = 0;
    for arg in &args {
        let result = match arg.parse::<i32>() {
            Ok(pid) => webos::signal(pid, signal.unwrap_or(Signal::Term)),
            Err(_) => Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
        };
        if let Err(e) = result {
            coreutils::warn("kill", arg, &e);
            code = 1;
        }
    }
    exit(code);
}
