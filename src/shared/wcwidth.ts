// 문자가 터미널에서 차지하는 칸 수. 한글·한자 등은 2칸, 결합 문자는 0칸이다.
// TTY(지우기 에코)와 터미널 화면이 같은 기준을 써야 커서 위치가 어긋나지 않는다.
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const ZERO: [number, number][] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
]

const within = (ranges: [number, number][], cp: number) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

export function charWidth(ch: string): 0 | 1 | 2 {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x300) return 1
  if (within(ZERO, cp)) return 0
  return within(WIDE, cp) ? 2 : 1
}
