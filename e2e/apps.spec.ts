// 시스템 앱: 파일 탐색기, 편집기, 설정.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { appWindow, boot, expectScreen, fileRow, launch, pinWindow, raise, typeIn } from './helpers.ts'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test.describe('files', () => {
  test('browses folders with double-click, breadcrumbs and the up button', async ({ page }) => {
    await launch(page, '파일')
    const files = appWindow(page, 'files')
    await expect(files.locator('.file-name')).toHaveText(['hello.sh', 'README.md'])
    await expect(files.locator('.statusbar')).toHaveText('항목 2개')
    await expect(files.locator('.title')).toHaveText('guest')

    await files.getByRole('button', { name: '위 폴더로' }).click()
    await expect(files.locator('.file-name')).toHaveText(['guest'])
    await files.getByRole('navigation', { name: '현재 위치' }).getByRole('button', { name: '/', exact: true }).click()
    // 폴더가 먼저, 이름순으로 나온다.
    await expect(files.locator('.file-name')).toHaveText(['bin', 'etc', 'home', 'tmp'])
    await expect(files.getByRole('button', { name: '위 폴더로' })).toBeDisabled()

    await fileRow(page, 'etc').dblclick()
    await expect(files.locator('.file-name')).toHaveText(['motd'])
    await expect(files.locator('.crumb')).toHaveText(['/', 'etc'])
  })

  test('creates, renames and deletes, and the shell sees the result', async ({ page }) => {
    const term = await pinWindow(page)
    await launch(page, '파일')
    const files = appWindow(page, 'files')

    await files.getByRole('button', { name: '새 폴더' }).click()
    const rename = files.getByRole('textbox', { name: '새 이름' })
    await expect(rename).toBeFocused()
    await expect(rename).toHaveValue('새 폴더')
    await page.keyboard.type('docs')
    await page.keyboard.press('Enter')
    await expect(files.locator('.file-name')).toHaveText(['docs', 'hello.sh', 'README.md'])

    await files.getByRole('button', { name: '새 파일' }).click()
    await expect(rename).toHaveValue('새 파일.txt')
    await expect(rename).toBeFocused()
    await page.keyboard.type('note')
    await page.keyboard.press('Enter')
    // 확장자는 남기고 이름만 바뀐다.
    await expect(fileRow(page, 'note.txt')).toBeVisible()

    await typeIn(page, term, 'ls')
    await expectScreen(page, term).toContain('\nREADME.md  docs  hello.sh  note.txt\n')

    await raise(page, 'guest')
    await fileRow(page, 'note.txt').click()
    await files.getByRole('button', { name: '이름 바꾸기' }).click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('hello.sh')
    await page.keyboard.press('Enter')
    await expect(files.getByRole('alert')).toHaveText('같은 이름이 이미 있습니다.')
    await expect(fileRow(page, 'note.txt')).toBeVisible()

    await fileRow(page, 'note.txt').click()
    await files.getByRole('button', { name: '삭제' }).click()
    await expect(files.locator('.statusbar')).toContainText('“note.txt”을(를) 지울까요?')
    await files.getByRole('button', { name: '취소' }).click()
    await expect(fileRow(page, 'note.txt')).toBeVisible()
    await files.getByRole('button', { name: '삭제' }).click()
    await files.getByRole('button', { name: '지우기' }).click()
    await expect(fileRow(page, 'note.txt')).toHaveCount(0)
  })

  test('reflects changes made in the terminal without a manual refresh', async ({ page }) => {
    const term = await pinWindow(page)
    await launch(page, '파일')
    await typeIn(page, term, 'mkdir work && echo hi > work/a.txt && touch from-shell.txt')
    await expect(fileRow(page, 'from-shell.txt')).toBeVisible()
    await expect(fileRow(page, 'work').locator('.file-size')).toHaveText('항목 1개')

    await raise(page, 'guest')
    await fileRow(page, 'work').dblclick()
    await expect(fileRow(page, 'a.txt').locator('.file-size')).toHaveText('3 B')
    // 보고 있던 폴더가 지워지면 위 폴더로 물러난다.
    await typeIn(page, term, 'rm -r work')
    await expect(appWindow(page, 'files').locator('.crumb')).toHaveText(['/', 'home', 'guest'])
  })

  test('keyboard navigation opens folders and asks before deleting', async ({ page }) => {
    await launch(page, '파일')
    const files = appWindow(page, 'files')
    await files.getByRole('navigation', { name: '현재 위치' }).getByRole('button', { name: 'home' }).click()
    await expect(files.locator('.file-name')).toHaveText(['guest'])
    await files.getByRole('listbox').focus()
    await page.keyboard.press('ArrowDown')
    await expect(fileRow(page, 'guest')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(files.locator('.file-name')).toHaveText(['hello.sh', 'README.md'])
    await files.getByRole('listbox').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Delete')
    await expect(files.locator('.statusbar')).toContainText('“README.md”을(를) 지울까요?')
    await page.keyboard.press('Escape')
    await expect(files.getByRole('button', { name: '지우기' })).toHaveCount(0)
    await expect(fileRow(page, 'README.md')).toBeVisible()
  })

  test('a dropped .wasm file can be run from the terminal', async ({ page }) => {
    const term = await pinWindow(page)
    await launch(page, '파일')
    // 직접 컴파일한 프로그램을 끌어다 놓는 상황을 재현한다.
    const wasm = [...readFileSync(new URL('../public/bin/hello.wasm', import.meta.url))]
    await appWindow(page, 'files')
      .locator('.files')
      .evaluate((el, bytes) => {
        const data = new DataTransfer()
        data.items.add(new File([new Uint8Array(bytes)], 'mine.wasm'))
        el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
      }, wasm)
    await expect(fileRow(page, 'mine.wasm')).toBeVisible()

    await typeIn(page, term, './mine.wasm dropped')
    await expectScreen(page, term).toContain('Hello from a real WASM process!\nargv = ["./mine.wasm", "dropped"]')
  })
})

