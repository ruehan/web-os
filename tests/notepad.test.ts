// 화면 통로의 입력 칸, 스크롤, 글자 폭 재기. 실제 메모장 바이너리(programs/notepad)로 확인한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KernelEvent } from '../src/kernel/abi.ts'
import { GuiEvent, Mod, decodeDrawList, decodeMeasure, encodeEvent, encodePointer, keyCode, type DrawOp } from '../src/kernel/gui.ts'
import { boot } from './host.ts'

type Host = ReturnType<typeof boot>
let host: Host

beforeEach(() => {
  host = boot()
})
afterEach(() => host.shutdown())

type Of<T extends KernelEvent['type']> = Extract<KernelEvent, { type: T }>
const all = <T extends KernelEvent['type']>(type: T, pid: number) =>
  host.events.filter((e): e is Of<T> => e.type === type && 'pid' in e && e.pid === pid)
const utf8 = (text: string) => new TextEncoder().encode(text)
const file = (path: string) => new TextDecoder().decode(host.kernel.fs.readFile(`/home/guest/notes/${path}`))
const write = (path: string, text: string) => {
  host.kernel.fs.mkdirp(`/home/guest/notes/${path}`.slice(0, `/home/guest/notes/${path}`.lastIndexOf('/')))
  host.kernel.fs.writeFile(`/home/guest/notes/${path}`, utf8(text))
}

async function openNotepad(...args: string[]) {
  const pid = host.kernel.launch('/bin/notepad', ['notepad', ...args])
  await host.until(() => all('gui-draw', pid).length > 0, 'first frame')
  const latest = () => decodeDrawList(all('gui-draw', pid).at(-1)!.data)
  const texts = () => latest().flatMap((op) => (op.op === 'text' ? [op.text] : []))
  return {
    pid,
    latest,
    texts,
    field: () => latest().find((op) => op.op === 'field') as Extract<DrawOp, { op: 'field' }> | undefined,
    /** 프로그램이 입력 칸에 넣은 글 (가장 최근 것) */
    shown: () => {
      const set = all('gui-text', pid).at(-1)
      return set && new TextDecoder().decode(set.data)
    },
    click: (x: number, y: number) => host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerDown, x, y, 0)),
    wheel: (x: number, y: number, dy: number) => host.kernel.guiEvent(pid, encodePointer(GuiEvent.wheel, x, y, dy)),
    send: (kind: number, a = 0, b = 0, c = 0) => host.kernel.guiEvent(pid, encodeEvent(kind, a, b, c)),
    /** 사용자가 입력 칸의 글을 고친 것처럼 한다. */
    type: (text: string) => host.kernel.guiText(pid, 1, utf8(text)),
    see: (text: string) => host.until(() => texts().includes(text), `"${text}" on screen`),
  }
}

