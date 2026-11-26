// 메모 보관함: 폴더, 제목이 곧 파일 이름인 메모, [[링크]]와 백링크, 그림.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const notes = (page: Page) => appWindow(page, 'notes')
const body = (page: Page) => notes(page).getByRole('textbox', { name: '메모 내용' })
const title = (page: Page) => notes(page).getByRole('textbox', { name: '제목' })
const tree = (page: Page) => notes(page).getByRole('tree', { name: '보관함' })
const preview = (page: Page) => notes(page).getByRole('document', { name: '미리보기' })
const status = (page: Page) => notes(page).locator('.statusbar')
const mode = (page: Page, name: string) => notes(page).getByRole('group', { name: '보기 방식' }).getByRole('button', { name })
/** 트리에 보이는 이름들 (위에서부터) */
const treeNames = (page: Page) => tree(page).locator('.tree-name').allTextContents()
const item = (page: Page, name: string) => tree(page).locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })

/** 1×1 크기의 PNG 그림 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 새 메모를 만들어 제목과 내용을 적는다. */
async function write(page: Page, name: string, text: string) {
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await expect(title(page)).toBeFocused()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(body(page)).toBeFocused()
  await expect(status(page)).toContainText(`${name}.`)
  await body(page).fill(text)
  await expect(status(page)).toContainText('저장됨')
}

/** 터미널에서 명령을 실행하고 그 출력에 원하는 글이 나오기를 기다린다. */
async function shell(page: Page, line: string, expected: string | RegExp) {
  await typeIn(page, term(page), line)
  if (typeof expected === 'string') await expectScreen(page, term(page)).toContain(expected)
  else await expectScreen(page, term(page)).toMatch(expected)
  await raise(page, '메모')
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
})

test('a new note starts with its title, which is its file name', async ({ page }) => {
  await launch(page, '메모')
  await expect(notes(page)).toContainText('아직 메모가 없습니다.')
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  // 제목 칸에 임시 이름이 선택된 채로 있어서, 바로 치면 제목이 된다.
  await expect(title(page)).toHaveValue('제목 없음')
  await expect(title(page)).toBeFocused()
  await page.keyboard.type('장보기')
  await page.keyboard.press('Enter')
  await expect(body(page)).toBeFocused()
  await page.keyboard.type('# 이번 주')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- 우유')
  await expect(status(page)).toContainText('notes/장보기.md · 저장됨')
  await expect(status(page)).toContainText('11자')
  await expect.poll(() => treeNames(page)).toEqual(['장보기'])

  await shell(page, 'ls notes; cat notes/장보기.md', 'cat notes/장보기.md\n장보기.md\n# 이번 주\n- 우유')
  // 제목을 고치면 파일 이름이 바뀐다.
  await title(page).fill('주간 장보기')
  await page.keyboard.press('Enter')
  await expect(status(page)).toContainText('notes/주간 장보기.md · 저장됨')
  await shell(page, 'ls notes', /ls notes\n주간 장보기\.md\n/)
})

test('a title that cannot be a file name is refused with the reason', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '하나', '첫 메모')
  await write(page, '둘', '둘째 메모')
  await title(page).fill('하나')
  await page.keyboard.press('Enter')
  await expect(notes(page).getByRole('alert')).toHaveText('같은 이름의 파일이 이미 있습니다.')
  await expect(title(page)).toHaveValue('둘')

  await title(page).fill('a/b')
  await page.keyboard.press('Enter')
  await expect(notes(page).getByRole('alert')).toContainText('/ 와 \\ 를 쓸 수 없습니다')
  await expect.poll(() => treeNames(page)).toEqual(['둘', '하나'])
})

test('edit, side-by-side and reading views', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '보기', '# 제목\n\n**굵게** 와 #태그\n\n| 이름 | 값 |\n|---|---|\n| 가 | 1 |')
  await expect(mode(page, '편집')).toHaveAttribute('aria-pressed', 'true')
  await expect(preview(page)).toHaveCount(0)

  await mode(page, '나란히').click()
  await expect(body(page)).toBeVisible()
  await expect(preview(page).getByRole('heading', { name: '제목' })).toBeVisible()
  // 왼쪽에서 고치면 오른쪽에 바로 반영된다.
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n\n새 문단')
  await expect(preview(page)).toContainText('새 문단')

  await mode(page, '읽기').click()
  await expect(body(page)).toHaveCount(0)
  await expect(preview(page).locator('strong')).toHaveText('굵게')
  await expect(preview(page).getByRole('table').getByRole('cell')).toHaveText(['가', '1'])
  await expect(preview(page).getByRole('button', { name: '#태그' })).toBeVisible()
})

