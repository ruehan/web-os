// 움직임(애니메이션)의 길이를 한곳에서 정한다.
// 시스템에서 "움직임 줄이기"를 켠 사용자에게는 모든 길이가 0이 되어, 화면이 바로바로 바뀐다.

const query = matchMedia('(prefers-reduced-motion: reduce)')

/** 움직임을 줄여야 하는가 */
export const reducedMotion = () => query.matches

/** 움직임에 쓸 시간(밀리초). 움직임을 줄여야 하면 0이다. CSS의 길이와 맞춰 둔다. */
export const motion = (ms: number) => (query.matches ? 0 : ms)

/** CSS에 정의한 움직임들의 길이 */
export const DURATION = {
  /** 창이 열리며 나타나는 시간 */
  open: 180,
  /** 창이 닫히며 사라지는 시간 */
  close: 150,
  /** 창이 레일 쪽으로 줄어들거나 거기서 다시 커지는 시간 */
  minimize: 220,
  /** 최대화, 가장자리 붙이기, 원래 크기로 돌아가기처럼 창의 자리가 바뀌는 시간 */
  glide: 240,
} as const
