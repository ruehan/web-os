// 음악 앱(programs/music): 목록과 재생 순서는 프로세스가 정하고, 영상과 소리는 화면 쪽이 놓아 주는 바깥 플레이어가 낸다.
// 여기서는 화면 쪽 대신 플레이어의 상태를 알려 주면서, 프로그램이 플레이어에 무엇을 시키는지 본다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KernelEvent } from '../src/kernel/abi.ts'
import { GuiEvent, PLAYER_UNSUPPORTED, PlayerCommand, PlayerState, decodeDrawList, encodeEvent, encodePointer, keyCode, type DrawOp } from '../src/kernel/gui.ts'
import { PAGES, boot } from './host.ts'

type Host = ReturnType<typeof boot>
let host: Host

beforeEach(() => {
  host = boot()
})
afterEach(() => host.shutdown())

type Of<T extends KernelEvent['type']> = Extract<KernelEvent, { type: T }>
type Op<T extends DrawOp['op']> = Extract<DrawOp, { op: T }>
const all = <T extends KernelEvent['type']>(type: T, pid: number) =>
  host.events.filter((e): e is Of<T> => e.type === type && 'pid' in e && e.pid === pid)
const write = (path: string, text: string) => {
  host.kernel.fs.mkdirp(path.slice(0, path.lastIndexOf('/')))
  host.kernel.fs.writeFile(path, new TextEncoder().encode(text))
}
const LIBRARY = '/usr/share/music/library.txt'
const THREE = '# 첫 목록\naaaaaaaaaa1 | 하나 | 가\naaaaaaaaaa2 | 둘 | 나\naaaaaaaaaa3 | 셋 | 다\n# 둘째 목록\nbbbbbbbbbb1 | 넷 | 라\n'

async function openMusic(...args: string[]) {
  const pid = host.kernel.launch('/bin/music', ['music', ...args])
  await host.until(() => all('gui-draw', pid).length > 0, 'first frame')
  const frames = () => all('gui-draw', pid).map((e) => decodeDrawList(e.data))
  const latest = () => frames().at(-1)!
  const of = <T extends DrawOp['op']>(op: T) => latest().filter((o): o is Op<T> => o.op === op)
  const region = (label: string, role?: Op<'region'>['role']) => of('region').find((r) => r.label === label && (!role || r.role === role))
  const send = (kind: number, a = 0, b = 0, c = 0) => host.kernel.guiEvent(pid, encodeEvent(kind, a, b, c))
  const commands = () => frames().flatMap((ops) => ops.filter((o): o is Op<'playerCommand'> => o.op === 'playerCommand'))
  return {
    pid,
    latest,
    region,
    texts: () => of('text').map((op) => op.text),
    labels: (role: Op<'region'>['role']) => of('region').filter((r) => r.role === role).map((r) => r.label),
    /** 프로그램이 플레이어에 시킨 일들 (처음부터 지금까지) */
    commands,
    /** 지금까지 불러오라고 한 영상들 */
    loaded: () => commands().filter((c) => c.command === PlayerCommand.load).map((c) => c.id),
    player: () => of('player')[0],
    press(label: string, role?: Op<'region'>['role']) {
      const r = region(label, role)
      if (!r) throw new Error(`no "${label}" on screen; there are: ${of('region').map((x) => x.label).join(', ')}`)
      host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerDown, r.x + r.w / 2, r.y + r.h / 2, 0))
      host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerUp, r.x + r.w / 2, r.y + r.h / 2))
    },
    pointer: (kind: number, x: number, y: number) => host.kernel.guiEvent(pid, encodePointer(kind, x, y, 0)),
    send,
    /** 화면 쪽이 플레이어의 상태를 알려 온 것처럼 한다 (위치와 길이는 초). */
    report: (state: number, position = 0, duration = 200) => send(GuiEvent.player, state, position * 1000, duration * 1000),
    until: (check: () => unknown, what: string) => host.until(() => !!check(), what),
  }
}