test.describe('editor', () => {
  test('opens a file from the file browser, edits and saves it', async ({ page }) => {
    const term = await pinWindow(page)
    await launch(page, '파일')
    await fileRow(page, 'hello.sh').dblclick()
    const editor = appWindow(page, 'editor')
    const text = editor.getByRole('textbox', { name: '파일 내용' })
    await expect(text).toHaveValue(/^# 셸 스크립트 예제\n/)
    await expect(editor.locator('.title')).toHaveText('hello.sh')
    await expect(editor.getByRole('button', { name: '저장' })).toBeDisabled()

    await text.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('echo "편집기에서 추가"')
    await expect(editor.locator('.title')).toHaveText('hello.sh •')
    await page.keyboard.press('Control+s')
    await expect(editor.locator('.title')).toHaveText('hello.sh')

    await typeIn(page, term, 'sh hello.sh | tail -n 1')
    await expectScreen(page, term).toContain('tail -n 1\n편집기에서 추가\n')

    // 같은 파일을 다시 열면 새 창을 만들지 않고 기존 창을 앞으로 가져온다.
    await raise(page, 'guest')
    await fileRow(page, 'hello.sh').dblclick()
    await expect(appWindow(page, 'editor')).toHaveCount(1)
    await expect(editor).toHaveClass(/focused/)
  })

  test('asks before closing with unsaved changes', async ({ page }) => {
    await launch(page, '파일')
    await fileRow(page, 'README.md').dblclick()
    const editor = appWindow(page, 'editor')
    await editor.getByRole('textbox', { name: '파일 내용' }).focus()
    await page.keyboard.type('수정 ')

    await editor.getByRole('button', { name: '닫기' }).click()
    const dialog = editor.getByRole('alertdialog')
    await expect(dialog).toContainText('저장하지 않은 변경이 있습니다.')
    await dialog.getByRole('button', { name: '취소' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(editor).toBeVisible()

    await editor.getByRole('button', { name: '닫기' }).click()
    await editor.getByRole('button', { name: '저장 안 함' }).click()
    await expect(editor).toHaveCount(0)
    // 버린 변경은 파일에 남지 않는다.
    await fileRow(page, 'README.md').dblclick()
    await expect(appWindow(page, 'editor').getByRole('textbox', { name: '파일 내용' })).toHaveValue(/^# 환영합니다/)
  })

  test('a new document asks where to save, also when closing', async ({ page }) => {
    await launch(page, '편집기')
    const editor = appWindow(page, 'editor')
    await expect(editor.locator('.title')).toHaveText('제목 없음')
    await expect(editor.getByRole('textbox', { name: '파일 내용' })).toBeFocused()
    await page.keyboard.type('첫 줄')
    await page.keyboard.press('Tab')
    await page.keyboard.type('들여쓰기')
    await expect(editor.locator('.statusbar')).toContainText('1:10')

    await editor.getByRole('button', { name: '닫기' }).click()
    await editor.getByRole('button', { name: '저장하고 닫기' }).click()
    const where = editor.getByRole('textbox', { name: '저장할 위치' })
    await expect(where).toHaveValue('/home/guest/제목 없음.txt')
    await where.fill('notes.txt')
    await page.keyboard.press('Enter')
    await expect(editor.getByRole('alert')).toContainText('전체 경로')
    await where.fill('/nowhere/notes.txt')
    await page.keyboard.press('Enter')
    await expect(editor.getByRole('alert')).toHaveText('파일이나 폴더를 찾을 수 없습니다.')
    await where.fill('/tmp/notes.txt')
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)

    await typeIn(page, await pinWindow(page), 'cat /tmp/notes.txt')
    // 파일이 줄바꿈 없이 끝나면 셸이 % 표시를 붙이고 프롬프트를 다음 줄에 낸다.
    await expectScreen(page).toContain('cat /tmp/notes.txt\n첫 줄  들여쓰기%\nguest@webos')
  })

  test('refuses to edit binary files', async ({ page }) => {
    await launch(page, '파일')
    const files = appWindow(page, 'files')
    await files.getByRole('navigation', { name: '현재 위치' }).getByRole('button', { name: '/', exact: true }).click()
    await fileRow(page, 'bin').dblclick()
    await fileRow(page, 'ls').dblclick()
    const editor = appWindow(page, 'editor')
    await expect(editor).toContainText('텍스트 파일이 아니라서 편집할 수 없습니다')
    await expect(editor.getByRole('textbox')).toHaveCount(0)
    // 편집할 내용이 없으니 묻지 않고 닫힌다.
    await editor.getByRole('button', { name: '닫기' }).click()
    await expect(editor).toHaveCount(0)
  })
})

test.describe('settings', () => {
  test('theme and accent apply immediately and survive a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    const wall = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const accent = () => page.locator('.rail').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent'))
    const light = await wall()

    await launch(page, '설정')
    const settings = appWindow(page, 'settings')
    await settings.getByRole('button', { name: '어둡게' }).click()
    await expect(settings.getByRole('button', { name: '어둡게' })).toHaveAttribute('aria-pressed', 'true')
    expect(await wall()).not.toBe(light)
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')

    await settings.getByRole('button', { name: '장미' }).click()
    expect(await accent()).toContain('#ff8fb5')

    await page.reload()
    await expectScreen(page).toMatch(/\$$/)
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
    expect(await accent()).toContain('#ff8fb5')
    expect(await wall()).not.toBe(light)

    await launch(page, '설정')
    await appWindow(page, 'settings').getByRole('button', { name: '시스템' }).click()
    expect(await wall()).toBe(light)
  })
})
