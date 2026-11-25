// 터미널 화면 전체를 쓰는 프로그램: top, vi.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, focusedWindow, launch, raise, screen, type } from './helpers.ts'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

/** 터미널에서 반전되어(배경과 글자색이 뒤바뀌어) 보이는 글자들 */
const inverted = (page: Page) =>
  focusedWindow(page)
    .locator('.terminal .line span')
    .evaluateAll((spans) =>
      spans
        .filter((s) => (s as HTMLElement).style.background.includes('--text'))
        .map((s) => s.textContent ?? '')
        .join(''),
    )

test('top shows live processes and restores the screen when it exits', async ({ page }) => {
  await type(page, 'echo before-top')
  await expectScreen(page).toMatch(/\nbefore-top\nguest@webos:~\$$/)
  await type(page, 'sleep 60 &')
  await expectScreen(page).toMatch(/\n\[\d+\]\nguest@webos:~\$$/)
  await type(page, 'top')
  await expectScreen(page).toContain('PID  PPID S TTY     TIME COMMAND')
  const text = await screen(page)
  expect(text).toMatch(/^가동 \d+초 · 프로세스 3개/)
  expect(text).not.toContain('before-top')
  // 머리줄과 선택된 줄(top 자신)이 반전되어 있다.
  await expect.poll(() => inverted(page)).toMatch(/PID\s+PPID S TTY\s+TIME COMMAND\s+\d+\s+1 R 1\s+[\d.]+ top/)

  // 위로 올라가 sleep을 골라 종료한다.
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => inverted(page)).toContain('sleep 60')
  await page.keyboard.press('x')
  await expectScreen(page).toContain('프로세스(sleep 60)를 종료했습니다.')
  await expectScreen(page).toMatch(/프로세스 2개/)

  await page.keyboard.press('q')
  await expectScreen(page).toMatch(/\$ top\n(\[\d+\] done \(143\)\n)?guest@webos:~\$$/)
  expect(await screen(page)).toContain('\nbefore-top\n')
})

test('vi edits a file inside the terminal', async ({ page }) => {
  await type(page, 'vi notes.txt')
  await expectScreen(page).toContain('"notes.txt" [새 파일]')
  await expect.poll(() => inverted(page)).toMatch(/^ notes\.txt\s+1:1 {2}1줄 $/)

  await page.keyboard.press('i')
  await expectScreen(page).toMatch(/-- 입력 --$/)
  await page.keyboard.type('첫 줄')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second line')
  await page.keyboard.press('Escape')
  await expect.poll(() => inverted(page)).toMatch(/notes\.txt \[\+\]\s+2:11 {2}2줄/)

  // 일반 모드: 첫 줄로 가서 줄을 복사해 붙인다.
  await page.keyboard.type('ggyyp')
  await expectScreen(page).toMatch(/^첫 줄\n첫 줄\nsecond line\n~/)
  await page.keyboard.type(':wq')
  await page.keyboard.press('Enter')

  await expectScreen(page).toMatch(/\$ vi notes\.txt\nguest@webos:~\$$/)
  await type(page, 'cat notes.txt')
  await expectScreen(page).toContain('cat notes.txt\n첫 줄\n첫 줄\nsecond line\n')

  // 파일 탐색기에서도 방금 만든 파일이 보인다.
  await launch(page, '파일')
  await expect(appWindow(page, 'files').locator('.file-name')).toHaveText(['hello.sh', 'notes.txt', 'README.md'])
})

test('a full-screen program follows the window size', async ({ page }) => {
  const terminal = focusedWindow(page)
  await type(page, 'vi README.md')
  await expectScreen(page).toContain('"README.md"')
  const lineCount = () => terminal.locator('.terminal .line').count()
  const before = await lineCount()

  // 창을 최대화하면 화면 줄 수가 늘고, 다음 키 입력 때 새 크기로 다시 그린다.
  await terminal.locator('.title').dblclick()
  await expect.poll(lineCount).toBeGreaterThan(before)
  await terminal.locator('.terminal textarea').focus()
  await page.keyboard.press('j')
  await expect.poll(async () => (await screen(page)).split('\n').length).toBeGreaterThan(before)
  await expect.poll(() => inverted(page)).toMatch(/README\.md\s+2:1/)
  await page.keyboard.type(':q')
  await page.keyboard.press('Enter')
  await expectScreen(page).toMatch(/guest@webos:~\$$/)
})

test('killing a full-screen program from the process list leaves a usable terminal', async ({ page }) => {
  await type(page, 'echo before-vi')
  await expectScreen(page).toMatch(/\nbefore-vi\nguest@webos:~\$$/)
  await type(page, 'vi')
  // 빈 문서: 첫 줄에는 커서만 있고 나머지는 파일 끝 표시(~)다.
  await expectScreen(page).toMatch(/^\s?\n~\n~/)
  await launch(page, '프로세스')
  await page.locator('.proc', { hasText: 'vi' }).getByRole('button', { name: '종료' }).click()

  await raise(page, '터미널')
  await expectScreen(page).toMatch(/before-vi\nguest@webos:~\$ vi\nguest@webos:~\$$/)
  await type(page, 'echo recovered')
  await expectScreen(page).toContain('\nrecovered\n')
})