describe('music', () => {
  it('shows the playlists from the library file and asks for nothing until a song is picked', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    expect(all('gui-open', app.pid)[0]).toMatchObject({ title: '음악', w: 980, h: 620 })
    // 가운데에 고른 목록의 곡들, 왼쪽에 보관함의 목록들
    expect(app.labels('option')).toEqual(['하나', '둘', '셋', '첫 목록', '둘째 목록'])
    expect(app.texts()).toEqual(expect.arrayContaining(['고른 곡이 없습니다', '곡을 고르면 여기서 재생됩니다.', '가', '나', '다']))
    // 아직 플레이어를 놓지 않았고, 시킨 일도 없다.
    expect(app.player()).toBeUndefined()
    expect(app.commands()).toEqual([])
    app.press('둘째 목록')
    await app.until(() => app.labels('option').includes('넷'), 'the other list')
  })

  it('puts the player in the window and tells it what to play', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.press('둘')
    await app.until(() => app.player(), 'the player')
    // 플레이어의 자리는 16:9이고, 영상의 번호만 넘긴다. 처음 놓을 때 소리 크기도 맞춘다.
    const place = app.player()!
    expect(place.h).toBe(Math.round(place.w * 9 / 16))
    expect(app.commands()).toEqual([
      { op: 'playerCommand', command: PlayerCommand.load, value: 1, id: 'aaaaaaaaaa2' },
      { op: 'playerCommand', command: PlayerCommand.volume, value: 80, id: '' },
    ])
    expect(app.texts()).toEqual(expect.arrayContaining(['둘', '나']))
    expect(app.region('둘', 'option')).toMatchObject({ on: true })

    // 플레이어가 알려 온 상태대로 단추와 시간이 바뀐다.
    app.report(PlayerState.playing, 65, 187)
    await app.until(() => app.texts().includes('1:05') && app.texts().includes('3:07'), 'the time')
    // 틀어 봐서 알게 된 길이는 목록의 그 곡에도 나온다.
    expect(app.texts().filter((t) => t === '3:07')).toHaveLength(2)
    expect(app.region('일시정지')).toBeDefined()
    app.press('일시정지')
    await app.until(() => app.region('재생'), 'the play button')
    expect(app.commands().at(-1)).toMatchObject({ command: PlayerCommand.pause })
    app.send(GuiEvent.key, keyCode(' '))
    await app.until(() => app.commands().at(-1)?.command === PlayerCommand.play, 'play again with the space key')
    // 같은 일을 다음 그림에 또 보내지는 않는다.
    const count = app.commands().length
    app.send(GuiEvent.resize, 860, 520, 0)
    await new Promise((r) => setTimeout(r, 60))
    expect(app.commands()).toHaveLength(count)
  })

  it('moves on when a song ends, and stops at the end unless told to repeat', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.press('둘')
    await app.until(() => app.loaded().length === 1, 'the first song')
    app.report(PlayerState.playing, 10)
    app.report(PlayerState.ended, 200)
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa3', 'the next song')
    // 목록의 마지막 곡이 끝나면 멈춘다.
    app.report(PlayerState.playing, 5)
    app.report(PlayerState.ended, 200)
    await app.until(() => app.region('재생'), 'the end of the list')
    expect(app.loaded()).toEqual(['aaaaaaaaaa2', 'aaaaaaaaaa3'])

    // 반복: 목록 전체 → 처음으로 돌아간다. 한 곡 → 같은 곡을 다시 튼다.
    app.press('반복')
    await app.until(() => app.region('반복: 목록 전체'), 'repeat all')
    app.press('재생')
    await app.until(() => app.loaded().length === 3, 'the last song again')
    app.report(PlayerState.playing, 5)
    app.report(PlayerState.ended, 200)
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa1', 'back to the first')
    app.press('반복: 목록 전체')
    await app.until(() => app.region('반복: 한 곡'), 'repeat one')
    app.report(PlayerState.playing, 5)
    app.report(PlayerState.ended, 200)
    await app.until(() => app.loaded().length === 5, 'the same song')
    expect(app.loaded().at(-1)).toBe('aaaaaaaaaa1')
  })

  it('goes to the next and previous song, and shuffles without repeating the current one', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.press('하나')
    await app.until(() => app.loaded().length === 1, 'the first song')
    app.press('다음 곡')
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa2', 'next')
    // 이전 곡: 조금 들었으면 그 곡의 처음으로, 아니면 앞 곡으로.
    app.report(PlayerState.playing, 30)
    await app.until(() => app.texts().includes('0:30'), 'the position')
    app.press('이전 곡')
    await app.until(() => app.commands().at(-1)?.command === PlayerCommand.seek, 'back to the start of the song')
    expect(app.commands().at(-1)).toMatchObject({ value: 0 })
    app.press('이전 곡')
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa1', 'the song before')

    app.press('섞기')
    await app.until(() => app.region('섞기')?.on, 'shuffle on')
    for (let i = 0; i < 6; i++) {
      const before = app.loaded()
      app.press('다음 곡')
      await app.until(() => app.loaded().length === before.length + 1, 'another song')
      expect(app.loaded().at(-1)).not.toBe(before.at(-1))
    }
  })

  it('seeks and changes the volume by pressing or dragging on the bars', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.press('하나')
    await app.until(() => app.player(), 'the player')
    app.report(PlayerState.playing, 0, 200)
    await app.until(() => app.region('재생 위치 0%'), 'the progress bar')
    const bar = app.region('재생 위치 0%')!
    app.pointer(GuiEvent.pointerDown, bar.x + bar.w / 2, bar.y + 8)
    await app.until(() => app.commands().at(-1)?.command === PlayerCommand.seek, 'the seek')
    expect(app.commands().at(-1)!.value).toBeCloseTo(100, 0)
    // 누른 채 끌면 따라간다. 떼면 끝난다.
    app.pointer(GuiEvent.pointerMove, bar.x + bar.w, bar.y + 8)
    await app.until(() => Math.abs((app.commands().at(-1)?.value ?? 0) - 200) < 1, 'the end of the song')
    app.pointer(GuiEvent.pointerUp, bar.x + bar.w, bar.y + 8)

    const volume = app.region('소리 크기 80%')!
    app.pointer(GuiEvent.pointerDown, volume.x + volume.w / 4, volume.y + 8)
    app.pointer(GuiEvent.pointerUp, volume.x + volume.w / 4, volume.y + 8)
    await app.until(() => app.region('소리 크기 25%'), 'the new volume')
    expect(app.commands().at(-1)).toMatchObject({ command: PlayerCommand.volume, value: 25 })
  })

  it('skips songs that cannot be played, and stops when none can', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.press('하나')
    await app.until(() => app.loaded().length === 1, 'the first song')
    // 150: 다른 사이트에서의 재생을 막아 둔 영상
    app.send(GuiEvent.playerError, 150)
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa2', 'the next song')
    // 막힌 곡은 목록에서 줄이 그어진다.
    expect(app.latest()).toContainEqual(expect.objectContaining({ op: 'text', text: '하나', strike: true }))
    app.send(GuiEvent.playerError, 100)
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa3', 'the third song')
    app.send(GuiEvent.playerError, 101)
    await app.until(() => app.texts().includes('다른 사이트에서의 재생을 막아 둔 영상입니다.'), 'the reason')
    await new Promise((r) => setTimeout(r, 60))
    // 모두 틀 수 없으면 끝없이 넘기지 않는다.
    expect(app.loaded()).toHaveLength(3)
  })

  it('says so when the browser cannot hold the player, and offers YouTube instead', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.press('셋')
    await app.until(() => app.player(), 'the player')
    app.send(GuiEvent.playerError, PLAYER_UNSUPPORTED)
    await app.until(() => app.texts().includes('이 브라우저에서는 여기서 틀 수 없습니다.'), 'the notice')
    expect(app.player()).toBeUndefined()
    app.press('유튜브에서 열기')
    await app.until(() => app.latest().some((op) => op.op === 'open'), 'the link')
    expect(app.latest()).toContainEqual({ op: 'open', url: 'https://www.youtube.com/watch?v=aaaaaaaaaa3' })
  })

  it('fills in titles from YouTube when the file gives only addresses, and keeps them', async () => {
    write(LIBRARY, '# 주소만\nhttps://youtu.be/song0000001\nhttps://www.youtube.com/watch?v=song0000002\ngone0000000\n')
    const app = await openMusic()
    // 받아 오기 전에는 영상의 번호가 보이고, 입력이 없는 틈에 하나씩 받아 온다.
    await app.until(() => app.labels('option').includes('Second "Song"'), 'the titles')
    expect(app.labels('option')).toEqual(['첫 곡', 'Second "Song"', 'gone0000000', '주소만'])
    expect(app.texts()).toEqual(expect.arrayContaining(['가수 A', 'Singer B']))
    // 받은 제목은 적어 두어서, 다음에는 묻지 않는다.
    const saved = new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/.cache/music/titles'))
    expect(saved).toBe('song0000001\t첫 곡\t가수 A\nsong0000002\tSecond "Song"\tSinger B\n')
    host.kernel.setTracing(true)
    const again = await openMusic()
    await again.until(() => again.labels('option').includes('첫 곡'), 'the saved titles')
    await new Promise((r) => setTimeout(r, 200))
    const fetched = host.events.flatMap((e) => (e.type === 'trace' ? e.records : [])).filter((r) => r.pid === again.pid && r.call === 'fetch' && r.args.includes('oembed'))
    // 받아 오지 못했던 것(없는 영상)만 다시 물어본다.
    expect(fetched.map((r) => r.args)).toEqual(['"https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=gone0000000"'])
  })

  it('adds the playlists in ~/music, and remembers the volume and modes', async () => {
    write(LIBRARY, THREE)
    write('/home/guest/music/내 목록.txt', '# 내가 고른 것\ncccccccccc1 | 다섯 | 마\n')
    const app = await openMusic()
    expect(app.labels('option').slice(-3)).toEqual(['첫 목록', '둘째 목록', '내가 고른 것'])
    app.press('내가 고른 것')
    app.press('섞기')
    app.press('반복')
    await app.until(() => app.region('반복: 목록 전체') && app.region('섞기')?.on, 'the modes')
    app.send(GuiEvent.close)
    await host.until(() => all('exit', app.pid).length > 0, 'exit')
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/.config/music/settings'))).toBe('volume\t80\nshuffle\ttrue\nrepeat\tall\nlist\t내가 고른 것\n')
    const again = await openMusic()
    expect(again.region('내가 고른 것', 'option')).toMatchObject({ on: true })
    expect(again.region('섞기')).toMatchObject({ on: true })
    expect(again.labels('option')).toContain('다섯')
  })

  it('plays a whole list from its big button, and shows covers once they are fetched', async () => {
    write(LIBRARY, THREE)
    // 유튜브의 작은 그림: 테스트의 네트워크는 첫 곡의 것만 내준다.
    PAGES['https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg'] = { status: 200, headers: 'content-type: image/jpeg', body: '320x180' }
    const app = await openMusic()
    const covers = () => app.latest().filter((op) => op.op === 'image').map((op) => (op as { path: string }).path)
    // 받아 오면 파일로 적어 두고, 곡의 줄과 보관함의 목록(첫 곡의 그림)에 그린다.
    await app.until(() => covers().length === 2, 'the cover in the row and in the library')
    expect(new Set(covers())).toEqual(new Set(['/home/guest/.cache/music/covers/aaaaaaaaaa1.jpg']))
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/.cache/music/covers/aaaaaaaaaa1.jpg'))).toBe('320x180')

    app.press('이 목록 재생')
    await app.until(() => app.loaded().join() === 'aaaaaaaaaa1', 'the first song of the list')
    // 아래의 재생 막대에도 지금 곡의 그림과 제목이 나온다.
    await app.until(() => covers().length === 3, 'the cover in the bar')
    expect(app.texts().filter((t) => t === '하나')).toHaveLength(2)
    delete PAGES['https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg']
  })

  it('stacks the player above the list on a narrow screen', async () => {
    write(LIBRARY, THREE)
    const app = await openMusic()
    app.send(GuiEvent.resize, 390, 700, 0)
    app.press('하나')
    await app.until(() => app.player()?.w === 390 - 24, 'the player across the width')
    // 왼쪽의 보관함 대신 목록을 고르는 단추가 있고, 아래의 막대에는 재생과 다음만 남는다.
    expect(app.labels('option')).toEqual(['하나', '둘', '셋'])
    expect(app.region('다음 곡')).toBeDefined()
    expect(app.region('섞기')).toBeUndefined()
    app.press('첫 목록 ▾')
    await app.until(() => app.latest().some((op) => op.op === 'menu'), 'the menu of lists')
    app.send(GuiEvent.menu, 1)
    await app.until(() => app.labels('option').join() === '넷', 'the other list')
  })
})
