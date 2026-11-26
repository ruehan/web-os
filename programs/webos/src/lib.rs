//! WASI에 없는 커널 기능(프로세스 생성, 파이프, 터미널 제어, 창)을 감싼 라이브러리.

pub mod gui;
pub mod markdown;
pub mod term;
pub mod ui;

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
    #[link_name = "signal"]
    fn sys_signal(pid: i32, sig: i32) -> i32;
    #[link_name = "fetch"]
    fn sys_fetch(url: *const u8, len: usize, head: i32, status: *mut u32, text: *mut u8, cap: usize, text_len: *mut u32) -> i32;
    #[link_name = "set_raw"]
    fn sys_set_raw(on: i32) -> i32;
    #[link_name = "winsize"]
    fn sys_winsize(size: *mut u32) -> i32;
}

const WAIT_NOHANG: u32 = 1;
const WAIT_UNTRACED: u32 = 2;
/// wait가 "끝난 것이 아니라 멈췄다"고 알릴 때의 값
const WAIT_STOPPED: i32 = 0x1000;

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

/// 기다리던 자식에게 일어난 일
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Waited {
    /// 끝났다 (종료 코드)
    Exited(i32),
    /// 멈췄다 (Ctrl+Z 등). 아직 살아 있고, `signal(pid, Signal::Cont)`로 다시 움직일 수 있다.
    Stopped,
}

/// 자식이 끝나거나 멈출 때까지 기다린다 (셸이 전경의 작업을 기다릴 때 쓴다).
pub fn wait_job(pid: i32) -> io::Result<Waited> {
    let mut status = 0;
    check(unsafe { sys_wait(pid, WAIT_UNTRACED, &mut status) })?;
    Ok(if status == WAIT_STOPPED { Waited::Stopped } else { Waited::Exited(status) })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Signal {
    /// 끝낸다
    Term = 0,
    /// 멈춘 것을 다시 움직인다
    Cont = 18,
    /// 멈춘다. 프로세스는 다음 시스템 콜에서 선다 (계산만 하는 동안에는 서지 않는다).
    Stop = 19,
}

pub fn signal(pid: i32, signal: Signal) -> io::Result<()> {
    check(unsafe { sys_signal(pid, signal as i32) }).map(|_| ())
}

/// 네트워크에서 받아 온 응답
pub struct Response {
    pub status: u16,
    /// "이름: 값" 줄들
    pub headers: String,
    /// 본문. 끝까지 읽으면 된다.
    pub body: std::fs::File,
}

/// 주소(http, https)의 내용을 받아 온다. 받아 오는 것은 커널이고, 다 받을 때까지 멈춰 기다린다.
/// `head`면 본문 없이 머리글만 받는다. 실패하면 그 이유를 돌려준다.
pub fn fetch(url: &str, head: bool) -> Result<Response, String> {
    let mut status = 0u32;
    let mut text = vec![0u8; 16 * 1024];
    let mut text_len = 0u32;
    let fd = unsafe { sys_fetch(url.as_ptr(), url.len(), head as i32, &mut status, text.as_mut_ptr(), text.len(), &mut text_len) };
    let text = String::from_utf8_lossy(&text[..text_len as usize]).into_owned();
    if fd < 0 {
        return Err(if text.is_empty() { describe(&io::Error::from_raw_os_error(-fd)) } else { text });
    }
    let body = unsafe { std::fs::File::from_raw_fd(fd as RawFd) };
    Ok(Response { status: status as u16, headers: text, body })
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
