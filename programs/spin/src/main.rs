use std::time::{Duration, Instant};

// CPU를 계속 점유하는 프로세스. 블로킹 없이 도는 동안에도 UI가 멈추지 않고,
// kill로 실제 종료되는지 확인하는 용도다.
fn main() {
    let start = Instant::now();
    let mut next = Duration::from_secs(0);
    let mut n: u64 = 0;
    loop {
        n = n.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let elapsed = start.elapsed();
        if elapsed >= next {
            println!("spinning... {}s (n = {n})", elapsed.as_secs());
            next += Duration::from_secs(1);
        }
    }
}
