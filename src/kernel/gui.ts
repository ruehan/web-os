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
  /** a x, b y, c 버튼 (0 왼쪽, 1 가운데, 2 오른쪽) + 256 × (연달아 누른 횟수 - 1). 두 번 누르기는 c가 256 이상이다. */
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
  /** 입력 칸에 커서가 들어갔거나(b = 1) 나갔다(b = 0). a 칸의 번호. */
  fieldFocus: 10,
  /** menu 명령으로 띄운 메뉴에서 고른 항목. a 항목의 순번(구분선도 센다), 고르지 않고 닫았으면 -1. */
  menu: 11,
  /** 포인터가 창의 그림 밖으로 나갔다 (입력 칸 위로 간 것도 포함). 마우스를 올린 표시를 지울 때 쓴다. */
  pointerLeave: 12,
  /**
   * 입력 칸의 커서가 옮겨졌거나 고른 범위가 바뀌었다. a 칸의 번호, b 시작, c 끝 (글의 UTF-8 바이트 위치. 커서만 있으면 둘이 같다).
   * 글이 바뀌어 옮겨진 경우에는 그 input 이벤트 다음에 온다.
   */
  caret: 13,
  /**
   * 입력 칸의 커서가 창의 어디에 있는지 (칸이 where로 물었을 때만 온다). a 칸의 번호, b x, c y (픽셀. 커서가 있는 줄의 아래쪽).
   * 커서 옆에 고를 것을 띄울 때 쓴다.
   */
  caretAt: 14,
  /**
   * 사용자가 파일을 건넸다 (pick 명령으로 고른 것, 창에 끌어다 놓은 것, 붙여 넣은 것).
   * 파일들은 /tmp/.gui-<pid>/ 아래에 "순번-이름"으로 놓여 있고, 프로그램이 가져간 뒤 지운다.
   * a 놓인 파일의 수, b 너무 커서 받지 않은 파일의 수.
   */
  files: 15,
  /**
   * 바깥 플레이어(player 명령으로 놓은 것)의 상태가 바뀌었거나 재생 위치가 나아갔다.
   * a 상태 (PlayerState), b 지금 위치, c 전체 길이 (밀리초).
   */
  player: 16,
  /** 바깥 플레이어가 영상을 틀지 못했다. a 이유 (유튜브의 오류 코드: 100 없는 영상, 101·150 퍼가기 금지 등, 또는 PLAYER_UNSUPPORTED) */
  playerError: 17,
} as const

/** 사용자가 건넨 파일이 놓이는 폴더 */
export const handoffDir = (pid: number) => `/tmp/.gui-${pid}`
/** 건네받는 파일 하나의 최대 크기. 파일시스템 전체가 메모리에 올라가므로 지나치게 큰 파일은 받지 않는다. */
export const HANDOFF_LIMIT = 20 * 1024 * 1024

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

const Op = { clear: 1, rect: 2, frame: 3, line: 4, circle: 5, text: 6, clip: 7, unclip: 8, field: 9, region: 10, menu: 11, select: 12, overlay: 13, image: 14, pick: 15, copy: 16, open: 17, title: 18, launch: 19, player: 20, playerCommand: 21 } as const

/** playerCommand 명령의 종류 */
export const PlayerCommand = { load: 1, play: 2, pause: 3, seek: 4, volume: 5 } as const
/** player 이벤트의 상태 (유튜브 플레이어의 것과 같다) */
export const PlayerState = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const
/** playerError 이벤트의 코드 가운데, 유튜브의 것이 아닌 것: 이 브라우저에서는 플레이어를 놓을 수 없다 */
export const PLAYER_UNSUPPORTED = 9999

/** 입력 칸의 성질 (field 명령의 flags) */
export const FieldFlag = { multiline: 1, mono: 2, focus: 4, bold: 8, select: 16, keys: 32, grabEnter: 64, where: 128 } as const

/** 글자의 꾸밈 (text 명령의 flags에서 정렬 두 비트 다음) */
export const TextFlag = { bold: 4, mono: 8, italic: 16, strike: 32, underline: 64 } as const

