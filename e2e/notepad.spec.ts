// 메모장: 창을 직접 그리는 WASM 프로세스. 트리, 탭, 단추는 프로세스가 그리고, 글을 치는 곳은 화면의 실제 입력 칸,
// 메뉴는 시스템의 메뉴다. 그림 속의 단추와 항목은 프로세스가 알려 준 자리(보이지 않는 요소)의 이름으로 찾는다.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const pad = (page: Page) => page.locator('.window[data-app="surface"]', { has: page.getByRole('application', { name: '메모장' }) })
const canvas = (page: Page) => pad(page).getByRole('application', { name: '메모장' })
const editor = (page: Page) => pad(page).getByRole('textbox', { name: '메모 내용' })

async function shell(page: Page, line: string, expected: string | RegExp) {
  await raise(page, '터미널')
  await typeIn(page, term(page), line)
  if (typeof expected === 'string') await expectScreen(page, term(page)).toContain(expected)
  else await expectScreen(page, term(page)).toMatch(expected)
}

type Role = 'button' | 'tab' | 'treeitem' | 'option' | 'link' | 'checkbox'
const spot = (page: Page, role: Role, name: string) => pad(page).getByRole(role, { name, exact: true })

/** 그림 속의 단추나 항목을 누른다. 그 자리의 요소는 누르는 것을 받지 않으므로(아래의 그림이 받는다) 좌표로 누른다. */
async function press(page: Page, role: Role, name: string, options: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}) {
  await expect(spot(page, role, name)).toBeVisible()
  // 창이 나타나는 움직임이 끝나고, 그 자리를 다른 것(닫히는 중인 실행 메뉴 등)이 가리지 않을 때까지 기다린다.
  const at = async () => {
    const box = (await spot(page, role, name).boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  let point = await at()
  await expect
    .poll(async () => {
      const before = point
      point = await at()
      const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('canvas.surface') ?? false, point)
      return onTop && before.x === point.x && before.y === point.y
    })
    .toBe(true)
  await page.mouse.click(point.x, point.y, options)
}

const title = (page: Page) => pad(page).getByRole('textbox', { name: '제목' })

/** 새 메모를 만들고 제목을 정한 뒤 본문에 커서를 둔다. */
async function newNote(page: Page, name: string) {
  await press(page, 'button', '새 메모')
  // 새 메모는 제목을 통째로 고른 채 커서를 받는다. 그대로 치면 제목이 바뀐다.
  await expect(title(page)).toBeFocused()
  await expect(title(page)).toHaveValue(/^제목 없음/)
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(editor(page)).toBeFocused()
  await expect(spot(page, 'tab', name)).toHaveAttribute('aria-selected', 'true')
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test('creates a note, names it, types into a real text field, and saves to a file', async ({ page }) => {
  await launch(page, '메모장')
  await expect(canvas(page)).toBeVisible()
  await expect(editor(page)).toHaveCount(0)
  await newNote(page, '첫 메모')
  await page.keyboard.type('첫 줄입니다')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second line')
  await expect(editor(page)).toHaveValue('첫 줄입니다\nsecond line')
  // 치는 동안 커서가 자리를 지킨다 (프로그램이 다시 그려도 칸을 새로 만들지 않는다).
  await page.keyboard.type('!')
  await expect(editor(page)).toHaveValue('첫 줄입니다\nsecond line!')
  await shell(page, 'cat "notes/첫 메모.md"', '첫 줄입니다\nsecond line!')
  await shell(page, 'ps', /\n\s*\d+\s.*notepad\n/)
})

test('the fields sit where the program put them and follow the window size', async ({ page }) => {
  await launch(page, '메모장')
  await newNote(page, '자리')
  const [frame, field] = [(await canvas(page).boundingBox())!, (await editor(page).boundingBox())!]
  expect({ x: field.x - frame.x, y: field.y - frame.y, w: field.width, h: field.height }).toEqual({ x: 264, y: 95, w: 622, h: 437 })
  await pad(page).getByRole('button', { name: '최대화' }).click()
  await expect.poll(async () => (await editor(page).boundingBox())!.width).toBe(1226 - 250 - 28)
  // 크기가 바뀌어도 쓰던 글과 커서는 그대로다.
  await page.keyboard.type('그대로')
  await expect(editor(page)).toHaveValue('그대로')
})

test('shows the vault as a tree and picks up outside changes when focused again', async ({ page }) => {
  await shell(page, 'mkdir -p notes/일; echo 우유 사기 > notes/장보기.md; echo 안건 > notes/일/회의.md', /\$$/)
  await launch(page, '메모장')
  await expect(pad(page).getByRole('treeitem')).toHaveCount(3)
  // 처음에는 첫 메모(경로순)가 열려 있다.
  await expect(spot(page, 'treeitem', '회의')).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toHaveValue('안건\n')
  await press(page, 'treeitem', '장보기')
  await expect(editor(page)).toHaveValue('우유 사기\n')
  await expect(pad(page).getByRole('tab')).toHaveCount(2)
  // 폴더를 누르면 접히고, 다시 누르면 펼쳐진다.
  await press(page, 'treeitem', '일')
  await expect(spot(page, 'treeitem', '회의')).toHaveCount(0)
  await press(page, 'treeitem', '일')
  await press(page, 'treeitem', '회의')
  await expect(editor(page)).toHaveValue('안건\n')
  await expect(editor(page)).toBeFocused()

  await shell(page, 'echo 터미널에서 고침 > notes/일/회의.md', /\$$/)
  await page.getByRole('button', { name: '창: 메모장' }).click()
  await expect(editor(page)).toHaveValue('터미널에서 고침\n')
  // 창이 앞으로 오면 쓰던 칸으로 커서가 돌아온다.
  await expect(editor(page)).toBeFocused()
})

test('Ctrl+S in the field saves at once instead of opening the browser dialog', async ({ page }) => {
  await launch(page, '메모장')
  await newNote(page, '저장')
  await page.keyboard.type('바로 저장')
  const prevented = await editor(page).evaluate((el) => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(prevented).toBe(true)
  // 복사·붙여넣기·되돌리기는 칸이 스스로 처리하도록 막지 않는다.
  for (const key of ['c', 'v', 'z', 'a']) {
    expect(await editor(page).evaluate((el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })), key)).toBe(true)
  }
  await shell(page, 'cat notes/저장.md', '바로 저장')
})

test('saves on close, and the window calls show in the trace', async ({ page }) => {
  await launch(page, '시스템 콜')
  await launch(page, '메모장')
  await newNote(page, '닫기')
  await page.keyboard.type('닫기 직전')
  await pad(page).getByRole('button', { name: '닫기', exact: true }).click()
  await expect(pad(page)).toHaveCount(0)
  const trace = appWindow(page, 'trace')
  await expect(trace).toContainText(/guimeasure\(\d+ bytes\)\s*= \d+ widths/)
  await expect(trace).toContainText(/guievent\((\d+ms)?\)\s*= input\(1, \d+, 0\)/)
  await expect(trace).toContainText('guitext(1, 0, 32768)')
  await shell(page, 'cat notes/닫기.md', '닫기 직전')
})

test('scrolls its tree with the wheel', async ({ page }) => {
  await shell(page, 'mkdir notes; cd notes; touch 01.md 02.md 03.md 04.md 05.md 06.md 07.md 08.md 09.md 10.md 11.md 12.md 13.md 14.md 15.md 16.md 17.md 18.md 19.md 20.md 21.md 22.md 23.md 24.md', /\$$/)
  await launch(page, '메모장')
  await expect(spot(page, 'treeitem', '01')).toBeVisible()
  await expect(spot(page, 'treeitem', '24')).toHaveCount(0)
  const box = (await canvas(page).boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 300)
  await page.mouse.wheel(0, 2000)
  await press(page, 'treeitem', '24')
  await expect(editor(page)).toBeFocused()
  await editor(page).fill('마지막 메모')
  await shell(page, 'cat 24.md', '마지막 메모')
})

test('its menus are the system menus', async ({ page }) => {
  await shell(page, 'mkdir -p notes/보관; echo 내용 > notes/가.md', /\$$/)
  await launch(page, '메모장')
  await press(page, 'treeitem', '가', { button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['열기', '옆에 열기', '이름 바꾸기', '다른 폴더로 옮기기…', '삭제…'])
  // 고르지 않고 닫으면 아무 일도 없다.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await press(page, 'treeitem', '가', { button: 'right' })
  await menu.getByRole('menuitem', { name: '다른 폴더로 옮기기…' }).click()
  await expect(menu.getByRole('menuitem')).toHaveText(['보관'])
  await menu.getByRole('menuitem', { name: '보관' }).click()
  await shell(page, 'cat notes/보관/가.md', '내용')
  await page.getByRole('button', { name: '창: 메모장' }).click()

  // 지우기는 한 번 더 묻는다.
  await press(page, 'treeitem', '가', { button: 'right' })
  await menu.getByRole('menuitem', { name: '삭제…' }).click()
  await press(page, 'button', '지우기')
  await expect(spot(page, 'treeitem', '가')).toHaveCount(0)
  await shell(page, 'ls notes/보관 | wc -l', /\n\s*0\n/)
})

test('renames a folder in place with a double click, and finds notes by text', async ({ page }) => {
  await shell(page, 'mkdir -p notes/일; echo 안건은 예산 > notes/일/회의.md; echo 우유 > notes/장보기.md', /\$$/)
  await launch(page, '메모장')
  await press(page, 'treeitem', '일', { clickCount: 2 })
  const name = pad(page).getByRole('textbox', { name: '폴더 이름' })
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('일')
  await page.keyboard.type('업무')
  await page.keyboard.press('Enter')
  await expect(spot(page, 'treeitem', '업무')).toBeVisible()
  await shell(page, 'cat notes/업무/회의.md', '안건은 예산')

  await pad(page).getByRole('textbox', { name: '메모 찾기' }).fill('예산')
  await expect(pad(page).getByRole('option')).toHaveCount(1)
  await press(page, 'option', '회의')
  await expect(editor(page)).toHaveValue('안건은 예산\n')
})

test('a screen reader can read and press what the program drew', async ({ page }) => {
  await shell(page, 'mkdir notes; echo A > notes/가.md; echo B > notes/나.md', /\$$/)
  await launch(page, '메모장')
  await expect(spot(page, 'treeitem', '가')).toHaveAttribute('aria-selected', 'true')
  await expect(spot(page, 'button', '뒤로')).toHaveAttribute('aria-disabled', 'true')
  // 화면 낭독기의 "누르기"는 그 자리의 요소에 click으로 온다. 프로그램에는 그 자리를 누른 것으로 전해진다.
  await spot(page, 'treeitem', '나').dispatchEvent('click')
  await expect(editor(page)).toHaveValue('B\n')
  await expect(spot(page, 'tab', '나')).toHaveAttribute('aria-selected', 'true')
  await expect(spot(page, 'button', '나 탭 닫기')).toBeVisible()
})

test('reads markdown beside the editor: links, checkboxes and the outline act on the real note', async ({ page }) => {
  await shell(page, 'mkdir notes; echo 안건 > notes/회의록.md', /\$$/)
  await launch(page, '메모장')
  await newNote(page, '계획')
  await editor(page).fill('# 처음\n\n[[회의록]] 참고\n\n- [ ] 우유\n\n## 나중\n\n끝')
  await press(page, 'button', '나란히')
  // 입력 칸은 왼쪽 절반으로 줄고, 오른쪽에 프로그램이 그린 글이 나온다.
  await expect.poll(async () => (await editor(page).boundingBox())!.width).toBe(325 - 28)
  await expect(spot(page, 'link', '회의록')).toBeVisible()

  // 체크를 누르면 원문이 바뀐다.
  await press(page, 'checkbox', '완료')
  await expect(editor(page)).toHaveValue('# 처음\n\n[[회의록]] 참고\n\n- [x] 우유\n\n## 나중\n\n끝')
  await expect(spot(page, 'checkbox', '완료')).toHaveAttribute('aria-checked', 'true')
  // 목차의 제목을 누르면 입력 칸의 커서가 그 줄로 간다.
  await press(page, 'button', '나중')
  await expect(editor(page)).toBeFocused()
  expect(await editor(page).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionStart + 5))).toBe('## 나중')

  // 링크를 누르면 그 메모가 열리고, 거기에는 돌아오는 길(백링크)이 있다.
  await press(page, 'link', '회의록')
  await expect(editor(page)).toHaveValue('안건\n')
  await press(page, 'button', '이 메모를 가리키는 메모 1개')
  await press(page, 'link', '계획')
  await expect(spot(page, 'tab', '계획')).toHaveAttribute('aria-selected', 'true')
  await shell(page, 'cat notes/계획.md', '- [x] 우유')
})

