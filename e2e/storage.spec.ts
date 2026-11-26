// 영구 저장: /home 은 새로고침해도 남고, 나머지는 처음 상태로 돌아간다.
import { expect, test } from '@playwright/test'
import { appWindow, boot, expectScreen, fileRow, launch, removeSaved, screen, type } from './helpers.ts'

test.beforeEach(({ page }) => boot(page))

/** 저장이 끝날 시간을 준 뒤 페이지를 다시 연다. */
async function reload(page: import('@playwright/test').Page) {
  await page.waitForTimeout(700)
  await page.reload()
  await expectScreen(page).toMatch(/\$$/)
}

test('files survive a reload everywhere except /tmp', async ({ page }) => {
  await type(page, 'mkdir -p notes/deep && echo 남는다 > notes/deep/keep.txt && echo gone > /tmp/scratch.txt')
  await type(page, 'echo edited >> README.md && rm hello.sh')
  await expectScreen(page).toMatch(/rm hello\.sh\nguest@webos:~\$$/)
  await reload(page)

  await type(page, 'cat notes/deep/keep.txt; tail -n 1 README.md; ls; ls /tmp | wc -l')
  await expectScreen(page).toContain('wc -l\n남는다\nedited\nREADME.md  notes\n0\n')

  // 홈 밖의 디렉터리도 남는다: 고친 설정 파일, 직접 넣은 프로그램, 새로 만든 최상위 폴더
  await type(page, 'echo custom > /etc/motd && cp /bin/hello /bin/mine && mkdir /data && echo d > /data/x')
  await expectScreen(page).toMatch(/data\/x\nguest@webos:~\$$/)
  await reload(page)
  expect(await screen(page)).toMatch(/^custom\n/)
  await type(page, 'mine | head -n 1; cat /data/x; ls /')
  await expectScreen(page).toContain('ls /\nHello from a real WASM process!\nd\nbin  data  etc  home  proc  tmp\n')

  await launch(page, '시스템 로그')
  await expect(page.getByTestId('klog')).toContainText('storage: restored')
})

test('the first visit installs the default files and says so', async ({ page }) => {
  await launch(page, '시스템 로그')
  await expect(page.getByTestId('klog')).toContainText('storage: created persistent storage')
  await launch(page, '파일')
  await expect(appWindow(page, 'files').getByRole('option')).toHaveText(['hello.sh', 'README.md'])
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
  await settings.getByRole('button', { name: '처음 상태로 되돌리기…' }).click()
  await settings.getByRole('alertdialog').getByRole('button', { name: '취소' }).click()
  await expect(settings.getByRole('alertdialog')).toHaveCount(0)
  await settings.getByRole('button', { name: '처음 상태로 되돌리기…' }).click()
  await settings.getByRole('button', { name: '되돌리기', exact: true }).click()

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

test('shipped programs are refreshed on every start, even if the saved copy differs', async ({ page }) => {
  // 예전 버전의 프로그램이 저장돼 있던 상황을 만든다.
  await type(page, 'echo stale > /bin/hello')
  await expectScreen(page).toMatch(/bin\/hello\nguest@webos:~\$$/)
  await reload(page)
  await type(page, 'hello | head -n 1')
  await expectScreen(page).toContain('head -n 1\nHello from a real WASM process!\n')
})

test('a home saved by the previous storage layout is carried over', async ({ page }) => {
  // 예전에는 /home 의 내용만 "home" 이라는 이름으로 저장했다.
  await removeSaved(page, ['root'])
  await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory()
    const guest = await (await origin.getDirectoryHandle('home', { create: true })).getDirectoryHandle('guest', { create: true })
    const writable = await (await guest.getFileHandle('old.txt', { create: true })).createWritable()
    await writable.write('from the old layout\n')
    await writable.close()
  })
  await page.reload()
  await expectScreen(page).toMatch(/\$$/)
  await type(page, 'cat old.txt; ls')
  // 첫 방문이 아니므로 기본 파일을 다시 깔지 않는다.
  await expectScreen(page).toContain('cat old.txt; ls\nfrom the old layout\nold.txt\n')
  await reload(page)
  await type(page, 'cat old.txt')
  await expectScreen(page).toContain('cat old.txt\nfrom the old layout\n')
  expect(
    await page.evaluate(async () => {
      const names: string[] = []
      const origin = (await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> }
      for await (const name of origin.keys()) names.push(name)
      return names.sort()
    }),
  ).toEqual(['ready', 'root'])
})

test('a reload right after the very first start still gets the default files', async ({ page }) => {
  // 첫 저장이 끝나기 전에 닫힌 상황: 저장소 폴더는 생겼지만 내용도, 완료 표시도 없다.
  await removeSaved(page, ['ready', 'root'])
  await page.evaluate(async () => void (await (await navigator.storage.getDirectory()).getDirectoryHandle('root', { create: true })))
  await page.reload()
  await expectScreen(page).toMatch(/\$$/)
  await type(page, 'ls')
  await expectScreen(page).toContain('ls\nREADME.md  hello.sh\n')
  // 저장된 적이 없으므로 "저장해 둔 것이 사라졌다"고 알리지 않는다.
  await expect(page.getByRole('alert')).toHaveCount(0)
})