/** region 명령의 역할. 화면 낭독기에 이 자리가 무엇인지 알려 준다. */
/** status와 alert는 누르는 것이 아니라 읽을 글이다 (상태 줄의 안내, 오류). */
export const REGION_ROLES = ['button', 'tab', 'treeitem', 'option', 'checkbox', 'link', 'status', 'alert'] as const
export const RegionFlag = { on: 1, disabled: 2 } as const
export const MenuFlag = { disabled: 1, danger: 2, separator: 4 } as const

export interface TextStyle {
  bold: boolean
  mono: boolean
  italic: boolean
}

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
  | {
      op: 'text'; x: number; y: number; size: number; color: string; align: 'left' | 'center' | 'right'; text: string
      bold: boolean; mono: boolean; italic: boolean; strike: boolean; underline: boolean
    }
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
      bold: boolean
      focus: boolean
      /** focus와 함께: 커서를 옮기면서 글 전체를 고른다 (이름을 바꿀 때) */
      select: boolean
      /**
       * 여러 줄 칸에서: Tab과 Enter를 프로그램에 key 이벤트로 알린다. Tab은 칸의 기본 동작(다음 칸으로 가기)을 하지 않고,
       * Enter는 줄바꿈을 한 뒤에, 그 input과 caret 이벤트 다음에 알린다. 그래서 프로그램이 Enter를 받았을 때는
       * 커서 바로 앞이 방금 들어간 줄바꿈이고, 그 결과를 고칠 수 있다 (목록 이어 쓰기 등).
       */
      keys: boolean
      /** keys와 함께: Enter와 위·아래 방향키를 칸이 쓰지 않고 프로그램에만 알린다 (고를 것이 떠 있을 때) */
      grabEnter: boolean
      /** 커서가 창의 어디에 있는지 caretAt 이벤트로 알려 달라 (켜져 있는 동안, 자리가 바뀔 때마다) */
      where: boolean
      /** 화면 낭독기 등에 알려 줄 이름 */
      label: string
      /** 비어 있을 때 흐리게 보여 줄 글 */
      placeholder: string
    }
  /**
   * 그림의 이 자리가 무엇인지 알린다 (단추, 탭, 목록의 항목 …). 그려지는 것은 없다.
   * 화면 쪽은 이 자리에 보이지 않는 요소를 놓아, 화면 낭독기가 읽고 누를 수 있게 한다.
   * 그 요소 위에서 일어난 입력은 그림 위에서 일어난 것과 똑같이 프로그램에 전해진다.
   * on은 역할에 따라 "골라짐"(탭, 항목), "눌려 있음"(단추), "체크됨"을 뜻한다.
   */
  | { op: 'region'; x: number; y: number; w: number; h: number; role: (typeof REGION_ROLES)[number]; on: boolean; disabled: boolean; label: string }
  /**
   * 이 자리에 시스템의 메뉴를 띄운다. 고른 결과는 menu 이벤트로 온다.
   * 묶음을 받을 때마다 띄우므로, 프로그램은 띄우고 싶을 때의 묶음 하나에만 넣어야 한다.
   */
  /**
   * 입력 칸의 커서를 옮긴다 (start와 end가 다르면 그 사이를 고른다). 자리는 글의 UTF-8 바이트 위치다.
   * 커서가 보이도록 칸을 스크롤하고 그 칸에 초점을 준다. menu처럼 묶음 하나에만 넣는다.
   */
  | { op: 'select'; id: number; start: number; end: number }
  /**
   * 이 뒤의 명령들은 입력 칸보다 위에 그려진다 (입력 칸 위를 덮는 창, 끌고 있는 것의 표시 등).
   * 이 뒤에 놓는 입력 칸은 그 위층보다도 위에 온다.
   */
  | { op: 'overlay' }
  /**
   * 그림 파일을 이 사각형에 맞춰 그린다. 그 전에 guiimage로 크기를 물어 화면 쪽이 읽어 두게 해야 한다
   * (묻지 않은 그림은 그려지지 않는다). path는 그때 물은 경로와 같아야 한다.
   */
  | { op: 'image'; x: number; y: number; w: number; h: number; path: string }
  /**
   * 사용자에게 파일을 고르게 한다 (그림 넣기 등). 고른 파일은 files 이벤트로 건네진다.
   * menu처럼 묶음 하나에만 넣는다. accept는 고를 수 있는 종류 ("image/*" 등), multiple은 여러 개를 고를 수 있는지.
   */
  | { op: 'pick'; multiple: boolean; accept: string }
  /** 글을 클립보드에 넣는다 (링크 복사 등). menu처럼 묶음 하나에만 넣는다. */
  | { op: 'copy'; text: string }
  /** 바깥 사이트의 주소를 브라우저의 새 탭으로 연다 (http, https, mailto만). 묶음 하나에만 넣는다. */
  | { op: 'open'; url: string }
  /** 창의 제목을 바꾼다 (보고 있는 폴더의 이름 등). 바꿀 때의 묶음 하나에만 넣는다. */
  | { op: 'title'; text: string }
  /** 이 파일을 알맞은 앱으로 열어 달라 (파일을 두 번 눌렀을 때). path는 절대 경로다. 묶음 하나에만 넣는다. */
  | { op: 'launch'; path: string }
  /**
   * 이 자리에 바깥 사이트의 영상 플레이어를 놓는다 (유튜브의 공식 플레이어). 입력 칸처럼, 묶음에 들어 있는 동안만 있다.
   * 무엇을 틀지는 playerCommand로 정한다. 프로그램은 영상의 번호만 넘기고, 어느 사이트의 플레이어인지는 화면 쪽이 정한다.
   */
  | { op: 'player'; x: number; y: number; w: number; h: number }
  /**
   * 플레이어에 시키는 일. 시킬 때의 묶음 하나에만 넣는다.
   * load: id의 영상을 불러온다 (value가 1이면 바로 튼다). play, pause. seek: value초로 옮긴다. volume: value(0~100).
   */
  | { op: 'playerCommand'; command: number; value: number; id: string }
  | { op: 'menu'; x: number; y: number; items: { label: string; disabled: boolean; danger: boolean; separator: boolean }[] }

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
  const str = () => {
    const length = u32()
    need(length)
    at += length
    return new TextDecoder().decode(data.subarray(at - length, at))
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
        const text = str()
        ops.push({
          op: 'text', x, y, size, color, align: ALIGN[flags & 3] ?? 'left', text,
          bold: (flags & TextFlag.bold) !== 0,
          mono: (flags & TextFlag.mono) !== 0,
          italic: (flags & TextFlag.italic) !== 0,
          strike: (flags & TextFlag.strike) !== 0,
          underline: (flags & TextFlag.underline) !== 0,
        })
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
        const [label, placeholder] = [str(), str()]
        ops.push({
          op: 'field', id, x, y, w, h, size, color, background, label, placeholder,
          multiline: (flags & FieldFlag.multiline) !== 0,
          mono: (flags & FieldFlag.mono) !== 0,
          bold: (flags & FieldFlag.bold) !== 0,
          focus: (flags & FieldFlag.focus) !== 0,
          select: (flags & FieldFlag.select) !== 0,
          keys: (flags & FieldFlag.keys) !== 0,
          grabEnter: (flags & FieldFlag.grabEnter) !== 0,
          where: (flags & FieldFlag.where) !== 0,
        })
        break
      }
      case Op.region: {
        const [x, y, w, h] = [f32(), f32(), f32(), f32()]
        const [role, flags] = [u8(), u8()]
        ops.push({
          op: 'region', x, y, w, h, label: str(),
          role: REGION_ROLES[role] ?? 'button',
          on: (flags & RegionFlag.on) !== 0,
          disabled: (flags & RegionFlag.disabled) !== 0,
        })
        break
      }
      case Op.menu: {
        const [x, y] = [f32(), f32()]
        const count = u32()
        if (count > 256) throw new RangeError('draw list has a menu with too many items')
        const items = []
        for (let i = 0; i < count; i++) {
          const flags = u8()
          items.push({
            label: str(),
            disabled: (flags & MenuFlag.disabled) !== 0,
            danger: (flags & MenuFlag.danger) !== 0,
            separator: (flags & MenuFlag.separator) !== 0,
          })
        }
        ops.push({ op: 'menu', x, y, items })
        break
      }
      case Op.overlay:
        ops.push({ op: 'overlay' })
        break
      case Op.image:
        ops.push({ op: 'image', x: f32(), y: f32(), w: f32(), h: f32(), path: str() })
        break
      case Op.pick:
        ops.push({ op: 'pick', multiple: u8() !== 0, accept: str() })
        break
      case Op.copy:
        ops.push({ op: 'copy', text: str() })
        break
      case Op.open:
        ops.push({ op: 'open', url: str() })
        break
      case Op.title:
        ops.push({ op: 'title', text: str() })
        break
      case Op.launch:
        ops.push({ op: 'launch', path: str() })
        break
      case Op.player:
        ops.push({ op: 'player', x: f32(), y: f32(), w: f32(), h: f32() })
        break
      case Op.playerCommand:
        ops.push({ op: 'playerCommand', command: u8(), value: f32(), id: str() })
        break
      case Op.select:
        ops.push({ op: 'select', id: u32(), start: u32(), end: u32() })
        break
      default:
        throw new RangeError(`draw list has an unknown command ${op}`)
    }
  }
  return ops
}

