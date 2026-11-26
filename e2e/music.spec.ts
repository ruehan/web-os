// 음악: 보관함(곡, 아티스트·앨범, 글처럼 쓴 플레이리스트)과 재생 순서는 WASM 프로세스가 정하고, 영상과 소리는 화면 쪽이 창에 놓아 주는 유튜브의 플레이어가 낸다.
// 실제 유튜브에 기대면 검사가 흔들리므로, 플레이어의 자리에 같은 말(IFrame API의 메시지)을 하는 가짜 페이지를 끼운다.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, typeIn } from './helpers.ts'

const music = (page: Page) => appWindow(page, 'music')
const term = (page: Page) => appWindow(page, 'terminal')
const player = (page: Page) => music(page).locator('iframe.surface-player')
/** 가짜 플레이어의 안쪽 */
const inside = (page: Page) => page.frames().find((frame) => frame.url().startsWith('https://www.youtube.com/embed/'))!

const FAKE_PLAYER = `<!doctype html><body style="margin:0;background:#123;color:#fff;font:14px sans-serif"><script>
  let state = -1, time = 0, vid = location.pathname.split('/').pop()
  window.volume = 100
  window.heard = []
  const post = (message) => parent.postMessage(JSON.stringify(message), '*')
  const info = () => { document.body.textContent = vid + ' ' + state; post({ event: 'infoDelivery', info: { playerState: state, currentTime: time, duration: 30 } }) }
  // 검사가 곡의 진행을 흉내 낼 때 부른다.
  window.advance = (to) => { time = to; info() }
  window.finish = () => { state = 0; time = 30; info() }
  window.current = () => vid
  addEventListener('message', (e) => {
    let message
    try { message = JSON.parse(e.data) } catch { return }
    if (message.event === 'listening') {
      post({ event: 'onReady' })
      if (location.search.includes('autoplay=1')) state = 1
      return info()
    }
    if (message.event !== 'command') return
    const [func, args] = [message.func, message.args || []]
    window.heard.push(func)
    if (func === 'loadVideoById') {
      vid = args[0]; time = 0
      // 퍼가기를 막아 둔 영상을 흉내 낸다.
      if (vid.startsWith('blocked')) return post({ event: 'onError', info: 150 })
      state = 1
    } else if (func === 'playVideo') state = 1
    else if (func === 'pauseVideo') state = 2
    else if (func === 'seekTo') time = args[0]
    else if (func === 'setVolume') window.volume = args[0]
    info()
  })
</script>`

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.context().route('https://www.youtube.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: FAKE_PLAYER }))
  // 제목을 묻는 요청에는 모른다고 답한다 (이 검사의 목록에는 제목이 적혀 있다).
  await page.context().route('https://www.youtube.com/oembed**', (route) => route.fulfill({ status: 404, body: 'Not Found' }))
  await page.context().route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 404, body: 'Not Found' }))
  await boot(page)
  await typeIn(page, term(page), 'mkdir -p music/playlists; echo "first000001 | 하나 | 가 | 첫 앨범" > music/songs.txt; echo "blocked0002 | 막힌 곡 | 나" >> music/songs.txt; echo "third000003 | 셋 | 다" >> music/songs.txt')
  await expectScreen(page, term(page)).toMatch(/\$$/)
  // 글처럼 쓴 플레이리스트: 소개글, 곡, 그 곡에 대한 이야기
  await typeIn(page, term(page), 'cd music/playlists; echo "# 내 글" > mine.md; echo "날짜: 2099-01-01" >> mine.md; echo "소개하는 글." >> mine.md; echo first000001 >> mine.md; echo "하나를 고른 까닭." >> mine.md; echo blocked0002 >> mine.md; echo third000003 >> mine.md; cd')
  await expectScreen(page, term(page)).toMatch(/\$$/)
})

