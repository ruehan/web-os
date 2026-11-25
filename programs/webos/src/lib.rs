//! WASI에 없는 커널 기능(프로세스 생성, 파이프, 터미널 제어)을 감싼 라이브러리.

pub mod term;

use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

#[link(wasm_import_module = "webos")]
extern "C" {
    #[link_name = "spawn"]
    fn sys_spawn(req: *const u8, len: usize) -> i32;
    #[link_name = "wait"]
    fn sys_wait(pid: i32, flags: u32, status: *mut i32) -> i32;
    #[link_name = "pipe"]
    fn sys_pipe(fds: *mut u32) -> i32;
    #[link_name = "setfg"]
    fn sys_setfg(pgid: i32) -> i32;
    #[link_name = "getpid"]
    fn sys_getpid() -> i32;
    #[link_name = "kill"]
    fn sys_kill(pid: i32) -> i32;
    #[link_name = "set_raw"]
    fn sys_set_raw(on: i32) -> i32;
    #[link_name = "winsize"]
    fn sys_winsize(size: *mut u32) -> i32;
}

const WAIT_NOHANG: u32 = 1;

/// spawn의 pgid: 새 프로세스 그룹을 만든다.
pub const PGID_NEW: i32 = 0;
/// spawn의 pgid: 부모의 프로세스 그룹을 물려받는다.
pub const PGID_INHERIT: i32 = -1;

fn check(ret: i32) -> io::Result<i32> {
    if ret < 0 {
        Err(io::Error::from_raw_os_error(-ret))
    } else {
        Ok(ret)
    }
}

/// 프로그램 시작 때 한 번 부른다. 부모가 PWD로 넘겨준 작업 디렉터리로 이동한다.
/// (WASI에는 작업 디렉터리 개념이 없어서 프로세스마다 직접 맞춰야 한다.)
pub fn init() {
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(pwd);
    }
}

pub struct Spawn<'a> {
    /// 실행 파일의 절대 경로
    pub path: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
    pub stdin: RawFd,
    pub stdout: RawFd,
    pub stderr: RawFd,
    pub pgid: i32,
    /// 새 프로세스의 그룹을 터미널의 전경 그룹으로 만든다.
    pub foreground: bool,
}

/// 새 프로세스를 띄우고 pid를 돌려준다. 표준 입출력만 물려준다.
pub fn spawn(cmd: &Spawn) -> io::Result<i32> {
    let mut req = Vec::new();
    for n in [cmd.stdin, cmd.stdout, cmd.stderr, cmd.pgid, cmd.foreground as i32] {
        req.extend_from_slice(&n.to_le_bytes());
    }
    req.extend_from_slice(&(cmd.args.len() as u32).to_le_bytes());
    req.extend_from_slice(&(cmd.env.len() as u32).to_le_bytes());
    let mut push = |s: &str| {
        req.extend_from_slice(&(s.len() as u32).to_le_bytes());
        req.extend_from_slice(s.as_bytes());
    };
    push(cmd.path);
    for arg in cmd.args {
        push(arg);
    }
    for (k, v) in cmd.env {
        push(&format!("{k}={v}"));
    }
    check(unsafe { sys_spawn(req.as_ptr(), req.len()) })
}

/// 자식이 끝날 때까지 기다려 종료 코드를 돌려준다.
pub fn wait(pid: i32) -> io::Result<i32> {
    let mut status = 0;
    check(unsafe { sys_wait(pid, 0, &mut status) })?;
    Ok(status)
}

/// 이미 끝난 자식이 있으면 (pid, 종료 코드)를 돌려준다. 기다리지 않는다.
pub fn try_wait_any() -> Option<(i32, i32)> {
    let mut status = 0;
    match unsafe { sys_wait(-1, WAIT_NOHANG, &mut status) } {
        pid if pid > 0 => Some((pid, status)),
        _ => None,
    }
}

/// (읽기 끝, 쓰기 끝)
pub fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0u32; 2];
    check(unsafe { sys_pipe(fds.as_mut_ptr()) })?;
    unsafe { Ok((OwnedFd::from_raw_fd(fds[0] as RawFd), OwnedFd::from_raw_fd(fds[1] as RawFd))) }
}

/// 터미널의 키보드 입력을 받을 전경 프로세스 그룹을 지정한다.
pub fn set_foreground(pgid: i32) -> io::Result<()> {
    check(unsafe { sys_setfg(pgid) }).map(|_| ())
}

pub fn getpid() -> i32 {
    unsafe { sys_getpid() }
}

pub fn kill(pid: i32) -> io::Result<()> {
    check(unsafe { sys_kill(pid) }).map(|_| ())
}

/// 터미널을 키 단위 입력 모드로 바꾼다. 켜면 키 입력이 에코나 줄 편집 없이 바로 전달되고,
/// Ctrl+C도 일반 키로 들어온다. 끝나면 반드시 꺼야 다른 프로그램이 정상 동작한다.
pub fn set_raw(on: bool) -> io::Result<()> {
    check(unsafe { sys_set_raw(on as i32) }).map(|_| ())
}

/// 터미널 크기 (열, 줄). 터미널이 없으면 80×24로 본다.
pub fn window_size() -> (usize, usize) {
    let mut size = [80u32, 24];
    unsafe { sys_winsize(size.as_mut_ptr()) };
    (size[0].max(1) as usize, size[1].max(1) as usize)
}

/// 글자가 터미널에서 차지하는 칸 수. 터미널 화면(src/shared/wcwidth.ts)과 같은 기준이어야 한다.
pub fn char_width(c: char) -> usize {
    const WIDE: [(u32, u32); 14] = [
        (0x1100, 0x115f),
        (0x2e80, 0x303e),
        (0x3041, 0x33ff),
        (0x3400, 0x4dbf),
        (0x4e00, 0x9fff),
        (0xa000, 0xa4cf),
        (0xac00, 0xd7a3),
        (0xf900, 0xfaff),
        (0xfe30, 0xfe4f),
        (0xff00, 0xff60),
        (0xffe0, 0xffe6),
        (0x1f300, 0x1f64f),
        (0x1f900, 0x1f9ff),
        (0x20000, 0x3fffd),
    ];
    const ZERO: [(u32, u32); 3] = [(0x0300, 0x036f), (0x200b, 0x200f), (0xfe00, 0xfe0f)];
    let cp = c as u32;
    let within = |ranges: &[(u32, u32)]| ranges.iter().any(|&(lo, hi)| cp >= lo && cp <= hi);
    if cp < 0x300 {
        1
    } else if within(&ZERO) {
        0
    } else if within(&WIDE) {
        2
    } else {
        1
    }
}

/// "No such file or directory (os error 44)" 에서 괄호 부분을 뗀 메시지.
pub fn describe(err: &io::Error) -> String {
    let text = err.to_string();
    match text.find(" (os error") {
        Some(i) => text[..i].to_string(),
        None => text,
    }
}