test('quick open floats above the text field and takes the keyboard', async ({ page }) => {
  await shell(page, 'mkdir -p notes/일; echo A > notes/장보기.md; echo B > notes/일/보고서.md; echo C > notes/회의록.md', /\$$/)
  await launch(page, '메모장')
  await press(page, 'treeitem', '회의록')
  await expect(editor(page)).toBeFocused()
  // 글을 치던 칸에서 Ctrl+O: 브라우저의 "파일 열기" 대신 빠른 열기가 뜬다.
  await page.keyboard.press('Control+o')
  const quick = pad(page).getByRole('textbox', { name: '열 메모의 이름' })
  await expect(quick).toBeFocused()
  // 창은 입력 칸 위에 그려진다: 본문 칸의 자리를 눌러도 그 칸이 아니라 위층이 받는다.
  const box = (await editor(page).boundingBox())!
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!.className, { x: box.x + 200, y: box.y + 300 })).toBe('surface surface-top')
  await page.keyboard.type('보')
  await expect(pad(page).getByRole('option')).toHaveCount(2)
  await page.keyboard.press('ArrowDown')
  await expect(spot(page, 'option', '장보기')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(quick).toHaveCount(0)
  await expect(editor(page)).toHaveValue('B\n')
  // 닫힌 뒤에는 다시 본문 칸을 바로 누를 수 있다.
  await editor(page).click()
  await page.keyboard.type('이어서')
  await expect(editor(page)).toHaveValue(/이어서/)
})