// ───────────── 입력 칸의 글에 색 입히기 ─────────────
//
// 입력 칸의 글은 화면 쪽에 있지만, 그 글이 무엇을 뜻하는지(제목인지, 링크인지)는 프로그램이 안다.
// 프로그램은 글의 어느 범위를 무슨 색으로 보일지 보낸다(guistyle). 범위 하나는 13바이트:
// u32 시작, u32 끝 (글의 UTF-8 바이트 위치), u32 색, u8 꾸밈 (1 굵게). 범위들은 겹치지 않고 앞에서부터 차례로 온다.
// 범위에 들지 않은 글은 칸의 기본 색이다.

export interface StyleRange {
  start: number
  end: number
  color: string
  bold: boolean
}

export function decodeStyles(data: Uint8Array): StyleRange[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const ranges: StyleRange[] = []
  for (let at = 0; at + 13 <= data.length; at += 13) {
    ranges.push({ start: view.getUint32(at, true), end: view.getUint32(at + 4, true), color: cssColor(view.getUint32(at + 8, true)), bold: (view.getUint8(at + 12) & 1) !== 0 })
  }
  return ranges
}

/**
 * 글을 색이 붙은 조각들로 나눈다 (조각들을 이으면 원래 글이다). 범위의 자리는 UTF-8 바이트 위치이고,
 * 글이 그사이 바뀌어 맞지 않는 범위는 맞는 데까지만 쓴다.
 */
