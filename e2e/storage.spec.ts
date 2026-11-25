// 영구 저장: /home 은 새로고침해도 남고, 나머지는 처음 상태로 돌아간다.
import { expect, test } from '@playwright/test'
import { appWindow, boot, expectScreen, fileRow, launch, screen, type } from './helpers.ts'

test.beforeEach(({ page }) => boot(page))

/** 저장이 끝날 시간을 준 뒤 페이지를 다시 연다. */
async function reload(page: import('@playwright/test').Page) {
  await page.waitForTimeout(700)
  await page.reload()
  await expectScreen(page).toMatch(/\$$/)
}

test('files in the home folder survive a reload; other folders do not', async ({ page }) => {
  await type(page, 'mkdir -p notes/deep && echo 남는다 > notes/deep/keep.txt && echo gone > /tmp/scratch.txt')
  await type(page, 'echo edited >> README.md && rm hello.sh')
  await expectScreen(page).toMatch(/rm hello\.sh\nguest@webos:~\$$/)
  await reload(page)

  await type(page, 'cat notes/deep/keep.txt; tail -n 1 README.md; ls; ls /tmp | wc -l')
  await expectScreen(page).toContain('wc -l\n남는다\nedited\nREADME.md  notes\n0\n')

  await launch(page, '시스템 로그')
  await expect(page.getByTestId('klog')).toContainText('storage: restored')
})

test('the first visit installs the default files and says so', async ({ page }) => {
  await launch(page, '시스템 로그')
  await expect(page.getByTestId('klog')).toContainText('storage: created persistent /home')
  await launch(page, '파일')
  await expect(appWindow(page, 'files').locator('.file-name')).toHaveText(['hello.sh', 'README.md'])
})

test('files saved from the editor and the file browser persist too', async ({ page }) => {
  await launch(page, '파일')
  await fileRow(page, 'README.md').dblclick()
  const editor = appWindow(page, 'editor')
  await editor.getByRole('textbox', { name: '파일 내용' }).fill('편집기에서 저장한 내용\n')
  await page.keyboard.press('Control+s')
  await expect(editor.locator('.title')).toHaveText('README.md')
  await reload(page)
  await type(page, 'cat README.md')
  await expectScreen(page).toContain('cat README.md\n편집기에서 저장한 내용\n')
})

test('command history is remembered across reloads', async ({ page }) => {
  await type(page, 'echo remember-me')
  await expectScreen(page).toContain('\nremember-me\n')
  await reload(page)
  await page.keyboard.press('ArrowUp')
  await expectScreen(page).toMatch(/\$ echo remember-me$/)
  // 이력 파일은 숨김 파일이라 평소 목록에는 보이지 않는다.
  await page.keyboard.press('Control+u')
  await type(page, 'ls; ls -a | grep -c sh_history')
  await expectScreen(page).toContain('\nREADME.md  hello.sh\n1\n')
})

test('resetting storage restores the first-visit state', async ({ page }) => {
  await type(page, 'rm README.md && echo mine > mine.txt')
  await expectScreen(page).toMatch(/mine\.txt\nguest@webos:~\$$/)
  await page.waitForTimeout(700)

  await launch(page, '설정')
  const settings = appWindow(page, 'settings')
  await settings.getByRole('button', { name: '홈 폴더 초기화…' }).click()
  await settings.getByRole('alertdialog').getByRole('button', { name: '취소' }).click()
  await expect(settings.getByRole('alertdialog')).toHaveCount(0)
  await settings.getByRole('button', { name: '홈 폴더 초기화…' }).click()
  await settings.getByRole('button', { name: '초기화', exact: true }).click()

  // 페이지가 다시 열리고 기본 파일만 남는다.
  await expect(appWindow(page, 'settings')).toHaveCount(0)
  await expectScreen(page).toMatch(/\$$/)
  await type(page, 'ls')
  await expectScreen(page).toContain('ls\nREADME.md  hello.sh\n')
  expect(await screen(page)).not.toContain('mine.txt')
})