test('shows the graph of links, and moves notes by dragging them onto folders', async ({ page }) => {
  await shell(page, 'mkdir -p notes/보관; echo "[[회의록]]" > notes/계획.md; echo 안건 > notes/회의록.md', /\$$/)
  await launch(page, '메모장')
  await press(page, 'button', '그래프')
  await expect(spot(page, 'button', '계획, 링크 1개')).toBeVisible()
  await expect(editor(page)).toHaveCount(0)
  await press(page, 'button', '회의록, 링크 1개')
  await expect(editor(page)).toHaveValue('안건\n')

  // 트리의 메모를 폴더 위로 끌어다 놓는다.
  const from = (await spot(page, 'treeitem', '회의록').boundingBox())!
  const to = (await spot(page, 'treeitem', '보관').boundingBox())!
  await page.mouse.move(from.x + 40, from.y + 14)
  await page.mouse.down()
  await page.mouse.move(from.x + 50, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x + 40, to.y + 14, { steps: 5 })
  await page.mouse.up()
  await shell(page, 'cat notes/보관/회의록.md', '안건')
  await page.getByRole('button', { name: '창: 메모장' }).click()
  await expect(pad(page).getByRole('treeitem')).toHaveText(['', '', ''])
  await expect(spot(page, 'tab', '회의록')).toHaveAttribute('aria-selected', 'true')
})

