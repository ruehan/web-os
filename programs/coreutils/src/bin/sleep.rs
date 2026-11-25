use std::time::Duration;

fn main() {
    let args = coreutils::args();
    match args.first().and_then(|s| s.parse::<f64>().ok()) {
        Some(secs) if secs >= 0.0 => std::thread::sleep(Duration::from_secs_f64(secs)),
        _ => {
            eprintln!("usage: sleep SECONDS");
            std::process::exit(1);
        }
    }
}
