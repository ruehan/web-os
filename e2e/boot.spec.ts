// 실제 브라우저에서 커널 → 셸 → 터미널 화면까지 전 구간을 확인한다.
import { expect, test, type Page } from '@playwright/test'

const PROMPT = 'guest@webos:~$ '

/** 터미널 화면의 글자를 줄 단위로 읽는다. */
const screen = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.terminal .line')]
      .map((line) => line.textContent ?? '')
      .join('\n')
      .trimEnd(),
  )

const expectScreen = (page: Page) => expect.poll(() => screen(page))

async function type(page: Page, line: string) {
  await page.locator('.terminal textarea').focus()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expectScreen(page).toMatch(/\$$/)
})

test('boots into a shell', async ({ page }) => {
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  const text = await screen(page)
  expect(text).toContain('kernel: cross-origin isolated = true')
  expect(text).toContain('kernel: ready')
  expect(text).toContain('Web OS 0.2')
  expect(text.endsWith(PROMPT.trimEnd())).toBe(true)
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
})

test('runs a pipeline of real processes', async ({ page }) => {
  await type(page, 'cat README.md | grep 프로세스 | wc -l')
  await expectScreen(page).toContain('wc -l\n2\n')
  await type(page, 'yes | head -n 3')
  await expectScreen(page).toContain('head -n 3\ny\ny\ny\nguest@webos')
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
})

test('redirection, variables and cd work', async ({ page }) => {
  await type(page, 'cd /tmp && echo "hi $USER" > note && cat note && pwd')
  await expectScreen(page).toContain('&& pwd\nhi guest\n/tmp\nguest@webos:/tmp$')
})

test('Ctrl+C stops the foreground process', async ({ page }) => {
  await type(page, 'spin')
  await expectScreen(page).toContain('spinning... 1s')
  await expect(page.getByTestId('procs')).toContainText('프로세스 2개')
  await page.keyboard.press('Control+c')
  await expectScreen(page).toMatch(/\^C\nguest@webos:~\$$/)
  await type(page, 'echo status=$?')
  await expectScreen(page).toContain('\nstatus=130\n')
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
})

test('a process can be killed from the process list', async ({ page }) => {
  await type(page, 'spin')
  await expectScreen(page).toContain('spinning... 0s')
  await page.locator('.proc', { hasText: 'spin' }).getByRole('button', { name: 'kill' }).click()
  await type(page, 'echo status=$?')
  await expectScreen(page).toContain('\nstatus=137\n')
})

test('line editing and wide characters render correctly', async ({ page }) => {
  await page.locator('.terminal textarea').focus()
  await page.keyboard.type('echo 한글x')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('국 ok')
  await page.keyboard.press('Enter')
  await expectScreen(page).toContain('echo 한국 ok\n한국 ok\n')
  expect(await page.locator('.terminal .wide').count()).toBeGreaterThanOrEqual(4)
})

test('clear wipes the screen', async ({ page }) => {
  await type(page, 'clear')
  await expectScreen(page).toBe(PROMPT.trimEnd())
})

test('ls colors directories on a terminal', async ({ page }) => {
  await type(page, 'ls /')
  await expectScreen(page).toContain('ls /\nbin  etc  home  tmp\n')
  const dir = page.locator('.terminal .line span', { hasText: /^bin$/ })
  await expect(dir).toHaveCSS('font-weight', '650')
})

test('the session can be restarted after exit', async ({ page }) => {
  await type(page, 'exit')
  await expectScreen(page).toContain('세션이 끝났습니다')
  await expect(page.getByTestId('procs')).toContainText('프로세스 0개')
  await page.keyboard.press('Enter')
  await expectScreen(page).toMatch(/새 셸을 시작합니다\]\n(.|\n)*\$$/)
  await type(page, 'echo back')
  await expectScreen(page).toContain('\nback\n')
})
