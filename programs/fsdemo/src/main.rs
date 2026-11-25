use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};

fn main() -> std::io::Result<()> {
    let path = "/tmp/note.txt";

    let mut f = File::create(path)?;
    f.write_all(b"first line\n")?;
    drop(f);

    let mut f = OpenOptions::new().append(true).open(path)?;
    f.write_all(b"second line\n")?;
    drop(f);

    let text = fs::read_to_string(path)?;
    print!("{text}");

    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(6))?;
    let mut word = [0u8; 4];
    f.read_exact(&mut word)?;
    println!("seek(6) -> {}", String::from_utf8_lossy(&word));

    println!("size = {}", fs::metadata(path)?.len());

    match File::open("/tmp/missing.txt") {
        Err(e) => eprintln!("open missing: {:?}", e.kind()),
        Ok(_) => println!("unexpected: missing file opened"),
    }
    Ok(())
}
