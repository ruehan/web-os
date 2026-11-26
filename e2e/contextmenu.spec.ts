// 우클릭 메뉴.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, box, expectScreen, fileRow, launch, typeIn } from './helpers.ts'

const menu = (page: Page) => page.getByRole('menu')
const items = (page: Page) => menu(page).getByRole('menuitem')
const pick = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true }).click()
const term = (page: Page) => appWindow(page, 'terminal')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test('the desktop background offers shortcuts to open things', async ({ page }) => {
  await page.mouse.click(1200, 700, { button: 'right' })
  await expect(items(page)).toHaveText(['새 터미널', '파일 열기', '메모 열기', '모든 앱…', '설정'])
  // 누른 자리에 뜬다.
  const panel = await box(menu(page))
  expect(panel.x).toBeLessThanOrEqual(1200)
  expect(panel.x + panel.w).toBeLessThanOrEqual(1280)

  await pick(page, '파일 열기')
  await expect(menu(page)).toHaveCount(0)
  await expect(appWindow(page, 'files')).toHaveClass(/focused/)

  await page.mouse.click(1200, 700, { button: 'right' })
  await pick(page, '모든 앱…')
  await expect(page.getByRole('dialog', { name: '앱', exact: true })).toBeVisible()
})

test('stays inside the screen when opened near an edge', async ({ page }) => {
  await page.mouse.click(1276, 796, { button: 'right' })
  const panel = await box(menu(page))
  expect(panel.x + panel.w).toBeLessThanOrEqual(1280)
  expect(panel.y + panel.h).toBeLessThanOrEqual(800)
})

test('closes on Escape, on a click elsewhere, and when another menu opens', async ({ page }) => {
  await page.mouse.click(1200, 700, { button: 'right' })
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  await page.mouse.click(1200, 700, { button: 'right' })
  await page.mouse.click(1100, 300)
  await expect(menu(page)).toHaveCount(0)

  await page.mouse.click(1200, 700, { button: 'right' })
  await term(page).locator('.titlebar').click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await expect(items(page).first()).toHaveText('최소화')
})