test('plays a picked song in a YouTube player placed inside the window', async ({ page }) => {
  await launch(page, '음악')
  // 글의 목록부터 보인다. 새 글이 위에 온다.
  await expect(music(page).getByRole('link')).toHaveText(['내 글', '플레이리스트 쓰는 법'])
  await expect(player(page)).toHaveCount(0)
  await music(page).getByRole('link', { name: '내 글' }).click()
  await expect(music(page).getByRole('option', { name: '하나', exact: true })).toBeVisible()
  await music(page).getByRole('option', { name: '하나', exact: true }).click()

  // 플레이어는 쿠키 없이 여는 iframe이다 (이 페이지의 격리 설정에서도 뜬다). 프로그램은 영상의 번호만 넘긴다.
  await expect(player(page)).toBeVisible()
  await expect(player(page)).toHaveAttribute('credentialless', '')
  expect(new URL((await player(page).getAttribute('src'))!).pathname).toBe('/embed/first000001')
  // 영상은 왼쪽 보관함의 아래에서 나온다. 유튜브가 정한 가장 작은 크기(200×200)를 지킨다.
  const box = (await player(page).boundingBox())!
  const frame = (await music(page).boundingBox())!
  expect(Math.round(box.width)).toBe(200)
  expect(Math.round(box.height)).toBe(200)
  expect(box.x + box.width).toBeLessThan(frame.x + 222)
  expect(box.y + box.height).toBeLessThan(frame.y + frame.height - 78)

  // 플레이어가 "틀고 있다"고 알려 오면 단추가 바뀌고, 누르면 플레이어에 멈추라고 시킨다.
  await expect(music(page).getByRole('button', { name: '일시정지' })).toBeVisible()
  await music(page).getByRole('button', { name: '일시정지' }).click()
  await expect(music(page).getByRole('button', { name: '재생', exact: true })).toBeVisible()
  await expect.poll(() => inside(page).evaluate(() => (window as unknown as { heard: string[] }).heard)).toContain('pauseVideo')
  // 처음 놓일 때 소리 크기를 맞춘다.
  await expect.poll(() => inside(page).evaluate(() => (window as unknown as { volume: number }).volume)).toBe(80)

  // 프로세스로 돌고 있다.
  await raise(page, '터미널')
  await typeIn(page, term(page), 'ps | grep music')
  await expectScreen(page, term(page)).toMatch(/\n\s*\d+\s+0 [RS]\s+-\s+music\n/)
})

test('moves to the next song when one ends, skipping what cannot be embedded', async ({ page }) => {
  await launch(page, '음악')
  // 아티스트별로 찾아가도 같은 곡이 있다.
  await music(page).getByRole('option', { name: '아티스트' }).click()
  await music(page).getByRole('link', { name: '가', exact: true }).click()
  await expect(music(page).getByRole('option', { name: '하나', exact: true })).toBeVisible()
  await expect(music(page).getByRole('option', { name: '셋', exact: true })).toHaveCount(0)
  // 글을 펼쳐 처음부터 튼다.
  await music(page).getByRole('option', { name: '내 글' }).click()
  await music(page).getByRole('button', { name: '모두 재생' }).click()
  await expect(music(page).getByRole('button', { name: '일시정지' })).toBeVisible()
  const current = () => inside(page).evaluate(() => (window as unknown as { current(): string }).current())

  // 곡이 흐르면 진행 막대가 따라간다 (30초 가운데 15초).
  await inside(page).evaluate(() => (window as unknown as { advance(to: number): void }).advance(15))
  await expect(music(page).getByRole('button', { name: '재생 위치 50%' })).toBeVisible()

  // 곡이 끝나면 다음 곡을 틀라고 한다. 그 곡이 퍼가기 금지면 표시해 두고 그다음 곡으로 넘어간다.
  await inside(page).evaluate(() => (window as unknown as { finish(): void }).finish())
  await expect.poll(current).toBe('third000003')
  await expect(music(page).getByRole('option', { name: '셋', exact: true })).toHaveAttribute('aria-selected', 'true')
  // 같은 플레이어를 계속 쓴다 (곡마다 새로 만들지 않는다).
  await expect(player(page)).toHaveCount(1)
  expect(new URL((await player(page).getAttribute('src'))!).pathname).toBe('/embed/first000001')

  // 창을 닫으면 플레이어도 사라지고 프로세스가 끝난다.
  await music(page).getByRole('button', { name: '닫기', exact: true }).click()
  await expect(music(page)).toHaveCount(0)
  await raise(page, '터미널')
  await typeIn(page, term(page), 'ps | grep -c "music$"')
  await expectScreen(page, term(page)).toMatch(/\n0\n/)
})