test('helps with writing: continues lists, indents, wraps, and completes links', async ({ page }) => {
  await shell(page, 'mkdir notes; echo 안건 > notes/회의록.md', /\$$/)
  await launch(page, '메모장')
  await newNote(page, '글')
  const value = (text: string) => expect(editor(page)).toHaveValue(text)

  // 목록에서 Enter를 치면 다음 항목이 시작되고, 커서는 그 뒤에 있다.
  await page.keyboard.type('- 우유')
  await page.keyboard.press('Enter')
  await value('- 우유\n- ')
  await page.keyboard.type('빵')
  await value('- 우유\n- 빵')
  // Tab으로 들여 쓰고 Shift+Tab으로 내어 쓴다. 커서는 칸을 떠나지 않는다.
  await page.keyboard.press('Tab')
  await value('- 우유\n  - 빵')
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await value('- 우유\n- 빵')
  // 빈 항목에서 Enter를 치면 목록이 끝난다.
  await page.keyboard.press('Enter')
  await value('- 우유\n- 빵\n- ')
  await page.keyboard.press('Enter')
  await value('- 우유\n- 빵\n')

  // [[ 를 치면 링크할 메모를 고를 수 있고, Tab이나 Enter로 완성한다.
  await page.keyboard.type('[[회')
  await expect(spot(page, 'option', '회의록')).toBeVisible()
  // 목록은 커서 바로 아래에 뜬다: 커서가 있는 셋째 줄(줄 높이 20.8)의 아래.
  const [field, row] = [(await editor(page).boundingBox())!, (await spot(page, 'option', '회의록').boundingBox())!]
  expect(row.y - field.y).toBeGreaterThan(3 * 20.8)
  expect(row.y - field.y).toBeLessThan(3 * 20.8 + 14)
  expect(row.x - field.x).toBeGreaterThan(20)
  await page.keyboard.press('Enter')
  await value('- 우유\n- 빵\n[[회의록]]')
  await expect(spot(page, 'option', '회의록')).toHaveCount(0)
  await page.keyboard.type(' 참고')
  await value('- 우유\n- 빵\n[[회의록]] 참고')

  // 고른 글을 Ctrl+B로 굵게.
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Control+b')
  await value('- 우유\n- 빵\n[[회의록]] **참고**')
  expect(await editor(page).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('참고')

  // / 를 치면 넣을 것들이 뜨고, 이어서 친 글자로 거른 뒤 고른다.
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await expect(pad(page).getByRole('option')).toHaveCount(8)
  await page.keyboard.type('제목')
  await expect(pad(page).getByRole('option')).toHaveCount(3)
  await page.keyboard.press('ArrowDown')
  await expect(spot(page, 'option', '제목 2')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await value('- 우유\n- 빵\n[[회의록]] **참고**\n## ')
  // 목록이 닫힌 것을 보고 이어서 친다 (닫히기 전의 Enter는 아직 목록의 것이다).
  await expect(pad(page).getByRole('option')).toHaveCount(0)
  await page.keyboard.type('둘째')
  // 눌러서 고를 수도 있고, 그 뒤에도 커서는 칸에 남는다.
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await press(page, 'option', '인용')
  await value('- 우유\n- 빵\n[[회의록]] **참고**\n## 둘째\n> ')
  await expect(editor(page)).toBeFocused()
  await expect(pad(page).getByRole('option')).toHaveCount(0)
  await page.keyboard.type('말')
  // 보통의 줄에서는 Enter가 그냥 줄바꿈이다.
  await page.keyboard.press('Enter')
  await page.keyboard.type('끝')
  await value('- 우유\n- 빵\n[[회의록]] **참고**\n## 둘째\n> 말\n끝')
  await shell(page, 'cat notes/글.md', '[[회의록]] **참고**')

  // 텍스트(.txt) 메모에서는 Tab이 평소대로 다음 칸으로 넘어간다.
  await shell(page, 'echo "- a" > notes/그냥.txt', /\$$/)
  await page.getByRole('button', { name: '창: 메모장' }).click()
  await press(page, 'treeitem', '그냥')
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(editor(page)).not.toBeFocused()
  await expect(editor(page)).toHaveValue('- a\n')
})

test('the notes app sees what the notepad wrote', async ({ page }) => {
  await launch(page, '메모장')
  await newNote(page, '함께')
  await page.keyboard.type('# 두 앱이 같은 파일을 본다')
  await launch(page, '메모')
  const notes = appWindow(page, 'notes')
  await expect(notes.getByRole('tree', { name: '보관함' }).locator('.tree-name')).toHaveText(['함께'])
  await expect(notes.getByRole('textbox', { name: '메모 내용' })).toHaveValue('# 두 앱이 같은 파일을 본다')
})
