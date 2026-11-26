// 그림판: 화면을 직접 그리는 WASM 프로세스. 창에 보이는 것은 모두 그 프로세스가 보낸 그리기 명령이다.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const paint = (page: Page) => appWindow(page, 'surface')
const canvas = (page: Page) => paint(page).getByRole('application', { name: '그림판' })

/** 캔버스 안의 한 점의 색 (CSS 픽셀 좌표) */
const colorAt = (surface: Locator, x: number, y: number) =>
  surface.evaluate(
    (el: HTMLCanvasElement, [x, y]) => {
      const scale = el.width / el.clientWidth
      const [r, g, b] = el.getContext('2d')!.getImageData(Math.round(x! * scale), Math.round(y! * scale), 1, 1).data
      return `${r},${g},${b}`
    },
    [x, y],
  )

/** 캔버스 안의 좌표로 마우스를 끈다. */
async function drag(page: Page, surface: Locator, points: [number, number][]) {
  const box = (await surface.boundingBox())!
  const [first, ...rest] = points
  await page.mouse.move(box.x + first![0], box.y + first![1])
  await page.mouse.down()
  for (const [x, y] of rest) await page.mouse.move(box.x + x, box.y + y, { steps: 4 })
  await page.mouse.up()
}

async function shell(page: Page, line: string, expected: string | RegExp) {
  await typeIn(page, term(page), line)
  if (typeof expected === 'string') await expectScreen(page, term(page)).toContain(expected)
  else await expectScreen(page, term(page)).toMatch(expected)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test('opens from the app menu as a process that draws its own window', async ({ page }) => {
  await launch(page, '그림판')
  await expect(paint(page)).toHaveClass(/focused/)
  await expect(paint(page).locator('.titlebar')).toContainText('그림판')
  // 프로그램이 바란 안쪽 크기 그대로 열린다.
  await expect.poll(async () => (await canvas(page).boundingBox())!).toMatchObject({ width: 720, height: 480 })
  // 도구 막대와 흰 종이가 그려졌다.
  await expect.poll(() => colorAt(canvas(page), 300, 200)).toBe('255,255,255')
  await expect.poll(() => colorAt(canvas(page), 25, 20)).toBe('28,29,32')

  // 터미널의 명령과 똑같은 프로세스다.
  await raise(page, '터미널')
  await shell(page, 'ps', /\n\s*\d+\s.*paint\n/)
})

test('draws where the mouse is dragged, in the chosen color', async ({ page }) => {
  await launch(page, '그림판')
  await expect.poll(() => colorAt(canvas(page), 300, 200)).toBe('255,255,255')
  await drag(page, canvas(page), [[100, 150], [300, 150]])
  await expect.poll(() => colorAt(canvas(page), 200, 150)).toBe('28,29,32')
  expect(await colorAt(canvas(page), 200, 250)).toBe('255,255,255')

  // 파란색(다섯 번째 색)을 골라 세로로 긋는다.
  const box = (await canvas(page).boundingBox())!
  await page.mouse.click(box.x + 10 + 4 * 32 + 15, box.y + 20)
  await drag(page, canvas(page), [[400, 100], [400, 300]])
  await expect.poll(() => colorAt(canvas(page), 400, 200)).toBe('45,91,216')

  // Ctrl+Z 로 마지막 획을 되돌린다.
  await page.keyboard.press('Control+z')
  await expect.poll(() => colorAt(canvas(page), 400, 200)).toBe('255,255,255')
  expect(await colorAt(canvas(page), 200, 150)).toBe('28,29,32')
})

test('saves the drawing as a file that the rest of the system can see', async ({ page }) => {
  await launch(page, '그림판')
  await expect.poll(() => colorAt(canvas(page), 300, 200)).toBe('255,255,255')
  await drag(page, canvas(page), [[100, 150], [300, 150]])
  await page.keyboard.press('Control+s')
  await raise(page, '터미널')
  await shell(page, 'ls 그림', '\n그림 1.svg\n')
  await shell(page, 'grep -c polyline "그림/그림 1.svg"', '\n1\n')
})

test('keeps drawing sharp when the window is resized', async ({ page }) => {
  await launch(page, '그림판')
  await expect.poll(() => colorAt(canvas(page), 300, 200)).toBe('255,255,255')
  await drag(page, canvas(page), [[100, 150], [300, 150]])
  await paint(page).getByRole('button', { name: '최대화' }).click()
  // 화면 너비에서 왼쪽 막대(52)와 창 테두리(2)를 뺀 만큼
  await expect.poll(async () => (await canvas(page).boundingBox())!.width).toBe(1226)
  // 캔버스의 실제 해상도가 새 크기를 따라가고, 그림은 그대로 남는다.
  await expect.poll(() => canvas(page).evaluate((el: HTMLCanvasElement) => el.width / el.clientWidth)).toBe(1)
  await expect.poll(() => colorAt(canvas(page), 200, 150)).toBe('28,29,32')
  // 상태 줄이 새 크기의 아래쪽에 다시 그려졌다.
  const height = (await canvas(page).boundingBox())!.height
  await expect.poll(() => colorAt(canvas(page), 600, height - 13)).toBe('244,245,248')
})

test('follows the theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await launch(page, '그림판')
  await expect.poll(() => colorAt(canvas(page), 600, 20)).toBe('30,32,38')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => colorAt(canvas(page), 600, 20)).toBe('244,245,248')
})

test('closing the window ends the process, and ending the process closes the window', async ({ page }) => {
  await launch(page, '그림판')
  await expect(canvas(page)).toBeVisible()
  await paint(page).getByRole('button', { name: '닫기' }).click()
  await expect(paint(page)).toHaveCount(0)
  // (파이프로 바로 세면 grep 자신의 명령 줄이 함께 세어진다.)
  await shell(page, 'ps > /tmp/ps; grep -c paint /tmp/ps', '\n0\n')

  await launch(page, '그림판')
  await expect(canvas(page)).toBeVisible()
  await launch(page, '프로세스')
  await page.locator('.proc', { hasText: 'paint' }).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem').click()
  await expect(paint(page)).toHaveCount(0)
})

test('can be started from the terminal, and several can run at once', async ({ page }) => {
  await typeIn(page, term(page), 'paint &')
  await expect(paint(page)).toHaveCount(1)
  await launch(page, '그림판')
  await expect(paint(page)).toHaveCount(2)
  // 한 창에 그린 것은 다른 창(다른 프로세스)에 나타나지 않는다.
  const [first, second] = [paint(page).nth(0).getByRole('application'), paint(page).nth(1).getByRole('application')]
  await expect.poll(() => colorAt(second, 300, 200)).toBe('255,255,255')
  await drag(page, second, [[100, 150], [300, 150]])
  await expect.poll(() => colorAt(second, 200, 150)).toBe('28,29,32')
  await page.getByRole('button', { name: '창: 그림판' }).first().click()
  await expect.poll(() => colorAt(first, 200, 150)).toBe('255,255,255')
})

test('its window calls show up in the system call trace', async ({ page }) => {
  await launch(page, '시스템 콜')
  await launch(page, '그림판')
  await expect(canvas(page)).toBeVisible()
  const trace = appWindow(page, 'trace')
  await expect(trace).toContainText('guiopen("그림판", 720x480)')
  await expect(trace).toContainText(/guidraw\(\d+ bytes\)/)
  await expect(trace).toContainText(/guievent\(\)\s*= resize\(720, 480, 0\)/)
})
