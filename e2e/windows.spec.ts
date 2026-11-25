// 창 관리자: 끌기, 붙이기, 크기 조절, 쌓임 순서, 여러 터미널.
import { expect, test } from '@playwright/test'
import { boot, box, drag, expectScreen, focusedWindow, launch, pinWindow, screen, type } from './helpers.ts'

const RAIL = 52

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test('a window moves when dragged by its title bar', async ({ page }) => {
  const win = await pinWindow(page)
  const before = await box(win)
  await drag(page, { x: before.x + 200, y: before.y + 18 }, 150, 90)
  expect(await box(win)).toEqual({ ...before, x: before.x + 150, y: before.y + 90 })
})

test('a window cannot be dragged out of reach', async ({ page }) => {
  const win = await pinWindow(page)
  const before = await box(win)
  await drag(page, { x: before.x + 200, y: before.y + 18 }, 0, 2000)
  const after = await box(win)
  expect(after.y).toBe(800 - 38)
  // 제목 표시줄이 남아 있어 다시 끌어올 수 있다.
  await drag(page, { x: after.x + 200, y: after.y + 18 }, 0, -300)
  expect((await box(win)).y).toBe(after.y - 300)
})

test('dragging to an edge shows a preview and snaps the window', async ({ page }) => {
  const win = await pinWindow(page)
  const start = await box(win)
  const grab = { x: start.x + 200, y: start.y + 18 }

  await drag(page, grab, RAIL + 2 - grab.x, 200, false)
  await expect(page.locator('.snap-preview')).toBeVisible()
  // 미리보기는 끌고 있는 창 바로 아래에 그려진다.
  const z = (el: Element) => Number(getComputedStyle(el).zIndex)
  expect(await page.locator('.snap-preview').evaluate(z)).toBe((await win.evaluate(z)) - 1)
  await page.mouse.up()
  await expect(page.locator('.snap-preview')).toHaveCount(0)
  const half = (1280 - RAIL - 24) / 2
  expect(await box(win)).toEqual({ x: RAIL + 8, y: 8, w: half, h: 800 - 16 })

  // 터미널이 새 크기에 맞춰 다시 그려지고 계속 동작한다.
  await type(page, 'echo snapped')
  await expectScreen(page).toContain('\nsnapped\n')

  // 다시 끌면 원래 크기로 돌아와 포인터를 따라온다.
  await drag(page, { x: RAIL + 8 + half / 2, y: 26 }, 300, 200)
  const restored = await box(win)
  expect([restored.w, restored.h]).toEqual([start.w, start.h])
  expect(restored.y).toBe(8 + 200)
})

test('double-clicking the title bar maximizes and restores', async ({ page }) => {
  const win = await pinWindow(page)
  const before = await box(win)
  await win.locator('.title').dblclick()
  expect(await box(win)).toEqual({ x: RAIL, y: 0, w: 1280 - RAIL, h: 800 })
  await win.getByRole('button', { name: '원래 크기로' }).click()
  expect(await box(win)).toEqual(before)
})

test('edges and corners resize the window, down to a minimum size', async ({ page }) => {
  const win = await pinWindow(page)
  const b = await box(win)
  await drag(page, { x: b.x + b.w, y: b.y + b.h }, 80, 60)
  expect(await box(win)).toEqual({ ...b, w: b.w + 80, h: b.h + 60 })

  await drag(page, { x: b.x, y: b.y + 200 }, 2000, 0)
  const narrow = await box(win)
  expect(narrow.w).toBe(320)
  expect(narrow.x + narrow.w).toBe(b.x + b.w + 80)

  // 터미널은 줄어든 폭에 맞춰 줄을 넘긴다.
  await type(page, 'echo ' + 'x'.repeat(60))
  await expect.poll(async () => (await screen(page)).replaceAll('\n', '')).toContain('x'.repeat(60) + 'x'.repeat(60))
})

test('clicking a window brings it to the front', async ({ page }) => {
  const first = await pinWindow(page)
  await launch(page, '시스템 로그')
  const log = page.locator('.window[data-app="log"]')
  await expect(log).toHaveClass(/focused/)
  await expect(first).not.toHaveClass(/focused/)

  const b = await box(first)
  await page.mouse.click(b.x + 30, b.y + 18)
  await expect(first).toHaveClass(/focused/)
  const z = (el: Element) => Number(getComputedStyle(el).zIndex)
  expect(await first.evaluate(z)).toBeGreaterThan(await log.evaluate(z))
})

test('windows can be minimized and restored from the rail', async ({ page }) => {
  const win = await pinWindow(page)
  await type(page, 'echo keep')
  await win.getByRole('button', { name: '최소화' }).click()
  await expect(win).toBeHidden()

  const tab = page.getByRole('button', { name: '창: 터미널' })
  await tab.click()
  await expect(win).toBeVisible()
  await expect(win).toHaveClass(/focused/)
  expect(await screen(page)).toContain('\nkeep\n')

  // 맨 위에 있는 창의 탭을 누르면 접힌다.
  await tab.click()
  await expect(win).toBeHidden()
})

test('single-instance apps reuse their window', async ({ page }) => {
  await launch(page, '프로세스')
  await launch(page, '터미널')
  await launch(page, '프로세스')
  await expect(page.locator('.window[data-app="processes"]')).toHaveCount(1)
  await expect(page.locator('.window[data-app="processes"]')).toHaveClass(/focused/)
  await expect(page.locator('.window[data-app="terminal"]')).toHaveCount(2)
})

test('each terminal window has its own shell session', async ({ page }) => {
  const first = await pinWindow(page)
  await type(page, 'cd /tmp && echo one > shared.txt')
  await expectScreen(page).toMatch(/guest@webos:\/tmp\$$/)

  await launch(page, '터미널')
  await expect(page.locator('.window[data-app="terminal"]')).toHaveCount(2)
  await expect(first).not.toHaveClass(/focused/)
  await expectScreen(page).toMatch(/guest@webos:~\$$/)
  // 작업 디렉터리는 따로지만 파일시스템은 같다.
  await type(page, 'cat /tmp/shared.txt')
  await expectScreen(page).toContain('\none\n')
  expect(await screen(page, first)).not.toContain('cat /tmp/shared.txt')

  await launch(page, '프로세스')
  await expect(page.getByTestId('procs')).toContainText('프로세스 2개')
})

test('closing a terminal window ends its shell and running programs', async ({ page }) => {
  await type(page, 'spin')
  await expectScreen(page).toContain('spinning... 0s')
  await launch(page, '프로세스')
  await expect(page.getByTestId('procs')).toContainText('프로세스 2개')

  await page.locator('.window[data-app="terminal"]').getByRole('button', { name: '닫기' }).click()
  await expect(page.locator('.window[data-app="terminal"]')).toHaveCount(0)
  await expect(page.getByTestId('procs')).toContainText('프로세스 0개')
})

test('windows stay reachable when the browser window shrinks', async ({ page }) => {
  const win = await pinWindow(page)
  const b = await box(win)
  await drag(page, { x: b.x + 200, y: b.y + 18 }, 400, 250)
  await page.setViewportSize({ width: 560, height: 420 })
  await expect.poll(async () => (await box(win)).x).toBeLessThanOrEqual(560 - 96)
  expect((await box(win)).y).toBeLessThanOrEqual(420 - 38)
})
