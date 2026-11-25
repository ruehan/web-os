// 실제 브라우저에서 커널 → 셸 → 터미널 화면까지 전 구간을 확인한다.
import { expect, test } from '@playwright/test'
import { PROMPT, boot, expectScreen, focusedWindow, launch, pinWindow, screen, type } from './helpers.ts'

test.beforeEach(({ page }) => boot(page))

test('boots into a desktop with a shell', async ({ page }) => {
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  const text = await screen(page)
  expect(text).toContain('Web OS 0.6')
  expect(text.endsWith(PROMPT)).toBe(true)

  await launch(page, '시스템 로그')
  const log = page.getByTestId('klog')
  await expect(log).toContainText('kernel: cross-origin isolated = true')
  await expect(log).toContainText('kernel: ready')

  await launch(page, '프로세스')
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
})

test('runs a pipeline of real processes', async ({ page }) => {
  await type(page, 'cat README.md | grep 프로세스 | wc -l')
  await expectScreen(page).toContain('wc -l\n2\n')
  await type(page, 'yes | head -n 3')
  await expectScreen(page).toContain('head -n 3\ny\ny\ny\nguest@webos')
  await launch(page, '프로세스')
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
})

test('redirection, variables and cd work', async ({ page }) => {
  await type(page, 'cd /tmp && echo "hi $USER" > note && cat note && pwd')
  await expectScreen(page).toContain('&& pwd\nhi guest\n/tmp\nguest@webos:/tmp$')
})

test('Ctrl+C stops the foreground process', async ({ page }) => {
  const terminal = await pinWindow(page)
  await type(page, 'spin')
  await expectScreen(page).toContain('spinning... 1s')
  await page.keyboard.press('Control+c')
  await expectScreen(page).toMatch(/\^C\nguest@webos:~\$$/)
  await type(page, 'echo status=$?')
  await expectScreen(page).toContain('\nstatus=130\n')
  await launch(page, '프로세스')
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
  await expect(terminal).not.toHaveClass(/focused/)
})

test('a process can be killed from the process list', async ({ page }) => {
  const terminal = await pinWindow(page)
  await type(page, 'spin')
  await expectScreen(page).toContain('spinning... 0s')
  await launch(page, '프로세스')
  await expect(page.getByTestId('procs')).toContainText('프로세스 2개')
  await page.locator('.proc', { hasText: 'spin' }).getByRole('button', { name: '종료' }).click()
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
  // 프로세스 창이 터미널을 일부 가리고 있으므로, 키보드 포커스를 옮겨 터미널을 앞으로 가져온다.
  await terminal.locator('.terminal textarea').focus()
  await expect(terminal).toHaveClass(/focused/)
  await type(page, 'echo status=$?')
  await expectScreen(page).toContain('\nstatus=137\n')
})

test('line editing and wide characters render correctly', async ({ page }) => {
  await focusedWindow(page).locator('.terminal textarea').focus()
  await page.keyboard.type('echo 한글x')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('국 ok')
  await page.keyboard.press('Enter')
  await expectScreen(page).toContain('echo 한국 ok\n한국 ok\n')
  expect(await focusedWindow(page).locator('.terminal .wide').count()).toBeGreaterThanOrEqual(4)
})

test('clear wipes the screen', async ({ page }) => {
  await type(page, 'clear')
  await expectScreen(page).toBe(PROMPT)
})

test('ls colors directories on a terminal', async ({ page }) => {
  await type(page, 'ls /')
  await expectScreen(page).toContain('ls /\nbin  etc  home  proc  tmp\n')
  const dir = focusedWindow(page).locator('.terminal .line span', { hasText: /^bin$/ })
  await expect(dir).toHaveCSS('font-weight', '650')
})

test('exiting the shell closes its window', async ({ page }) => {
  await type(page, 'exit')
  await expect(page.locator('.window')).toHaveCount(0)
  await launch(page, '터미널')
  await expectScreen(page).toMatch(/\$$/)
  await type(page, 'echo back')
  await expectScreen(page).toContain('\nback\n')
})

test('arrow keys recall history and move the cursor', async ({ page }) => {
  await type(page, 'echo first')
  await type(page, 'echo second')
  await expectScreen(page).toMatch(/\nsecond\nguest@webos:~\$$/)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expectScreen(page).toMatch(/\$ echo first$/)
  await page.keyboard.press('Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type('the ')
  await page.keyboard.press('Enter')
  await expectScreen(page).toContain('echo the first\nthe first\n')
})

test('Tab completes commands and file names', async ({ page }) => {
  await focusedWindow(page).locator('.terminal textarea').focus()
  await page.keyboard.type('exitc')
  await page.keyboard.press('Tab')
  await expectScreen(page).toMatch(/\$ exitcode$/)
  await page.keyboard.press('Control+u')
  await page.keyboard.type('cat REA')
  await page.keyboard.press('Tab')
  await expectScreen(page).toMatch(/\$ cat README\.md$/)
  await page.keyboard.type('| wc -l')
  await page.keyboard.press('Enter')
  await expectScreen(page).toMatch(/wc -l\n\d+\nguest@webos:~\$$/)
  // Tab이 페이지의 다른 요소로 포커스를 옮기지 않아야 한다.
  await expect(focusedWindow(page).locator('.terminal textarea')).toBeFocused()
})

test('a long line wraps and stays editable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 700 })
  const text = 'echo ' + 'abcdefghij'.repeat(6)
  await focusedWindow(page).locator('.terminal textarea').focus()
  await page.keyboard.type(text)
  await page.keyboard.press('Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type('X')
  await page.keyboard.press('Enter')
  // 창 폭에 따라 줄이 나뉘므로 줄바꿈을 빼고 비교한다.
  const line = 'X' + 'abcdefghij'.repeat(6)
  await expect.poll(async () => (await screen(page)).replaceAll('\n', '')).toContain(line + line + 'guest@webos')
  expect((await screen(page)).split('guest@webos').length).toBe(3)
})