describe('notepad', () => {
  it('lists the notes in the vault, including those in folders', async () => {
    write('장보기.md', '우유')
    write('회의록.txt', '안건')
    write('프로젝트/계획.md', '할 일')
    write('.숨김.md', '')
    write('attachments/그림.png', '')
    const pad = await openNotepad()
    expect(all('gui-open', pad.pid)[0]).toMatchObject({ title: '메모장', w: 760, h: 500 })
    expect(pad.texts()).toEqual(['새 메모', '장보기', '프로젝트/계획', '회의록.txt', '왼쪽에서 메모를 고르거나 새 메모를 만드세요'])
    expect(pad.field()).toBeUndefined()
  })

  it('opens a note into a real input field and shows its name', async () => {
    write('장보기.md', '- 우유\n- 빵')
    const pad = await openNotepad()
    pad.click(60, 44 + 15)
    await pad.see('저장됨')
    expect(pad.shown()).toBe('- 우유\n- 빵')
    // 글의 내용은 그리기 명령에 들어 있지 않다. 칸의 자리와 모양만 있다.
    expect(pad.field()).toEqual({
      op: 'field', id: 1, x: 228, y: 56, w: 514, h: 432, size: 14, color: '#191a20', background: '#ffffff',
      multiline: true, mono: false, focus: true, label: '메모 내용',
    })
    // 고른 메모는 목록에서 굵게, 제목 줄에도 굵게 나온다.
    expect(pad.latest().filter((op) => op.op === 'text' && op.text === '장보기')).toMatchObject([{ bold: true, size: 13 }, { bold: true, size: 15 }])
  })

  it('saves what is typed after a pause, and says so', async () => {
    write('일기.md', '')
    const pad = await openNotepad('일기.md')
    await pad.see('저장됨')
    pad.type('오늘은')
    await pad.see('저장 중…')
    expect(file('일기.md')).toBe('')
    pad.type('오늘은 맑음')
    await host.until(() => file('일기.md') === '오늘은 맑음', 'the file to be written')
    await pad.see('저장됨')
    // 커서를 주는 것은 칸이 처음 나타날 때 한 번뿐이다 (칠 때마다 커서를 빼앗지 않는다).
    expect(pad.field()!.focus).toBe(false)
  })

  it('saves at once on Ctrl+S, when switching notes, and when closing', async () => {
    write('가.md', 'A')
    write('나.md', 'B')
    const pad = await openNotepad('가.md')
    await pad.see('저장됨')
    pad.type('A 고침')
    pad.send(GuiEvent.key, keyCode('s'), Mod.ctrl)
    await host.until(() => file('가.md') === 'A 고침', 'save on Ctrl+S')

    pad.type('A 다시 고침')
    pad.click(60, 44 + 30 + 15) // 두 번째 메모
    await host.until(() => pad.shown() === 'B', 'the other note')
    expect(file('가.md')).toBe('A 다시 고침')

    pad.type('B 고침')
    pad.send(GuiEvent.close)
    await host.until(() => all('exit', pad.pid).length > 0, 'exit')
    expect(file('나.md')).toBe('B 고침')
  })

  it('reads a long note in pieces without losing any of it', async () => {
    write('긴 글.md', '')
    const pad = await openNotepad('긴 글.md')
    await pad.see('저장됨')
    // 응답 한 번에 실을 수 있는 크기(64KB)보다 훨씬 긴 글
    const long = Array.from({ length: 30_000 }, (_, i) => `${i}번째 줄입니다`).join('\n')
    expect(utf8(long).length).toBeGreaterThan(500_000)
    pad.type(long)
    await host.until(() => file('긴 글.md').length === long.length, 'the long note to be saved', 8000)
    expect(file('긴 글.md')).toBe(long)
  })

  it('keeps only the latest text when typing outpaces the program', async () => {
    write('빠름.md', '')
    const pad = await openNotepad('빠름.md')
    await pad.see('저장됨')
    for (let i = 1; i <= 200; i++) pad.type('가'.repeat(i))
    await host.until(() => file('빠름.md') === '가'.repeat(200), 'the final text')
  })

  it('creates a new note with a free name and opens it', async () => {
    write('새 메모.md', '이미 있음')
    const pad = await openNotepad()
    pad.click(30, 22)
    await pad.see('새 메모 2')
    await pad.see('저장됨')
    expect(file('새 메모 2.md')).toBe('')
    expect(pad.shown()).toBe('')
    expect(file('새 메모.md')).toBe('이미 있음')
  })

  it('scrolls a long list with the wheel, drawing only the visible rows', async () => {
    for (let i = 1; i <= 60; i++) write(`메모 ${String(i).padStart(2, '0')}.md`, '')
    const pad = await openNotepad()
    const rows = () => pad.texts().filter((t) => t.startsWith('메모 '))
    // 높이 456인 목록에 30짜리 줄: 16줄이 걸친다.
    expect(rows()).toHaveLength(16)
    expect(rows()[0]).toBe('메모 01')
    expect(pad.latest()).toContainEqual({ op: 'clip', x: 0, y: 44, w: 210, h: 456 })

    pad.wheel(60, 200, 300)
    await pad.see('메모 26')
    expect(rows()[0]).toBe('메모 11')
    // 끝을 넘겨 밀어도 마지막 줄에서 멈춘다.
    pad.wheel(60, 200, 99999)
    await pad.see('메모 60')
    const last = pad.latest().find((op) => op.op === 'text' && op.text === '메모 60') as Extract<DrawOp, { op: 'text' }>
    expect(last.y).toBe(500 - 15)
    // 밀린 만큼 누르는 자리도 옮겨진다.
    pad.click(60, 500 - 15)
    await pad.see('저장됨')
    expect(pad.latest().filter((op) => op.op === 'text' && op.text === '메모 60' && op.bold)).toHaveLength(2)
    // 글 쪽에서 굴린 휠은 목록을 움직이지 않는다 (입력 칸이 알아서 스크롤한다).
    const before = all('gui-draw', pad.pid).length
    pad.wheel(500, 200, -300)
    await new Promise((r) => setTimeout(r, 80))
    expect(all('gui-draw', pad.pid)).toHaveLength(before)
  })

  it('asks the display how wide text is, and shortens names that do not fit', async () => {
    write('아주아주아주아주아주아주아주아주 긴 이름의 메모.md', '')
    write('짧음.md', '')
    const pad = await openNotepad()
    const asked = all('gui-measure', pad.pid).map((e) => decodeMeasure(e.data))
    expect(asked[0]).toEqual({ size: 13, bold: false, texts: ['새 메모'] })
    expect(asked[1]).toEqual({ size: 13, bold: false, texts: ['아주아주아주아주아주아주아주아주 긴 이름의 메모', '짧음'] })
    // 테스트의 화면은 한글 한 글자를 글자 크기만큼(13)으로 잰다. 목록의 폭은 178이다.
    const shortened = pad.texts().find((t) => t.startsWith('아주'))!
    expect(shortened.endsWith('…')).toBe(true)
    expect([...shortened].length).toBeLessThan(15)
    expect(pad.texts()).toContain('짧음')
    // 단추의 폭은 잰 글의 폭에 맞춰진다: 글 3글자 반(45.5) + 여백 24.
    expect(pad.latest()).toContainEqual({ op: 'rect', x: 10, y: 8, w: 69.5, h: 28, radius: 6, color: '#ffffff' })

    // 같은 글은 다시 묻지 않는다.
    const count = all('gui-measure', pad.pid).length
    pad.send(GuiEvent.resize, 800, 500, 0)
    await host.until(() => pad.latest().some((op) => op.op === 'text' && op.x === 210 + (800 - 210) / 2), 'redraw')
    expect(all('gui-measure', pad.pid)).toHaveLength(count)
  })

  it('picks up changes made elsewhere when its window comes back to the front', async () => {
    write('공유.md', '처음')
    const pad = await openNotepad('공유.md')
    await pad.see('저장됨')
    await host.sh('echo 터미널에서 > notes/공유.md; echo x > notes/새로.md')
    pad.send(GuiEvent.focus, 1)
    await pad.see('새로')
    expect(pad.shown()).toBe('터미널에서\n')

    // 치고 있던 것이 있으면 덮어쓰지 않는다.
    pad.type('내가 치는 중')
    await host.sh('echo 다른 내용 > notes/공유.md')
    pad.send(GuiEvent.focus, 1)
    await host.until(() => file('공유.md') === '내가 치는 중', 'my text to win')
    expect(pad.shown()).toBe('터미널에서\n')
  })

  it('saves at once when its window loses focus', async () => {
    write('초점.md', '')
    const pad = await openNotepad('초점.md')
    await pad.see('저장됨')
    pad.type('넘어가기 전')
    pad.send(GuiEvent.focus, 0)
    // 0.5초의 기다림 없이 바로 저장된다.
    await host.until(() => file('초점.md') === '넘어가기 전', 'save on blur', 300)
  })

  it('reports a file that cannot be opened instead of crashing', async () => {
    const pad = await openNotepad('없는 파일.md')
    expect(pad.texts()).toContain('열지 못했습니다: No such file or directory')
    expect(host.kernel.pids()).toContain(pad.pid)
  })

  it('its field calls show up in the system call trace', async () => {
    write('추적.md', '내용')
    host.kernel.setTracing(true)
    const pad = await openNotepad('추적.md')
    pad.type('고침')
    await host.until(() => file('추적.md') === '고침', 'save')
    pad.send(GuiEvent.close)
    await host.until(() => host.events.some((e) => e.type === 'trace' && e.records.some((r) => r.pid === pad.pid && r.call === 'exit')), 'trace')
    const shown = host.events.flatMap((e) => (e.type === 'trace' ? e.records : [])).filter((r) => r.pid === pad.pid).map((r) => `${r.call}(${r.args}) ${r.result}`)
    expect(shown).toContain('guisettext(1, "내용", 6) = 0')
    // 요청: 글자 크기와 굵기 5바이트 + 길이 4바이트 + "새 메모" 10바이트
    expect(shown).toContain('guimeasure(19 bytes) = 1 widths')
    expect(shown).toContain('guievent() = input(1, 6, 0)')
    expect(shown).toContain('guitext(1, 0, 32768) = 6')
  })
})
