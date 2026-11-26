// 프로세스가 창에 그림을 그리고 입력을 받는 규약.
//
// 프로세스는 창을 하나 열고(guiopen), 그릴 것들을 한 묶음으로 보내고(guidraw), 입력을 기다린다(guievent).
// 묶음은 "이런 도형과 글자를 그려라"는 명령의 나열이다. 픽셀이 아니라 명령을 보내므로 글자는 화면 쪽의
// 글꼴로 그려지고(한글 포함), 화면 배율이 달라도 선명하다. 좌표는 모두 창 안쪽의 CSS 픽셀이다.
//
// 커널은 내용을 해석하지 않고 프로세스와 화면 사이를 이어 주기만 한다. 해석은 여기의 함수들이 한다.

/** 입력 이벤트 하나의 크기: i32 네 개 (종류, a, b, c) */
export const EVENT_BYTES = 16

export const GuiEvent = {
  /** a 너비, b 높이, c 어두운 테마면 1. 창이 열린 직후와 크기·테마가 바뀔 때 온다. */
  resize: 1,
  // 포인터의 x, y는 1/16 픽셀 단위다 (POINTER_SCALE). 정수 픽셀로 반올림하면 손으로 그은 선이 계단처럼 보인다.
  /** a x, b y, c 버튼 (0 왼쪽, 1 가운데, 2 오른쪽) */
  pointerDown: 2,
  /** a x, b y, c 눌린 버튼들 */
  pointerMove: 3,
  /** a x, b y */
  pointerUp: 4,
  /** a 글자의 코드(유니코드) 또는 음수인 특수 키, b 함께 누른 키들 (Mod) */
  key: 5,
  /** 사용자가 창을 닫으려 한다. 정리한 뒤 종료해야 한다. */
  close: 6,
  /** 마우스 휠이나 두 손가락 밀기. a x, b y (포인터와 같은 단위), c 세로로 민 양 (픽셀, 아래가 양수) */
  wheel: 7,
  /** 입력 칸의 글이 바뀌었다. a 칸의 번호, b 글의 길이(바이트). 글은 guitext로 가져간다. */
  input: 8,
  /** 창이 입력을 받게 됐거나(a = 1) 다른 창으로 넘어갔다(a = 0). */
  focus: 9,
} as const

/** key 이벤트의 특수 키 */
export const Key = {
  Backspace: -1,
  Enter: -2,
  Escape: -3,
  Tab: -4,
  ArrowLeft: -5,
  ArrowRight: -6,
  ArrowUp: -7,
  ArrowDown: -8,
  Delete: -9,
  Home: -10,
  End: -11,
} as const

export const Mod = { shift: 1, ctrl: 2, alt: 4, meta: 8 } as const

/** 포인터 좌표의 정밀도: 1픽셀을 이만큼으로 나눈다. */
export const POINTER_SCALE = 16

/** 포인터 이벤트 (x, y는 CSS 픽셀, 소수 가능) */
export const encodePointer = (kind: number, x: number, y: number, c = 0) => encodeEvent(kind, x * POINTER_SCALE, y * POINTER_SCALE, c)

export function encodeEvent(kind: number, a = 0, b = 0, c = 0): Uint8Array {
  return new Uint8Array(Int32Array.of(kind, Math.round(a), Math.round(b), Math.round(c)).buffer)
}

/** 브라우저의 키 이벤트를 규약의 키 코드로 바꾼다. 전할 수 없는 키(Shift만 누른 것 등)는 undefined. */
export function keyCode(key: string): number | undefined {
  if (key in Key) return Key[key as keyof typeof Key]
  const chars = [...key]
  return chars.length === 1 ? chars[0]!.codePointAt(0) : undefined
}

// ───────────── 그리기 명령 ─────────────

const Op = { clear: 1, rect: 2, frame: 3, line: 4, circle: 5, text: 6, clip: 7, unclip: 8, field: 9 } as const

/** 입력 칸의 성질 (field 명령의 flags) */
export const FieldFlag = { multiline: 1, mono: 2, focus: 4 } as const

export type DrawOp =
  /** 창 전체를 한 색으로 채운다. */
  | { op: 'clear'; color: string }
  /** 채운 사각형. radius는 모서리의 둥글기. */
  | { op: 'rect'; x: number; y: number; w: number; h: number; radius: number; color: string }
  /** 테두리만 있는 사각형 */
  | { op: 'frame'; x: number; y: number; w: number; h: number; radius: number; color: string; width: number }
  /** 점들을 잇는 선 (끝과 꺾이는 곳은 둥글다). points는 x, y가 번갈아 온다. */
  | { op: 'line'; points: number[]; color: string; width: number }
  | { op: 'circle'; x: number; y: number; r: number; color: string }
  /** y는 글자의 세로 가운데다. */
  | { op: 'text'; x: number; y: number; size: number; color: string; align: 'left' | 'center' | 'right'; bold: boolean; text: string }
  /** 이 뒤로는 사각형 안에만 그려진다 (unclip까지). 스크롤되는 목록 등에 쓴다. */
  | { op: 'clip'; x: number; y: number; w: number; h: number }
  | { op: 'unclip' }
  /**
   * 이 자리에 글 입력 칸을 놓는다. 칸은 화면 쪽의 실제 입력 칸이라 한글 조합, 선택, 복사·붙여넣기가 그대로 된다.
   * 글의 내용은 그리기 명령에 싣지 않는다: 프로그램이 정할 때는 guisettext, 사용자가 고치면 input 이벤트로 오간다.
   * 묶음에 들어 있는 동안만 칸이 있고, 빠지면 사라진다. focus를 켠 묶음을 받으면 그 칸으로 커서를 옮기므로,
   * 프로그램은 커서를 옮기고 싶을 때의 묶음 하나에만 켜야 한다.
   */
  | {
      op: 'field'
      id: number
      x: number
      y: number
      w: number
      h: number
      size: number
      color: string
      background: string
      multiline: boolean
      mono: boolean
      focus: boolean
      /** 화면 낭독기 등에 알려 줄 이름 */
      label: string
    }

