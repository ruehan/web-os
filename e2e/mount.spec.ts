// 로컬 폴더 연결. 운영체제의 폴더 선택 창은 자동화할 수 없으므로, 선택 창이 브라우저 저장소 안의
// 폴더를 돌려주도록 바꿔치기한다. 돌려받는 핸들의 종류와 쓰는 방법은 실제 로컬 폴더와 같다.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, fileRow, launch, pinWindow, raise, typeIn } from './helpers.ts'

/** 선택 창이 돌려줄 폴더를 정한다. 'cancel'이면 사용자가 취소한 것처럼 동작한다. */
const stubPicker = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.showDirectoryPicker = async () => {
      const choice = (w.__pick as string | undefined) ?? 'picked'
      if (choice === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError')
      return (await navigator.storage.getDirectory()).getDirectoryHandle(choice, { create: true })
    }
  })

/** 고를 폴더에 미리 파일을 넣어 둔다. */
const seed = (page: Page, folder: string, files: Record<string, string>) =>
  page.evaluate(
    async ({ folder, files }) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true })
      for (const [path, text] of Object.entries(files)) {
        const parts = path.split('/')
        const name = parts.pop()!
        let dir = root
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
        await writable.write(text)
        await writable.close()
      }
    },
    { folder, files },
  )

/** 폴더에 실제로 들어 있는 것을 읽는다: 경로 → 내용 (폴더는 null) */
const onDisk = (page: Page, folder: string) =>
  page.evaluate(async (folder) => {
    const out: Record<string, string | null> = {}
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()
      for await (const [name, handle] of entries) {
        if (handle.kind === 'directory') {
          out[prefix + name] = null
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)
        } else {
          out[prefix + name] = await (await (handle as FileSystemFileHandle).getFile()).text()
        }
      }
    }
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(folder), '')
    return out
  }, folder)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubPicker(page)
  await boot(page)
})

test('connects a folder: its files appear, and edits land in the real files', async ({ page }) => {
  const term = await pinWindow(page)
  await seed(page, 'picked', { 'a.txt': 'from disk\n', 'docs/b.txt': 'nested\n' })
  await launch(page, '파일')
  const files = appWindow(page, 'files')
  await files.getByRole('button', { name: '로컬 폴더 연결' }).click()

  // 연결되면 그 폴더로 이동한다.
  await expect(files.locator('.crumb')).toHaveText(['/', 'mnt', 'picked'])
  await expect(files.locator('.file-name')).toHaveText(['docs', 'a.txt'])

  await typeIn(page, term, 'cat /mnt/picked/a.txt /mnt/picked/docs/b.txt; grep localdir /proc/mounts')
  await expectScreen(page, term).toContain('\nfrom disk\nnested\nlocaldir /mnt/picked rw,persistent\n')

  // 터미널에서 만든 것, 고친 것, 지운 것이 실제 폴더에 반영된다.
  await typeIn(page, term, 'cd /mnt/picked && echo new > made.txt && echo more >> a.txt && mkdir empty && rm docs/b.txt')
  await expect
    .poll(() => onDisk(page, 'picked'))
    .toEqual({ 'a.txt': 'from disk\nmore\n', docs: null, empty: null, 'made.txt': 'new\n' })

  // 편집기로 저장한 내용도 마찬가지다.
  await raise(page, 'picked')
  await fileRow(page, 'made.txt').dblclick()
  const editor = appWindow(page, 'editor')
  await editor.getByRole('textbox', { name: '파일 내용' }).fill('편집기에서 고침\n')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await onDisk(page, 'picked'))['made.txt']).toBe('편집기에서 고침\n')
})

test('disconnecting removes the mount but leaves the real files alone', async ({ page }) => {
  const term = await pinWindow(page)
  await seed(page, 'picked', { 'keep.txt': 'still here\n' })
  await launch(page, '설정')
  const settings = appWindow(page, 'settings')
  await settings.getByRole('button', { name: '폴더 연결…' }).click()
  const row = settings.getByRole('list', { name: '연결된 폴더' }).getByRole('listitem')
  await expect(row).toContainText('/mnt/picked')
  await expect(row).toContainText('연결됨')

  await typeIn(page, term, 'echo late > /mnt/picked/late.txt')
  await raise(page, '설정')
  await row.getByRole('button', { name: '연결 해제' }).click()
  await expect(row).toHaveCount(0)
  // 해제 직전의 변경까지 저장한 뒤에 끊는다.
  expect(await onDisk(page, 'picked')).toEqual({ 'keep.txt': 'still here\n', 'late.txt': 'late\n' })

  await typeIn(page, term, 'ls /mnt | wc -l; echo after > /mnt/picked/x')
  await expectScreen(page, term).toContain('\n0\nsh: /mnt/picked/x: No such file or directory\n')
  expect(Object.keys(await onDisk(page, 'picked'))).not.toContain('x')
})

