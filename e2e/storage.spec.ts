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

test.describe('storage protection', () => {
  /** 브라우저의 판단을 정해 둔다: 지금 보호 중인지, 요청하면 허용할지. */
  const stubPersistence = (page: import('@playwright/test').Page, start: boolean, grant: boolean) =>
    page.addInitScript(
      ({ start, grant }) => {
        const state = { kept: start, asked: 0 }
        ;(window as unknown as Record<string, unknown>).__persistence = state
        navigator.storage.persisted = async () => state.kept
        navigator.storage.persist = async () => {
          state.asked++
          if (grant) state.kept = true
          return state.kept
        }
      },
      { start, grant },
    )
  const asked = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as unknown as { __persistence: { asked: number } }).__persistence.asked)

  test('is requested at startup and shown in settings with the usage', async ({ page }) => {
    await stubPersistence(page, false, true)
    await page.reload()
    await expectScreen(page).toMatch(/\$$/)
    expect(await asked(page)).toBe(1)

    await launch(page, '설정')
    const facts = appWindow(page, 'settings').getByLabel('저장 상태')
    await expect(facts).toContainText('보호됨 · 브라우저가 이 데이터를 임의로 지우지 않습니다.')
    await expect(facts).toContainText(/사용량\s*[\d.]+ (B|KB|MB) \/ [\d.]+ (MB|GB)/)
    await expect(appWindow(page, 'settings').getByRole('button', { name: '보호 요청' })).toHaveCount(0)
  })

  test('says so when the browser will not protect the data', async ({ page }) => {
    await stubPersistence(page, false, false)
    await page.reload()
    await expectScreen(page).toMatch(/\$$/)
    await launch(page, '설정')
    const settings = appWindow(page, 'settings')
    await expect(settings.getByLabel('저장 상태')).toContainText('보호되지 않음')
    await expect(settings.getByLabel('저장 상태')).toContainText('브라우저가 이 데이터를 지울 수')

    await settings.getByRole('button', { name: '보호 요청' }).click()
    await expect(settings.getByRole('status')).toContainText('브라우저가 아직 허용하지 않았습니다')
    expect(await asked(page)).toBe(2)
  })

  test('the request button works once the browser agrees', async ({ page }) => {
    await stubPersistence(page, false, false)
    await page.reload()
    await expectScreen(page).toMatch(/\$$/)
    await launch(page, '설정')
    const settings = appWindow(page, 'settings')
    await expect(settings.getByRole('button', { name: '보호 요청' })).toBeVisible()
    // 그사이 사용자가 사이트를 북마크하는 등 브라우저의 판단이 바뀐 상황
    await page.evaluate(() => {
      const state = (window as unknown as { __persistence: { kept: boolean } }).__persistence
      navigator.storage.persist = async () => (state.kept = true)
    })
    await settings.getByRole('button', { name: '보호 요청' }).click()
    await expect(settings.getByLabel('저장 상태')).toContainText('보호됨')
    await expect(settings.getByRole('button', { name: '보호 요청' })).toHaveCount(0)
  })
})