const ALIGN = ['left', 'center', 'right'] as const
/** 명령 하나가 가질 수 있는 점의 수. 망가진 묶음이 메모리를 다 쓰지 않게 막는다. */
const MAX_POINTS = 1 << 20

const cssColor = (rgba: number) => {
  const hex = (rgba >>> 8).toString(16).padStart(6, '0')
  const alpha = rgba & 0xff
  return alpha === 0xff ? `#${hex}` : `#${hex}${alpha.toString(16).padStart(2, '0')}`
}

/**
 * 프로세스가 보낸 묶음을 그리기 명령들로 푼다. 형식이 맞지 않으면 오류를 던진다
 * (프로그램의 버그이므로, 화면 쪽은 그 묶음을 버리면 된다).
 */
export function decodeDrawList(data: Uint8Array): DrawOp[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const ops: DrawOp[] = []
  let at = 0
  const need = (n: number) => {
    if (at + n > data.length) throw new RangeError('draw list ends in the middle of a command')
  }
  const u8 = () => (need(1), view.getUint8(at++))
  const u32 = () => {
    need(4)
    at += 4
    return view.getUint32(at - 4, true)
  }
  const f32 = () => {
    need(4)
    at += 4
    return view.getFloat32(at - 4, true)
  }
  while (at < data.length) {
    const op = u8()
    switch (op) {
      case Op.clear:
        ops.push({ op: 'clear', color: cssColor(u32()) })
        break
      case Op.rect:
        ops.push({ op: 'rect', x: f32(), y: f32(), w: f32(), h: f32(), radius: f32(), color: cssColor(u32()) })
        break
      case Op.frame:
        ops.push({ op: 'frame', x: f32(), y: f32(), w: f32(), h: f32(), radius: f32(), color: cssColor(u32()), width: f32() })
        break
      case Op.line: {
        const color = cssColor(u32())
        const width = f32()
        const count = u32()
        if (count > MAX_POINTS) throw new RangeError('draw list has a line with too many points')
        need(count * 8)
        const points: number[] = []
        for (let i = 0; i < count * 2; i++) points.push(f32())
        ops.push({ op: 'line', points, color, width })
        break
      }
      case Op.circle:
        ops.push({ op: 'circle', x: f32(), y: f32(), r: f32(), color: cssColor(u32()) })
        break
      case Op.text: {
        const [x, y, size] = [f32(), f32(), f32()]
        const color = cssColor(u32())
        const flags = u8()
        const length = u32()
        need(length)
        const text = new TextDecoder().decode(data.subarray(at, at + length))
        at += length
        ops.push({ op: 'text', x, y, size, color, align: ALIGN[flags & 3] ?? 'left', bold: (flags & 4) !== 0, text })
        break
      }
      case Op.clip:
        ops.push({ op: 'clip', x: f32(), y: f32(), w: f32(), h: f32() })
        break
      case Op.unclip:
        ops.push({ op: 'unclip' })
        break
      case Op.field: {
        const id = u32()
        const [x, y, w, h, size] = [f32(), f32(), f32(), f32(), f32()]
        const [color, background] = [cssColor(u32()), cssColor(u32())]
        const flags = u8()
        const length = u32()
        need(length)
        const label = new TextDecoder().decode(data.subarray(at, at + length))
        at += length
        ops.push({
          op: 'field', id, x, y, w, h, size, color, background, label,
          multiline: (flags & FieldFlag.multiline) !== 0,
          mono: (flags & FieldFlag.mono) !== 0,
          focus: (flags & FieldFlag.focus) !== 0,
        })
        break
      }
      default:
        throw new RangeError(`draw list has an unknown command ${op}`)
    }
  }
  return ops
}

// ───────────── 글자 폭 재기 ─────────────
//
// 글자를 그리는 것은 화면 쪽이라, 글이 차지할 폭도 화면 쪽만 안다. 프로그램이 배치를 계산할 수 있게
// 글들의 폭을 물어보는 호출(guimeasure)이 있다. 요청: f32 글자 크기, u8 굵게, 그리고 (u32 길이, 글)의 나열.
// 응답: 글마다 f32 폭.

export interface MeasureRequest {
  size: number
  bold: boolean
  texts: string[]
}

export function decodeMeasure(data: Uint8Array): MeasureRequest {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length < 5) throw new RangeError('measure request is too short')
  const texts: string[] = []
  let at = 5
  while (at + 4 <= data.length) {
    const length = view.getUint32(at, true)
    at += 4
    if (at + length > data.length) throw new RangeError('measure request ends in the middle of a text')
    texts.push(new TextDecoder().decode(data.subarray(at, at + length)))
    at += length
  }
  return { size: view.getFloat32(0, true), bold: view.getUint8(4) !== 0, texts }
}

export const encodeWidths = (widths: number[]) => new Uint8Array(Float32Array.from(widths).buffer)
