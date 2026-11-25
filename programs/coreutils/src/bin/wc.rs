use std::process::exit;

fn main() {
    let args = coreutils::args();
    let flag = |c: char| args.iter().any(|a| a.starts_with('-') && a.contains(c));
    let (mut lines, mut words, mut bytes) = (flag('l'), flag('w'), flag('c'));
    if !(lines || words || bytes) {
        (lines, words, bytes) = (true, true, true);
    }
    let files: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();

    let ok = coreutils::each_input("wc", &files, |name, input| {
        let (mut l, mut w, mut b) = (0usize, 0usize, 0usize);
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = input.read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            b += n;
            l += line.ends_with(b"\n") as usize;
            w += line.split(|c| c.is_ascii_whitespace()).filter(|s| !s.is_empty()).count();
        }
        let counts: Vec<String> = [(lines, l), (words, w), (bytes, b)]
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, n)| n.to_string())
            .collect();
        // 항목이 하나면 숫자만, 여럿이면 열을 맞춰 출력한다.
        let text = if counts.len() == 1 {
            counts[0].clone()
        } else {
            counts.iter().map(|c| format!("{c:>7}")).collect::<Vec<_>>().join(" ")
        };
        if name.is_empty() {
            println!("{text}");
        } else {
            println!("{text} {name}");
        }
        Ok(())
    });
    exit(if ok { 0 } else { 1 });
}
