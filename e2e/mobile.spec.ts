// 좁은 화면(휴대폰): 창 하나가 화면 전체를 쓰고, 실행 막대는 아래에 있다.
import { expect, test } from '@playwright/test'
import { appWindow, boot, box, drag, expectScreen, launch, type } from './helpers.ts'

const PHONE = { width: 390, height: 780 }

test.use({ viewport: PHONE, hasTouch: true })
test.beforeEach(({ page }) => boot(page))

test('a window fills the screen above the launcher bar', async ({ page }) => {
  const terminal = appWindow(page, 'terminal')
  const rail = await box(page.locator('.rail'))
  expect(rail.y + rail.h).toBe(PHONE.height)
  expect(rail.w).toBe(PHONE.width)
  expect(await box(terminal)).toEqual({ x: 0, y: 0, w: PHONE.width, h: rail.y })

  // 옮기거나 크기를 바꾸는 수단이 없다.
  await expect(terminal.locator('.resize')).toHaveCount(0)
  await expect(terminal.getByRole('button', { name: '최대화' })).toHaveCount(0)
  await drag(page, { x: 150, y: 18 }, 80, 120)
  expect((await box(terminal)).y).toBe(0)
  // 페이지 자체가 옆으로 밀리지 않는다.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(PHONE.width)
})

test('the terminal works and wraps to the narrow width', async ({ page }) => {
  await type(page, 'echo ' + 'abcdefghij'.repeat(5))
  const text = 'abcdefghij'.repeat(5)
  await expect.poll(async () => (await page.locator('.terminal .line').allTextContents()).join('')).toContain(`${text}${text}`)
  await type(page, 'ls /')
  await expectScreen(page).toContain('\nbin  etc  home  proc  tmp\n')
  // 셸이 처음부터 실제 화면 폭을 알고 있어서, 폭을 잘못 계산한 흔적(% 표시)이 남지 않는다.
  expect(await page.locator('.terminal .line').allTextContents()).not.toContain('%')
})

test('extra keys stand in for the ones a phone keyboard lacks', async ({ page }) => {
  const keys = page.getByRole('toolbar', { name: '추가 키' })
  await type(page, 'echo first')
  await expectScreen(page).toContain('\nfirst\n')

  await keys.getByRole('button', { name: '위', exact: true }).click()
  await expectScreen(page).toMatch(/\$ echo first$/)
  // 버튼을 눌러도 입력창의 포커스가 유지되어 화면 키보드가 닫히지 않는다.
  await expect(page.locator('.terminal textarea')).toBeFocused()
  await keys.getByRole('button', { name: '왼쪽' }).click()
  await page.keyboard.type('X')
  await expectScreen(page).toMatch(/\$ echo firsXt$/)
  await keys.getByRole('button', { name: 'Ctrl+C' }).click()

  await page.keyboard.type('exitc')
  await keys.getByRole('button', { name: 'Tab' }).click()
  await expectScreen(page).toMatch(/\$ exitcode$/)
  await keys.getByRole('button', { name: 'Ctrl+C' }).click()

  await type(page, 'spin')
  await expectScreen(page).toContain('spinning... 0s')
  await keys.getByRole('button', { name: 'Ctrl+C' }).click()
  await expectScreen(page).toMatch(/\^C\nguest@webos:~\$$/)

  await type(page, 'cat')
  await type(page, 'typed')
  await keys.getByRole('button', { name: 'Ctrl+D' }).click()
  await expectScreen(page).toMatch(/typed\ntyped\nguest@webos:~\$$/)
})

test('apps open full-screen and the bar switches between them', async ({ page }) => {
  await launch(page, '파일')
  const files = appWindow(page, 'files')
  const terminal = appWindow(page, 'terminal')
  await expect(files).toHaveClass(/focused/)
  expect((await box(files)).w).toBe(PHONE.width)
  await expect(files.locator('.file-name')).toHaveText(['hello.sh', 'README.md'])

  await page.getByRole('button', { name: '창: 터미널' }).click()
  await expect(terminal).toHaveClass(/focused/)
  await files.locator('.file-name').first().waitFor({ state: 'attached' })

  await page.getByRole('button', { name: '창: guest' }).click()
  await files.locator('.file-row', { hasText: 'README.md' }).dblclick()
  const editor = appWindow(page, 'editor')
  await expect(editor).toHaveClass(/focused/)
  expect(await box(editor)).toEqual(await box(files))
  await editor.getByRole('button', { name: '닫기' }).click()
  await expect(files).toHaveClass(/focused/)
})

test('the layout follows the screen when it becomes wide again', async ({ page }) => {
  const terminal = appWindow(page, 'terminal')
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByRole('toolbar', { name: '추가 키' })).toHaveCount(0)
  await expect(terminal.locator('.resize')).toHaveCount(8)
  const wide = await box(terminal)
  expect(wide.w).toBeLessThan(1280 - 52)
  expect((await box(page.locator('.rail'))).w).toBe(52)
  // 창이 다시 끌 수 있는 상태가 되고, 터미널도 계속 동작한다.
  await drag(page, { x: wide.x + 150, y: wide.y + 18 }, 200, 100)
  expect(await box(terminal)).toEqual({ ...wide, x: wide.x + 200, y: wide.y + 100 })
  await type(page, 'echo wide-again')
  await expectScreen(page).toContain('\nwide-again\n')
})