test('checking a task in the reading view changes the note itself', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '할 일', '- [ ] 우유 사기\n- [x] 빨래\n- 그냥 항목')
  await mode(page, '읽기').click()
  const boxes = preview(page).getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).not.toBeChecked()
  await expect(boxes.nth(1)).toBeChecked()

  await boxes.nth(0).check()
  await expect(preview(page).locator('li.done')).toHaveText(['우유 사기', '빨래'])
  await expect(status(page)).toContainText('저장됨')
  await shell(page, 'cat "notes/할 일.md"', '- [x] 우유 사기\n- [x] 빨래\n- 그냥 항목')
})

test('[[links]] open notes, create missing ones, and show up as backlinks', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '회의록', '다음 주제는 [[예산]] 과 [[일정|일정표]] 이다.')
  await mode(page, '읽기').click()
  const budget = preview(page).getByRole('button', { name: '예산' })
  // 아직 없는 메모를 가리키는 링크는 다르게 보인다.
  await expect(budget).toHaveClass(/missing/)
  await expect(preview(page).getByRole('button', { name: '일정표' })).toBeVisible()

  // 누르면 그 이름의 메모가 만들어져 열린다.
  await budget.click()
  await expect(title(page)).toHaveValue('예산')
  await expect.poll(() => treeNames(page)).toEqual(['예산', '회의록'])
  await mode(page, '편집').click()
  await body(page).fill('올해 예산 정리')

  // 예산 메모에서는 자기를 가리키는 메모가 보인다.
  const backlinks = notes(page).locator('.backlinks')
  await expect(backlinks.locator('summary')).toHaveText('이 메모를 가리키는 메모 1개')
  await backlinks.locator('summary').click()
  await expect(backlinks.getByRole('listitem')).toContainText('다음 주제는 [[예산]]')
  await backlinks.getByRole('button', { name: '회의록' }).click()
  await expect(title(page)).toHaveValue('회의록')
  await mode(page, '읽기').click()
  await expect(preview(page).getByRole('button', { name: '예산' })).not.toHaveClass(/missing/)
})

test('renaming a note rewrites the links that point to it', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '예산', '올해 예산')
  await write(page, '회의록', '[[예산]] 과 [[예산|올해 돈]] 그리고 [[다른 것]]')
  await item(page, '예산').click()
  await title(page).fill('2026 예산')
  await page.keyboard.press('Enter')
  await expect(status(page)).toContainText('notes/2026 예산.md · 저장됨')
  await shell(page, 'cat notes/회의록.md', '[[2026 예산]] 과 [[2026 예산|올해 돈]] 그리고 [[다른 것]]')
  await item(page, '회의록').click()
  await expect(body(page)).toHaveValue('[[2026 예산]] 과 [[2026 예산|올해 돈]] 그리고 [[다른 것]]')
})

test('typing [[ suggests notes to link', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '회의록', '내용')
  await write(page, '회고', '내용')
  await write(page, '오늘', '')
  await body(page).focus()
  await page.keyboard.type('참고: [[회')
  const bar = notes(page).getByRole('listbox', { name: '링크할 메모' })
  await expect(bar.getByRole('option')).toHaveText(['회고', '회의록'])
  await page.keyboard.type('의')
  await expect(bar.getByRole('option')).toHaveText(['회의록'])
  await page.keyboard.press('Tab')
  await expect(body(page)).toHaveValue('참고: [[회의록]]')
  await expect(bar).toHaveCount(0)
  // 이어서 계속 칠 수 있다.
  await page.keyboard.type(' 끝')
  await expect(body(page)).toHaveValue('참고: [[회의록]] 끝')
})

test('a pasted image is saved in the vault and shown in the note', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '그림 메모', '위\n')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+End')
  // 화면을 찍어 붙여 넣는 상황: 클립보드에 그림 파일이 들어 있다.
  await body(page).evaluate((el, png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, PNG)
  await expect(body(page)).toHaveValue(/^위\n!\[\[붙여넣은 그림 \d{8}-\d{6}\.png\]\]$/)
  await expect(status(page)).toContainText('저장됨')

  await mode(page, '읽기').click()
  const image = preview(page).locator('img')
  await expect(image).toBeVisible()
  // 실제로 그림으로 읽혔다 (깨진 그림이 아니다).
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

  await shell(page, 'ls notes/attachments | wc -l; ls notes', /wc -l; ls notes\n1\nattachments {2}그림 메모\.md\n/)
})

