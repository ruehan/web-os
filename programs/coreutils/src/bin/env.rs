fn main() {
    coreutils::args();
    for (key, value) in std::env::vars() {
        println!("{key}={value}");
    }
}
