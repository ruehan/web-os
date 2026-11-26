//! 주소의 내용을 받아 온다. 받아 오는 것은 커널이고(fetch 시스템 콜), 이 프로그램은 그 결과를 읽어 내놓는다.
//! 브라우저 안이라서, 다른 사이트의 것은 그 사이트가 허락한 경우(CORS)에만 받을 수 있다.

use std::fs::File;
use std::io::{self, Read, Write};
use std::process::exit;

fn main() {
    let args = coreutils::args();
    let mut head = false;
    let mut output = None;
    let mut url = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-I" | "--head" => head = true,
            "-s" | "-L" => {} // 받아들이지만 달라지는 것은 없다 (진행 표시가 없고, 옮겨 간 주소는 늘 따라간다)
            "-o" => output = it.next(),
            _ if arg.starts_with('-') => {
                eprintln!("curl: unknown option {arg}");
                exit(2);
            }
            _ => url = Some(arg),
        }
    }
    let Some(url) = url else {
        eprintln!("usage: curl [-I] [-o FILE] URL");
        exit(2);
    };
    // 주소에 방식이 없으면 https로 본다.
    let url = if url.contains("://") { url } else { format!("https://{url}") };

    let mut response = match webos::fetch(&url, head) {
        Ok(response) => response,
        Err(reason) => {
            eprintln!("curl: could not fetch {url}: {reason}");
            eprintln!("curl: (a site must allow requests from other sites for this to work)");
            exit(6);
        }
    };
    let mut out = io::stdout().lock();
    let result = if head {
        writeln!(out, "HTTP {}\n{}", response.status, response.headers)
    } else {
        let mut body = Vec::new();
        response.body.read_to_end(&mut body).and_then(|_| match &output {
            Some(path) => File::create(path).and_then(|mut file| file.write_all(&body)),
            None => out.write_all(&body),
        })
    };
    if let Err(e) = result {
        coreutils::warn("curl", output.as_deref().unwrap_or("stdout"), &e);
        exit(23);
    }
    // 찾을 수 없음(404) 같은 응답도 본문은 내놓되, 실패로 끝낸다.
    exit(if response.status >= 400 { 22 } else { 0 });
}