export function styledPieces(text: string, ranges: StyleRange[]): { text: string; color?: string; bold?: boolean }[] {
  const pieces: { text: string; color?: string; bold?: boolean }[] = []
  let [index, bytes, next] = [0, 0, 0]
  /** 바이트 위치 target까지 글을 읽어 나가고, 거기까지의 글을 돌려준다. */
  const take = (target: number) => {
    const from = index
    while (index < text.length && bytes < target) {
      const code = text.codePointAt(index)!
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
      index += code > 0xffff ? 2 : 1
    }
    return text.slice(from, index)
  }
  for (; next < ranges.length && index < text.length; next++) {
    const range = ranges[next]!
    if (range.start < bytes || range.end <= range.start) continue
    const plain = take(range.start)
    if (plain) pieces.push({ text: plain })
    const colored = take(range.end)
    if (colored) pieces.push({ text: colored, color: range.color, bold: range.bold })
  }
  if (index < text.length) pieces.push({ text: text.slice(index) })
  return pieces
}

// ───────────── 글자 폭 재기 ─────────────
//
// 글자를 그리는 것은 화면 쪽이라, 글이 차지할 폭도 화면 쪽만 안다. 프로그램이 배치를 계산할 수 있게
// 글들의 폭을 물어보는 호출(guimeasure)이 있다. 요청: f32 글자 크기, u8 꾸밈(1 굵게, 2 고정폭, 4 기울임), 그리고 (u32 길이, 글)의 나열.
// 응답: 글마다 f32 폭.

export interface MeasureRequest extends TextStyle {
  size: number
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
  const flags = view.getUint8(4)
  return { size: view.getFloat32(0, true), bold: (flags & 1) !== 0, mono: (flags & 2) !== 0, italic: (flags & 4) !== 0, texts }
}

export const encodeWidths = (widths: number[]) => new Uint8Array(Float32Array.from(widths).buffer)