test('a connected folder comes back after a reload', async ({ page }) => {
  await seed(page, 'picked', { 'a.txt': 'one\n' })
  await launch(page, '파일')
  await appWindow(page, 'files').getByRole('button', { name: '로컬 폴더 연결' }).click()
  await expect(fileRow(page, 'a.txt')).toBeVisible()
  await typeIn(page, appWindow(page, 'terminal'), 'echo two >> /mnt/picked/a.txt')
  await expect.poll(async () => (await onDisk(page, 'picked'))['a.txt']).toBe('one\ntwo\n')

  await page.reload()
  const term = appWindow(page, 'terminal')
  await expectScreen(page, term).toMatch(/\$$/)
  // 권한이 남아 있으면 다시 고르지 않아도 연결된다.
  await launch(page, '설정')
  await expect(appWindow(page, 'settings').getByRole('list', { name: '연결된 폴더' })).toContainText('연결됨')
  await typeIn(page, term, 'cat /mnt/picked/a.txt')
  await expectScreen(page, term).toContain('cat /mnt/picked/a.txt\none\ntwo\n')
})

test('refuses a folder over the limit, until the limit is raised', async ({ page }) => {
  // 기본 한도(파일 2천 개)를 하나 넘는 폴더
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
    await Promise.all(Array.from({ length: 2001 }, (_, i) => root.getFileHandle(`f${i}`, { create: true })))
  })
  await launch(page, '설정')
  const settings = appWindow(page, 'settings')
  await settings.getByRole('button', { name: '폴더 연결…' }).click()
  const alert = settings.getByRole('alert')
  await expect(alert).toContainText('폴더가 너무 큽니다 (파일 2,001개 이상')
  await expect(alert).toContainText('지금 한도는 100MB · 파일 2천 개입니다')
  await expect(settings.getByRole('list', { name: '연결된 폴더' }).getByRole('listitem')).toHaveCount(0)
  await typeIn(page, appWindow(page, 'terminal'), 'ls /mnt | wc -l')
  await expectScreen(page, appWindow(page, 'terminal')).toContain('wc -l\n0\n')

  await raise(page, '설정')
  await settings.getByRole('button', { name: '500MB · 파일 1만 개' }).click()
  await settings.getByRole('button', { name: '폴더 연결…' }).click()
  await expect(settings.getByRole('list', { name: '연결된 폴더' })).toContainText('연결됨')
  await expect(alert).toHaveCount(0)
  // 고른 한도는 다음 방문에도 유지된다.
  await page.reload()
  await expectScreen(page, appWindow(page, 'terminal')).toMatch(/\$$/)
  await launch(page, '설정')
  await expect(appWindow(page, 'settings').getByRole('button', { name: '500MB · 파일 1만 개' })).toHaveAttribute('aria-pressed', 'true')
})

test('cancelling the folder picker changes nothing', async ({ page }) => {
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__pick = 'cancel'))
  await launch(page, '파일')
  const files = appWindow(page, 'files')
  await files.getByRole('button', { name: '로컬 폴더 연결' }).click()
  await expect(files.locator('.crumb')).toHaveText(['/', 'home', 'guest'])
  await expect(files.getByRole('alert')).toHaveCount(0)
})

test('picking the same folder twice does not connect it twice', async ({ page }) => {
  await seed(page, 'picked', { 'a.txt': 'x' })
  await launch(page, '설정')
  const settings = appWindow(page, 'settings')
  const rows = settings.getByRole('list', { name: '연결된 폴더' }).getByRole('listitem')
  await settings.getByRole('button', { name: '폴더 연결…' }).click()
  await expect(rows).toHaveCount(1)
  await settings.getByRole('button', { name: '폴더 연결…' }).click()
  await expect(rows).toHaveCount(1)

  // 다른 폴더는 따로 연결된다.
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__pick = 'other'))
  await settings.getByRole('button', { name: '폴더 연결…' }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText('/mnt/other')
})

test('is hidden where the browser cannot do it', async ({ page }) => {
  await page.addInitScript(() => delete (window as unknown as Record<string, unknown>).showDirectoryPicker)
  await page.reload()
  await expectScreen(page, appWindow(page, 'terminal')).toMatch(/\$$/)
  await launch(page, '파일')
  await expect(appWindow(page, 'files').getByRole('button', { name: '새 폴더' })).toBeVisible()
  await expect(appWindow(page, 'files').getByRole('button', { name: '로컬 폴더 연결' })).toHaveCount(0)
  await launch(page, '설정')
  await expect(appWindow(page, 'settings')).toContainText('이 브라우저는 로컬 폴더 연결을 지원하지 않습니다')
  await expect(appWindow(page, 'settings').getByRole('button', { name: '폴더 연결…' })).toHaveCount(0)
})
