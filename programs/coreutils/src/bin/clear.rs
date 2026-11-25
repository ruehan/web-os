fn main() {
    // 커서를 맨 위로 옮기고 화면과 스크롤 기록을 지운다.
    print!("\x1b[H\x1b[2J\x1b[3J");
}