test('images can be added with the button, dropped, and viewed from the tree', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '도면', '')
  const png = Buffer.from(PNG, 'base64')
  await notes(page).getByLabel('넣을 그림').setInputFiles([
    { name: '구조도.png', mimeType: 'image/png', buffer: png },
    { name: '구조도.png', mimeType: 'image/png', buffer: png },
  ])
  // 같은 이름이 겹치면 번호를 붙여 따로 저장한다.
  await expect(body(page)).toHaveValue('![[구조도.png]]\n![[구조도 2.png]]')

  await body(page).evaluate((el, png) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], '끌어온 그림.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  }, PNG)
  await expect(body(page)).toHaveValue(/!\[\[끌어온 그림\.png\]\]/)

  // 그림이 아닌 파일은 받지 않는다.
  await body(page).evaluate((el) => {
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'notes.pdf', { type: 'application/pdf' }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(notes(page).getByRole('alert')).toHaveText('그림 파일만 넣을 수 있습니다.')

  // 그림 폴더를 펼쳐 그림을 고르면 크게 볼 수 있다.
  await item(page, 'attachments').click()
  await expect.poll(() => treeNames(page)).toEqual(['attachments', '구조도 2.png', '구조도.png', '끌어온 그림.png', '도면'])
  await item(page, '구조도.png').click()
  await expect(notes(page).locator('.note-image img')).toBeVisible()
  await expect(notes(page)).toContainText('![[구조도.png]]')
  await expect(status(page)).toContainText('notes/attachments/구조도.png')
})

test('standard Markdown image syntax works for files in the vault too', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '표준', '')
  await notes(page).getByLabel('넣을 그림').setInputFiles({ name: 'a b.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') })
  await expect(body(page)).toHaveValue('![[a b.png]]')
  await body(page).fill('![설명](attachments/a%20b.png)\n\n![없음](attachments/none.png)')
  await mode(page, '읽기').click()
  await expect(preview(page).getByRole('img', { name: '설명' })).toBeVisible()
  await expect(preview(page)).toContainText('그림을 찾을 수 없음: attachments/none.png')
})

test('folders organize notes, and new notes go into the selected folder', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '바깥', '루트의 메모')
  await tree(page).click({ position: { x: 5, y: 300 } })
  await notes(page).getByRole('button', { name: '새 폴더' }).click()
  const rename = notes(page).getByRole('textbox', { name: '폴더 이름' })
  await expect(rename).toHaveValue('새 폴더')
  await expect(rename).toBeFocused()
  await page.keyboard.type('프로젝트')
  await page.keyboard.press('Enter')
  await expect.poll(() => treeNames(page)).toEqual(['프로젝트', '바깥'])

  await item(page, '프로젝트').click()
  await write(page, '계획', '폴더 안의 메모 [[바깥]]')
  await expect(status(page)).toContainText('notes/프로젝트/계획.md')
  await expect.poll(() => treeNames(page)).toEqual(['프로젝트', '계획', '바깥'])
  await shell(page, 'ls notes notes/프로젝트', 'notes:\n바깥.md  프로젝트\n\nnotes/프로젝트:\n계획.md\n')

  // 폴더를 접었다 펼 수 있고, 다른 폴더의 메모도 이름만으로 링크된다.
  await item(page, '프로젝트').click()
  await expect.poll(() => treeNames(page)).toEqual(['프로젝트', '바깥'])
  await item(page, '프로젝트').click()
  await item(page, '바깥').click()
  await expect(notes(page).locator('.backlinks summary')).toHaveText('이 메모를 가리키는 메모 1개')

  // 폴더 이름을 바꾸면 안의 메모도 따라간다.
  await item(page, '프로젝트').dblclick()
  await rename.fill('작업')
  await page.keyboard.press('Enter')
  await expect.poll(() => treeNames(page)).toEqual(['작업', '계획', '바깥'])
  await shell(page, 'cat notes/작업/계획.md', '폴더 안의 메모 [[바깥]]')

  await item(page, '작업').click()
  await notes(page).getByRole('button', { name: '작업 폴더 지우기' }).click()
  const confirm = notes(page).getByRole('alertdialog', { name: '지우기 확인' })
  await expect(confirm).toContainText('“작업” 폴더와 그 안의 모든 것을 지울까요?')
  await confirm.getByRole('button', { name: '지우기' }).click()
  await expect.poll(() => treeNames(page)).toEqual(['바깥'])
})