test('can be used with the keyboard', async ({ page }) => {
  await page.mouse.click(1200, 700, { button: 'right' })
  await expect(items(page).first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(items(page).nth(2)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await expect(items(page).last()).toBeFocused()
  // 끝에서 아래로 가면 처음으로 돌아온다.
  await page.keyboard.press('ArrowDown')
  await expect(items(page).first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(appWindow(page, 'terminal')).toHaveCount(2)
})

test('a window title bar: minimize, maximize, snap, close', async ({ page }) => {
  const win = term(page)
  const before = await box(win)
  const titlebar = win.locator('.titlebar')
  await titlebar.click({ button: 'right', position: { x: 200, y: 18 } })
  await expect(items(page)).toHaveText(['최소화', '최대화', '왼쪽 절반에 붙이기', '오른쪽 절반에 붙이기', '닫기'])
  await pick(page, '왼쪽 절반에 붙이기')
  expect(await box(win)).toEqual({ x: 52 + 8, y: 8, w: (1280 - 52 - 24) / 2, h: 784 })

  await titlebar.click({ button: 'right', position: { x: 200, y: 18 } })
  await expect(menu(page).getByRole('menuitem', { name: '왼쪽 절반에 붙이기' })).toBeDisabled()
  await pick(page, '최대화')
  expect(await box(win)).toEqual({ x: 52, y: 0, w: 1228, h: 800 })

  await titlebar.click({ button: 'right', position: { x: 200, y: 18 } })
  await pick(page, '원래 크기로')
  expect(await box(win)).toEqual(before)
  // 우클릭으로는 창이 끌리지 않는다.
  await titlebar.click({ button: 'right', position: { x: 200, y: 18 } })
  await pick(page, '닫기')
  await expect(win).toHaveCount(0)
})

test('the rail: pinned apps and open windows', async ({ page }) => {
  await page.getByRole('button', { name: '메모', exact: true }).click({ button: 'right' })
  await expect(items(page)).toHaveText(['메모 열기', '막대에서 떼기'])
  await pick(page, '막대에서 떼기')
  await expect(page.locator('.rail-button.pinned')).toHaveCount(2)

  const tab = page.getByRole('button', { name: '창: 터미널' })
  await tab.click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem', { name: '앞으로 가져오기' })).toBeDisabled()
  await pick(page, '최소화')
  await expect(term(page)).toBeHidden()
  await tab.click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem', { name: '최소화' })).toBeDisabled()
  await pick(page, '앞으로 가져오기')
  await expect(term(page)).toBeVisible()
  await tab.click({ button: 'right' })
  await pick(page, '닫기')
  await expect(term(page)).toHaveCount(0)
})

test('the app menu: open or pin from a right-click', async ({ page }) => {
  await page.getByRole('button', { name: '앱', exact: true }).click()
  const launcher = page.getByRole('dialog', { name: '앱', exact: true })
  await launcher.getByRole('button', { name: '설정', exact: true }).click({ button: 'right' })
  await expect(items(page)).toHaveText(['열기', '막대에 고정'])
  await pick(page, '막대에 고정')
  await expect(page.locator('.rail-button.pinned')).toHaveCount(4)
  // 고정만 바꿨으므로 앱 메뉴는 그대로 열려 있다.
  await expect(launcher).toBeVisible()
  await launcher.getByRole('button', { name: '설정', exact: true }).click({ button: 'right' })
  await expect(items(page)).toHaveText(['열기', '막대에서 떼기'])
  await pick(page, '열기')
  await expect(appWindow(page, 'settings')).toHaveClass(/focused/)
})

test('files: act on an item, or create in the empty area', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await launch(page, '파일')
  const files = appWindow(page, 'files')
  await fileRow(page, 'hello.sh').click({ button: 'right' })
  // 우클릭한 항목이 선택된다.
  await expect(fileRow(page, 'hello.sh')).toHaveAttribute('aria-selected', 'true')
  await expect(items(page)).toHaveText(['편집기로 열기', '이름 바꾸기', '경로 복사', '삭제…'])
  await pick(page, '경로 복사')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/home/guest/hello.sh')

  await fileRow(page, 'hello.sh').click({ button: 'right' })
  await pick(page, '이름 바꾸기')
  const rename = files.getByRole('textbox', { name: '새 이름' })
  await expect(rename).toBeFocused()
  await page.keyboard.type('greet')
  await page.keyboard.press('Enter')
  await expect(fileRow(page, 'greet.sh')).toBeVisible()

  await fileRow(page, 'README.md').click({ button: 'right' })
  await pick(page, '삭제…')
  // 메뉴에서 골라도 바로 지우지 않고 한 번 더 묻는다.
  await expect(files.locator('.statusbar')).toContainText('“README.md”을(를) 지울까요?')
  await files.getByRole('button', { name: '지우기' }).click()
  await expect(fileRow(page, 'README.md')).toHaveCount(0)

  // 빈 곳에서는 만들기 메뉴가 나온다.
  const list = await box(files.getByRole('listbox', { name: '파일 목록' }))
  await page.mouse.click(list.x + list.w / 2, list.y + list.h - 20, { button: 'right' })
  await expect(items(page)).toContainText(['새 폴더', '새 텍스트 파일 (.txt)', '새 마크다운 파일 (.md)'])
  await pick(page, '새 마크다운 파일 (.md)')
  await expect(rename).toHaveValue('새 파일.md')
})

test('notes: act on a note or folder, or create in the empty area', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await launch(page, '메모')
  const notes = appWindow(page, 'notes')
  const tree = notes.getByRole('tree', { name: '보관함' })
  const row = (name: string) => tree.locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
  const names = () => tree.locator('.tree-name').allTextContents()

  const area = await box(tree)
  await page.mouse.click(area.x + area.w / 2, area.y + area.h - 20, { button: 'right' })
  await expect(items(page)).toHaveText(['새 메모', '새 폴더'])
  await pick(page, '새 폴더')
  await expect(notes.getByRole('textbox', { name: '폴더 이름' })).toBeFocused()
  await page.keyboard.type('프로젝트')
  await page.keyboard.press('Enter')
  await expect.poll(names).toEqual(['프로젝트'])

  await row('프로젝트').click({ button: 'right' })
  await expect(items(page)).toHaveText(['여기에 새 메모', '여기에 새 폴더', '이름 바꾸기', '다른 폴더로 옮기기…', '삭제…'])
  await pick(page, '여기에 새 메모')
  await expect(notes.getByRole('textbox', { name: '제목' })).toBeFocused()
  await page.keyboard.type('계획')
  await page.keyboard.press('Enter')
  await expect(notes.locator('.statusbar')).toContainText('notes/프로젝트/계획.md · 저장됨')

  await row('계획').click({ button: 'right' })
  await expect(items(page)).toHaveText(['열기', '옆에 열기', '이름 바꾸기', '링크 복사', '다른 폴더로 옮기기…', '삭제…'])
  await pick(page, '링크 복사')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('[[계획]]')

  await row('계획').click({ button: 'right' })
  await pick(page, '이름 바꾸기')
  await expect(notes.getByRole('textbox', { name: '제목' })).toBeFocused()
  await page.keyboard.type('로드맵')
  await page.keyboard.press('Enter')
  await expect.poll(names).toEqual(['프로젝트', '로드맵'])

  await row('로드맵').click({ button: 'right' })
  await pick(page, '삭제…')
  await notes.getByRole('alertdialog', { name: '지우기 확인' }).getByRole('button', { name: '지우기' }).click()
  await expect.poll(names).toEqual(['프로젝트'])
})

test('terminal: copy the selection and paste', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await typeIn(page, term(page), 'echo copy-me')
  await expectScreen(page, term(page)).toContain('\ncopy-me\n')

  // 아무것도 고르지 않았으면 복사할 것이 없다.
  await term(page).locator('.terminal').click({ button: 'right', position: { x: 300, y: 300 } })
  await expect(items(page)).toHaveText(['복사', '붙여넣기', '모두 선택'])
  await expect(menu(page).getByRole('menuitem', { name: '복사' })).toBeDisabled()
  await pick(page, '모두 선택')

  await term(page).locator('.terminal').click({ button: 'right', position: { x: 300, y: 300 } })
  await pick(page, '복사')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('$ echo copy-me\ncopy-me\n')

  await page.evaluate(() => navigator.clipboard.writeText('echo pasted-text'))
  await term(page).locator('.terminal').click({ button: 'right', position: { x: 300, y: 300 } })
  await pick(page, '붙여넣기')
  await expectScreen(page, term(page)).toMatch(/\$ echo pasted-text$/)
  // 붙여 넣은 뒤 터미널이 바로 입력을 받는다.
  await page.keyboard.press('Enter')
  await expectScreen(page, term(page)).toContain('\npasted-text\n')
})

test('processes: end one from its row', async ({ page }) => {
  await typeIn(page, term(page), 'spin')
  await expectScreen(page, term(page)).toContain('spinning... 0s')
  await launch(page, '프로세스')
  await page.locator('.proc', { hasText: 'spin' }).click({ button: 'right' })
  await expect(items(page)).toHaveText([/^\d+번 프로세스 종료$/])
  await items(page).first().click()
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')
})

test('text fields keep the browser\'s own menu', async ({ page }) => {
  await launch(page, '메모')
  const notes = appWindow(page, 'notes')
  await notes.getByRole('button', { name: '새 메모' }).click()
  // 우리 메뉴가 뜨지 않고, 브라우저의 기본 동작도 막지 않는다.
  for (const field of [notes.getByRole('textbox', { name: '제목' }), notes.getByRole('textbox', { name: '메모 내용' }), notes.getByRole('searchbox', { name: '메모 찾기' })]) {
    const prevented = await field.evaluate((el) => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
    expect(prevented).toBe(false)
  }
  await expect(menu(page)).toHaveCount(0)
})
