// 움직임(애니메이션). 여기서는 다른 테스트와 달리 "움직임 줄이기"를 켜지 않은 상태로 확인한다.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, box, drag, expectScreen, launch } from './helpers.ts'

const RAIL = 52
const terminal = (page: Page) => appWindow(page, 'terminal')

/** 움직임이 켜진 채로 연다. 부팅 화면은 키를 눌러 건너뛴다. */
async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem('webos.welcomed', '1'))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/', { waitUntil: 'commit' })
  await expect(page.getByRole('log')).toContainText('kernel: ready')
  await page.keyboard.press('Space')
  await expectScreen(page, terminal(page)).toMatch(/\$$/)
  // 바탕 화면과 창이 나타나는 움직임이 끝나기를 기다린다. 도중에는 크기가 살짝 달라 위치를 잴 수 없다.
  await expect(terminal(page)).not.toHaveClass(/opening/)
  await settle(page)
}

/** 진행 중인 움직임이 모두 끝나기를 기다린다 (끝없이 도는 커서 깜빡임은 빼고). */
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ).then(() => {}),
  )

/** 요소에 지금 걸려 있는 움직임의 이름들 */
const animations = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => el.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'transition'))

test('a window appears with a short animation when opened', async ({ page }) => {
  await open(page)
  await launch(page, '설정')
  const settings = appWindow(page, 'settings')
  await expect(settings).toHaveClass(/opening/)
  expect(await animations(page, '.window[data-app="settings"]')).toContain('window-in')
  await expect(settings).not.toHaveClass(/opening/)
  // 끝난 뒤에는 온전한 크기와 불투명도로 남는다.
  expect(await settings.evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el).scale])).toEqual(['1', 'none'])
})

test('closing fades the window out before it is removed, and focus moves on at once', async ({ page }) => {
  await open(page)
  await launch(page, '설정')
  const settings = appWindow(page, 'settings')
  await expect(settings).not.toHaveClass(/opening/)
  await settings.getByRole('button', { name: '닫기' }).click()

  await expect(settings).toHaveClass(/closing/)
  expect(await animations(page, '.window[data-app="settings"]')).toContain('window-out')
  // 사라지는 동안 이미 다음 창이 입력을 받는다.
  await expect(terminal(page)).toHaveClass(/focused/)
  await expect(settings).toHaveCount(0)
})

test('minimizing shrinks the window toward its tab in the rail, and restoring grows it back', async ({ page }) => {
  await open(page)
  const win = terminal(page)
  const before = await box(win)
  await win.getByRole('button', { name: '최소화' }).click()
  await expect(win).toHaveClass(/minimizing/)

  // 줄어드는 방향은 레일에 있는 이 창의 표시다 (창의 왼쪽 아래).
  const aim = await win.evaluate((el) => [el.style.getPropertyValue('--to-x'), el.style.getPropertyValue('--to-y')].map(parseFloat))
  const tab = await box(page.getByRole('button', { name: '창: 터미널' }))
  expect(Math.round(aim[0]!)).toBe(Math.round(tab.x + tab.w / 2 - (before.x + before.w / 2)))
  expect(Math.round(aim[1]!)).toBe(Math.round(tab.y + tab.h / 2 - (before.y + before.h / 2)))
  await expect(win).toBeHidden()

  await page.getByRole('button', { name: '창: 터미널' }).click()
  await expect(win).toHaveClass(/restoring/)
  await expect(win).toBeVisible()
  await expect(win).not.toHaveClass(/restoring/)
  expect(await box(win)).toEqual(before)
  // 다시 나타난 뒤 열림 움직임이 덧붙어 재생되지 않는다.
  expect(await animations(page, '.window[data-app="terminal"]')).toEqual([])
})

test('maximizing and restoring glide to the new size instead of jumping', async ({ page }) => {
  await open(page)
  const win = terminal(page)
  const before = await box(win)
  await win.locator('.title').dblclick()
  await expect(win).toHaveClass(/gliding/)
  // 가는 도중에는 원래 크기와 최대 크기 사이에 있다.
  const midway = await box(win)
  expect(midway.w).toBeGreaterThanOrEqual(before.w)
  expect(midway.w).toBeLessThanOrEqual(1280 - RAIL)

  await expect(win).not.toHaveClass(/gliding/)
  expect(await box(win)).toEqual({ x: RAIL, y: 0, w: 1280 - RAIL, h: 800 })
  // 새 크기에 맞춰 터미널이 다시 계산되어 계속 동작한다.
  await win.locator('.terminal textarea').focus()
  await page.keyboard.type('echo ' + 'x'.repeat(120))
  await page.keyboard.press('Enter')
  await expectScreen(page, win).toContain(`\n${'x'.repeat(120)}\n`)

  await win.getByRole('button', { name: '원래 크기로' }).click()
  await expect(win).toHaveClass(/gliding/)
  await expect(win).not.toHaveClass(/gliding/)
  expect(await box(win)).toEqual(before)
})

test('dragging follows the pointer exactly, and lifts the window while held', async ({ page }) => {
  await open(page)
  const win = terminal(page)
  const before = await box(win)
  await drag(page, { x: before.x + 200, y: before.y + 18 }, 140, 80, false)
  await expect(win).toHaveClass(/dragging/)
  // 끄는 동안에는 미끄러지지 않고 손의 위치에 바로 있어야 한다.
  await expect(win).not.toHaveClass(/gliding/)
  expect(await box(win)).toEqual({ ...before, x: before.x + 140, y: before.y + 80 })
  await page.mouse.up()
  await expect(win).not.toHaveClass(/dragging/)
})

test('snapping glides into place, and dragging away detaches without lag', async ({ page }) => {
  await open(page)
  const win = terminal(page)
  const start = await box(win)
  const grab = { x: start.x + 200, y: start.y + 18 }
  await drag(page, grab, RAIL + 2 - grab.x, 200, false)
  await expect(page.locator('.snap-preview')).toBeVisible()
  await page.mouse.up()
  await expect(win).toHaveClass(/gliding/)
  await expect(win).not.toHaveClass(/gliding/)
  const half = (1280 - RAIL - 24) / 2
  expect(await box(win)).toEqual({ x: RAIL + 8, y: 8, w: half, h: 800 - 16 })

  // 붙어 있던 창을 끌어내면 그 자리에서 바로 원래 크기로 돌아와 손을 따라온다.
  await drag(page, { x: RAIL + 8 + half / 2, y: 26 }, 300, 200, false)
  await expect(win).not.toHaveClass(/gliding/)
  const held = await box(win)
  expect([held.w, held.h, held.y]).toEqual([start.w, start.h, 8 + 200])
  await page.mouse.up()
})

test('everything is instant when the user prefers reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => localStorage.setItem('webos.welcomed', '1'))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expectScreen(page, terminal(page)).toMatch(/\$$/)
  const win = terminal(page)
  const before = await box(win)

  await win.locator('.title').dblclick()
  expect(await box(win)).toEqual({ x: RAIL, y: 0, w: 1280 - RAIL, h: 800 })
  await win.locator('.title').dblclick()
  expect(await box(win)).toEqual(before)
  await win.getByRole('button', { name: '최소화' }).click()
  expect(await win.isHidden()).toBe(true)
  await page.getByRole('button', { name: '창: 터미널' }).click()
  await win.getByRole('button', { name: '닫기' }).click()
  expect(await page.locator('.window').count()).toBe(0)
})
