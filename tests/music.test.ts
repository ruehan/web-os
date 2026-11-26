// 음악 앱(programs/music): 보관함(곡, 아티스트·앨범, 글처럼 쓴 플레이리스트)과 재생 순서는 프로세스가 정하고, 영상과 소리는 화면 쪽이 놓아 주는 바깥 플레이어가 낸다.
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
/** 시스템의 보관함을 테스트의 것으로 바꾼다: 곡 목록과, 이름마다의 플레이리스트 글. */
function library(songs: string, posts: Record<string, string> = {}) {
  host.kernel.fs.removeTree(host.kernel.fs.mkdirp('/usr/share'), 'music')
  write('/usr/share/music/songs.txt', songs)
  for (const [name, text] of Object.entries(posts)) write(`/usr/share/music/playlists/${name}.md`, text)
}
const THREE = 'aaaaaaaaaa1 | 하나 | 가 | 첫 앨범\n    하나에 대한 글.\naaaaaaaaaa2 | 둘 | 나 | 첫 앨범\naaaaaaaaaa3 | 셋 | 가\n'
const NAV = ['플레이리스트', '모든 곡', '아티스트', '앨범']
const RAIN = '# 비 오는 날\n날짜: 2026-11-26\n\n소개글이다.\n\nhttps://youtu.be/aaaaaaaaaa2\n둘을 고른 까닭.\n\naaaaaaaaaa1\n'

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
  it('shows the registered songs, by artist and by album, and asks for nothing until a song is picked', async () => {
    library(THREE)
    const app = await openMusic()
    expect(all('gui-open', app.pid)[0]).toMatchObject({ title: '음악', w: 980, h: 640 })
    // 글이 없으면 곡 목록부터 보여 준다. 가운데에 곡들, 왼쪽에 보관함.
    expect(app.labels('option')).toEqual(['하나', '둘', '셋', ...NAV])
    expect(app.texts()).toEqual(expect.arrayContaining(['고른 곡이 없습니다', '모든 곡', '3곡', '가', '나', '첫 앨범']))
    // 아직 플레이어를 놓지 않았고, 시킨 일도 없다.
    expect(app.player()).toBeUndefined()
    expect(app.commands()).toEqual([])

    // 아티스트별: 적어 둔 아티스트로 묶인다.
    app.press('아티스트')
    await app.until(() => app.labels('link').join() === '가,나', 'the artists')
    expect(app.texts()).toEqual(expect.arrayContaining(['2명', '2곡', '1곡']))
    app.press('가', 'link')
    await app.until(() => app.labels('option').join() === ['하나', '셋', ...NAV].join(), 'the songs of the artist')
    expect(app.region('아티스트', 'option')).toMatchObject({ on: true })
    // 앨범별: 앨범을 적어 둔 곡만 묶인다.
    app.press('앨범')
    await app.until(() => app.labels('link').join() === '첫 앨범', 'the albums')
    expect(app.texts()).toContain('가 · 2곡')
    app.press('첫 앨범', 'link')
    await app.until(() => app.labels('option').join() === ['하나', '둘', ...NAV].join(), 'the songs of the album')
    // 그 묶음 안에서 틀면 차례도 그 묶음이다.
    app.press('둘')
    await app.until(() => app.loaded().join() === 'aaaaaaaaaa2', 'the second song of the album')
    app.press('다음 곡')
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa1', 'around to the first of the album')
    // 곡에 써 둔 글은 그 곡을 틀고 있을 때 아래에 펼쳐진다.
    expect(app.texts()).toContain('하나에 대한 글.')
  })

  it('reads a playlist like a post: an introduction, the songs, and what was written about each', async () => {
    library(THREE, { rain: RAIN })
    write('/home/guest/music/songs.txt', 'cccccccccc1 | 다섯 | 마\n')
    write('/home/guest/music/playlists/밤.md', '날짜: 2026-11-27\n\ncccccccccc1\n밤에 듣는다.\n')
    const app = await openMusic()
    // 글이 있으면 글의 목록부터 보여 준다. 새 글이 위에 오고, 제목이 없으면 파일 이름이 제목이다.
    expect(app.labels('link')).toEqual(['밤', '비 오는 날'])
    expect(app.texts()).toEqual(expect.arrayContaining(['글 2편', '2026-11-26 · 2곡', '소개글이다.']))
    // 사용자의 곡 목록(~/music/songs.txt)도 더해진다.
    app.press('모든 곡')
    await app.until(() => app.labels('option').slice(0, 4).join() === '하나,둘,셋,다섯', 'every song')

    app.press('비 오는 날', 'option')
    await app.until(() => app.labels('option').slice(0, 2).join() === '둘,하나', 'the songs in the order of the post')
    // 소개글, 그 글에서 곡에 대해 쓴 것. 쓴 것이 없는 곡은 곡에 써 둔 글이 나온다.
    const texts = app.texts()
    expect(texts).toEqual(expect.arrayContaining(['플레이리스트', '비 오는 날', '소개글이다.', '둘을 고른 까닭.', '하나에 대한 글.']))
    expect(texts.indexOf('소개글이다.')).toBeLessThan(texts.indexOf('둘을 고른 까닭.'))
    // 글의 차례대로 튼다.
    app.press('모두 재생')
    await app.until(() => app.loaded().join() === 'aaaaaaaaaa2', 'the first song of the post')
    app.report(PlayerState.playing, 5)
    app.report(PlayerState.ended, 200)
    await app.until(() => app.loaded().at(-1) === 'aaaaaaaaaa1', 'the next song of the post')
    app.report(PlayerState.playing, 5)
    app.report(PlayerState.ended, 200)
    await app.until(() => app.region('재생'), 'the end of the post')
    expect(app.loaded()).toHaveLength(2)

    // 보던 글을 기억한다.
    app.send(GuiEvent.close)
    await host.until(() => all('exit', app.pid).length > 0, 'exit')
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/.config/music/settings'))).toBe('volume\t80\nshuffle\tfalse\nrepeat\toff\nview\tpost:비 오는 날\n')
    const again = await openMusic()
    expect(again.region('비 오는 날', 'option')).toMatchObject({ on: true })
    // 글 파일을 주면서 실행하면 그 글을 펼친다.
    const given = await openMusic('/home/guest/music/playlists/밤.md')
    expect(given.region('밤', 'option')).toMatchObject({ on: true })
    expect(given.texts()).toContain('밤에 듣는다.')
  })

  it('puts the player in the window and tells it what to play', async () => {
    library(THREE)
    const app = await openMusic()
    app.press('둘')
    await app.until(() => app.player(), 'the player')
    // 플레이어는 왼쪽 보관함의 아래에 놓이고(유튜브가 정한 가장 작은 크기), 영상의 번호만 넘긴다. 처음 놓을 때 소리 크기도 맞춘다.
    const place = app.player()!
    expect(place).toMatchObject({ w: 200, h: 200 })
    expect(place.x + place.w).toBeLessThan(220)
    expect(place.y + place.h).toBeLessThan(640 - 78)
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
    library(THREE)
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
    library(THREE)
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
    library(THREE)
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
    library(THREE)
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
    library(THREE)
    const app = await openMusic()
    app.press('셋')
    await app.until(() => app.player(), 'the player')
    app.send(GuiEvent.playerError, PLAYER_UNSUPPORTED)
    await app.until(() => app.texts().some((t) => t.startsWith('이 브라우저에서는 여기서 틀 수 없습니다.')), 'the notice')
    expect(app.player()).toBeUndefined()
    app.press('유튜브에서 열기')
    await app.until(() => app.latest().some((op) => op.op === 'open'), 'the link')
    expect(app.latest()).toContainEqual({ op: 'open', url: 'https://www.youtube.com/watch?v=aaaaaaaaaa3' })
  })

  it('fills in titles from YouTube when the file gives only addresses, and keeps them', async () => {
    library('https://youtu.be/song0000001\nhttps://www.youtube.com/watch?v=song0000002\ngone0000000\n')
    const app = await openMusic()
    // 받아 오기 전에는 영상의 번호가 보이고, 입력이 없는 틈에 하나씩 받아 온다.
    await app.until(() => app.labels('option').includes('Second "Song"'), 'the titles')
    expect(app.labels('option')).toEqual(['첫 곡', 'Second "Song"', 'gone0000000', ...NAV])
    // 받아 온 작성자로 아티스트별 보기도 채워진다.
    app.press('아티스트')
    await app.until(() => app.labels('link').length > 0, 'the artists')
    // 아티스트를 모르는 곡들은 맨 뒤에 따로 묶인다.
    expect(app.labels('link')).toEqual(['가수 A', 'Singer B', '아티스트 미상'])
    app.press('모든 곡')
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

  it('remembers the volume, the modes and what was open', async () => {
    library(THREE)
    const app = await openMusic()
    app.press('아티스트')
    await app.until(() => app.labels('link').includes('가'), 'the artists')
    app.press('가', 'link')
    app.press('섞기')
    app.press('반복')
    await app.until(() => app.region('반복: 목록 전체') && app.region('섞기')?.on, 'the modes')
    app.send(GuiEvent.close)
    await host.until(() => all('exit', app.pid).length > 0, 'exit')
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/.config/music/settings'))).toBe('volume\t80\nshuffle\ttrue\nrepeat\tall\nview\tartist:가\n')
    const again = await openMusic()
    expect(again.region('섞기')).toMatchObject({ on: true })
    expect(again.labels('option')).toEqual(['하나', '셋', ...NAV])
  })

  it('plays everything shown from the big button, and shows covers once they are fetched', async () => {
    library(THREE)
    // 유튜브의 작은 그림: 테스트의 네트워크는 첫 곡의 것만 내준다.
    PAGES['https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg'] = { status: 200, headers: 'content-type: image/jpeg', body: '320x180' }
    const app = await openMusic()
    const covers = () => app.latest().filter((op) => op.op === 'image').map((op) => (op as { path: string }).path)
    // 받아 오면 파일로 적어 두고, 곡의 줄에 그린다.
    await app.until(() => covers().length === 1, 'the cover in the row')
    expect(new Set(covers())).toEqual(new Set(['/home/guest/.cache/music/covers/aaaaaaaaaa1.jpg']))
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/.cache/music/covers/aaaaaaaaaa1.jpg'))).toBe('320x180')

    app.press('모두 재생')
    await app.until(() => app.loaded().join() === 'aaaaaaaaaa1', 'the first song of the list')
    // 아래의 재생 막대에도 지금 곡의 그림과 제목이 나온다.
    await app.until(() => covers().length === 2, 'the cover in the bar')
    expect(app.texts().filter((t) => t === '하나')).toHaveLength(2)
    delete PAGES['https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg']
  })

  it('keeps a short bar and a menu of views on a narrow screen', async () => {
    library(THREE)
    const app = await openMusic()
    app.send(GuiEvent.resize, 390, 700, 0)
    app.press('하나')
    await app.until(() => app.player()?.w === 85, 'the player in the bar')
    // 좁은 화면에서는 플레이어가 아래 막대의 그림 자리에 놓인다.
    // 왼쪽의 보관함 대신 목록을 고르는 단추가 있고, 아래의 막대에는 재생과 다음만 남는다.
    expect(app.labels('option')).toEqual(['하나', '둘', '셋'])
    expect(app.region('다음 곡')).toBeDefined()
    expect(app.region('섞기')).toBeUndefined()
    app.press('모든 곡 ▾')
    await app.until(() => app.latest().some((op) => op.op === 'menu'), 'the menu of views')
    expect(app.latest().find((op) => op.op === 'menu')).toMatchObject({ items: NAV.map((label) => expect.objectContaining({ label })) })
    app.send(GuiEvent.menu, 2)
    await app.until(() => app.labels('link').join() === '가,나', 'the artists')
  })
})
