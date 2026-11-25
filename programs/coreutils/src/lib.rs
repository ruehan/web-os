//! 기본 명령어들이 함께 쓰는 도우미.

use std::fs::File;
use std::io::{self, BufRead, BufReader};

/// 명령어 공통 시작 처리 후 인자 목록(프로그램 이름 제외)을 돌려준다.
pub fn args() -> Vec<String> {
    webos::init();
    std::env::args().skip(1).collect()
}

/// `prog: what: 오류 설명` 형식으로 표준 오류에 쓴다.
pub fn warn(prog: &str, what: &str, err: &io::Error) {
    eprintln!("{prog}: {what}: {}", webos::describe(err));
}

/// 파일 목록이 비어 있으면 표준 입력을, 아니면 각 파일을 차례로 연다.
/// 열지 못한 파일은 경고를 내고 건너뛰며, 하나라도 실패하면 false를 돌려준다.
pub fn each_input(prog: &str, files: &[String], mut f: impl FnMut(&str, &mut dyn BufRead) -> io::Result<()>) -> bool {
    let mut ok = true;
    if files.is_empty() {
        if let Err(e) = f("", &mut io::stdin().lock()) {
            warn(prog, "stdin", &e);
            ok = false;
        }
    }
    for path in files {
        let result = File::open(path).and_then(|file| f(path, &mut BufReader::new(file)));
        if let Err(e) = result {
            warn(prog, path, &e);
            ok = false;
        }
    }
    ok
}

/// `-n 5` 또는 `-5` 형태의 줄 수 옵션을 떼어 내고 나머지 인자를 돌려준다.
pub fn take_count(args: Vec<String>, default: usize) -> (usize, Vec<String>) {
    let mut count = default;
    let mut rest = Vec::new();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "-n" {
            count = it.next().and_then(|s| s.parse().ok()).unwrap_or(default);
        } else if let Some(n) = arg.strip_prefix('-').and_then(|s| s.parse().ok()) {
            count = n;
        } else {
            rest.push(arg);
        }
    }
    (count, rest)
}