test('finds notes by content, by name, and by clicking a tag', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '사과 파이', '레시피 #요리')
  await write(page, '운동', '달리기 30분 #건강')
  await write(page, '장보기', '사과, 우유 #요리')
  const search = notes(page).getByRole('searchbox', { name: '메모 찾기' })
  const hits = notes(page).getByRole('listbox', { name: '찾은 메모' }).getByRole('option')

  await search.fill('사과')
  await expect(hits.locator('.notes-title')).toHaveText(['사과 파이', '장보기'])
  await hits.nth(1).click()
  await expect(title(page)).toHaveValue('장보기')
  await search.fill('없는 말')
  await expect(notes(page)).toContainText('찾는 내용이 든 메모가 없습니다.')

  // 읽기 화면의 태그를 누르면 같은 태그가 든 메모를 찾는다.
  await search.fill('')
  await mode(page, '읽기').click()
  await preview(page).getByRole('button', { name: '#요리' }).click()
  await expect(search).toHaveValue('#요리')
  await expect(hits.locator('.notes-title')).toHaveText(['사과 파이', '장보기'])
})

test('notes can be plain text instead of Markdown', async ({ page }) => {
  await launch(page, '메모')
  await notes(page).getByLabel('새 메모의 형식').selectOption({ label: '텍스트 (.txt)' })
  await write(page, '그냥 글', '# 제목이 아니라 그냥 글')
  await expect(status(page)).toContainText('notes/그냥 글.txt · 저장됨')
  // 일반 텍스트는 색을 입히지 않고, 보기 방식도 없다.
  await expect(notes(page).locator('.code-layer span')).toHaveCount(0)
  await expect(notes(page).getByRole('group', { name: '보기 방식' })).toHaveCount(0)
  await expect(item(page, '그냥 글')).toContainText('txt')
})

test('deleting a note asks first and removes the file', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '지울 메모', '내용')
  await notes(page).getByRole('button', { name: '삭제' }).click()
  const confirm = notes(page).getByRole('alertdialog', { name: '지우기 확인' })
  await expect(confirm).toContainText('“지울 메모.md” 메모를 지울까요?')
  await confirm.getByRole('button', { name: '취소' }).click()
  await expect.poll(() => treeNames(page)).toEqual(['지울 메모'])

  await notes(page).getByRole('button', { name: '삭제' }).click()
  await confirm.getByRole('button', { name: '지우기' }).click()
  await expect(notes(page)).toContainText('아직 메모가 없습니다.')
  await shell(page, 'ls notes | wc -l', 'wc -l\n0\n')
})

test('notes written by the old version are renamed to their titles', async ({ page }) => {
  // 예전 메모 앱은 만든 시각을 파일 이름으로 썼다.
  await typeIn(page, term(page), 'mkdir notes; echo "# 옛 메모" > notes/20261125-181026.md; echo 같은 제목 > notes/20261125-181027.md; echo 같은 제목 > notes/20261125-181028.md')
  await expectScreen(page, term(page)).toMatch(/181028\.md\nguest@webos:~\$$/)
  await launch(page, '메모')
  await expect.poll(() => treeNames(page)).toEqual(['같은 제목', '같은 제목 2', '옛 메모'])
  await item(page, '옛 메모').click()
  await expect(body(page)).toHaveValue('# 옛 메모\n')
  await shell(page, 'ls notes', 'ls notes\n같은 제목 2.md  같은 제목.md  옛 메모.md\n')
})

test('survives a reload, including text typed just before closing the window', async ({ page }) => {
  await launch(page, '메모')
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await page.keyboard.type('급한 메모')
  await page.keyboard.press('Enter')
  await page.keyboard.type('닫기 직전에 친 글')
  // 자동 저장을 기다리지 않고 바로 창을 닫는다.
  await notes(page).getByRole('button', { name: '닫기', exact: true }).click()
  await page.waitForTimeout(700)
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await launch(page, '메모')
  await expect.poll(() => treeNames(page)).toEqual(['급한 메모'])
  await expect(body(page)).toHaveValue('닫기 직전에 친 글')
})

test('picks up changes made in the terminal without losing what is being typed', async ({ page }) => {
  await launch(page, '메모')
  await write(page, '앱에서', '앱에서 쓴 메모')
  await typeIn(page, term(page), 'echo "터미널에서 쓴 메모" > notes/터미널에서.md')
  await expect.poll(() => treeNames(page)).toEqual(['앱에서', '터미널에서'])

  // 치는 도중에 다른 메모 파일이 바뀌어도, 지금 치는 내용은 그대로다.
  await raise(page, '메모')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' 그리고 더')
  await typeIn(page, term(page), 'echo 또 > notes/또.md')
  await expect.poll(() => treeNames(page)).toEqual(['또', '앱에서', '터미널에서'])
  await expect(body(page)).toHaveValue('앱에서 쓴 메모 그리고 더')
  await expect(status(page)).toContainText('저장됨')
  await shell(page, 'cat notes/앱에서.md', 'cat notes/앱에서.md\n앱에서 쓴 메모 그리고 더')
})
