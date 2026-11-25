fn main() {
    let args: Vec<String> = std::env::args().collect();
    println!("Hello from a real WASM process!");
    println!("argv = {:?}", args);
    if let Ok(user) = std::env::var("USER") {
        println!("USER = {user}");
    }
}
