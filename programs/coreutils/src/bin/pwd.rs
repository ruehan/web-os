fn main() {
    coreutils::args();
    match std::env::current_dir() {
        Ok(dir) => println!("{}", dir.display()),
        Err(e) => {
            coreutils::warn("pwd", ".", &e);
            std::process::exit(1);
        }
    }
}
