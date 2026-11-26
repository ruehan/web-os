// 메모 앱의 작업 공간: 탭과 뒤로·앞으로, 옮기기, 빠른 열기, 목차와 태그, 그래프, 참고 메모, 목록 이어 쓰기.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const notes = (page: Page) => appWindow(page, 'notes')
const body = (page: Page) => notes(page).getByRole('textbox', { name: '메모 내용' })
const title = (page: Page) => notes(page).getByRole('textbox', { name: '제목' })
const tree = (page: Page) => notes(page).getByRole('tree', { name: '보관함' })
const status = (page: Page) => notes(page).locator('.statusbar')
const mode = (page: Page, name: string) => notes(page).getByRole('group', { name: '보기 방식' }).getByRole('button', { name })
const item = (page: Page, name: string) => tree(page).locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
const tabs = (page: Page) => notes(page).getByRole('tablist', { name: '열어 둔 메모' }).getByRole('tab')
const tabNames = (page: Page) => notes(page).locator('.tab-name').allTextContents()
const main = (page: Page) => notes(page).locator('.note-body > .preview')
const menu = (page: Page, name: string) => page.getByRole('menu').getByRole('menuitem', { name, exact: true })

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

async function shell(page: Page, line: string, expected: string) {
  await typeIn(page, term(page), line)
  await expectScreen(page, term(page)).toContain(expected)
  await raise(page, '메모')
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
  await launch(page, '메모')
})

test('each opened note gets a tab; tabs switch and close', async ({ page }) => {
  await write(page, '하나', '첫째')
  await write(page, '둘', '둘째')
  await write(page, '셋', '셋째')
  await expect.poll(() => tabNames(page)).toEqual(['하나', '둘', '셋'])
  await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'true')

  await tabs(page).nth(0).click()
  await expect(body(page)).toHaveValue('첫째')
  // 이미 탭이 있는 메모를 열면 탭이 늘지 않는다.
  await item(page, '둘').click()
  await expect(tabs(page)).toHaveCount(3)
  await expect(body(page)).toHaveValue('둘째')

  // 보고 있는 탭을 닫으면 오른쪽 탭으로 간다.
  await notes(page).getByRole('button', { name: '둘 탭 닫기' }).click()
  await expect.poll(() => tabNames(page)).toEqual(['하나', '셋'])
  await expect(body(page)).toHaveValue('셋째')
  // 탭을 닫아도 메모는 그대로 있다.
  await expect(item(page, '둘')).toBeVisible()

  await tabs(page).nth(1).click({ button: 'right' })
  await menu(page, '탭 닫기').click()
  await expect(body(page)).toHaveValue('첫째')
  await notes(page).getByRole('button', { name: '하나 탭 닫기' }).click()
  await expect(tabs(page)).toHaveCount(0)
  await expect(notes(page)).toContainText('“새 메모”를 눌러 적기 시작하세요.')
  // 모두 닫은 뒤에는 파일이 바뀌어도 알아서 다시 열지 않는다.
  await shell(page, 'touch notes/넷.md', '$ touch notes/넷.md\n')
  await expect(item(page, '넷')).toBeVisible()
  await expect(tabs(page)).toHaveCount(0)
})

test('back and forward retrace the notes visited', async ({ page }) => {
  await write(page, '가', 'A')
  await write(page, '나', '[[가]] 로 간다')
  await write(page, '다', 'C')
  const back = notes(page).getByRole('button', { name: '뒤로' })
  const forward = notes(page).getByRole('button', { name: '앞으로' })
  await expect(forward).toBeDisabled()
  await back.click()
  await expect(title(page)).toHaveValue('나')
  await back.click()
  await expect(title(page)).toHaveValue('가')
  await expect(back).toBeDisabled()
  await forward.click()
  await expect(title(page)).toHaveValue('나')
  // 중간에서 다른 곳으로 가면 그 앞의 길은 사라진다.
  await mode(page, '읽기').click()
  await main(page).getByRole('button', { name: '가', exact: true }).click()
  await expect(title(page)).toHaveValue('가')
  await expect(forward).toBeDisabled()
  await back.click()
  await expect(title(page)).toHaveValue('나')
})

test('renaming a note keeps its tab and its place in the history', async ({ page }) => {
  await write(page, '옛 이름', '내용')
  await write(page, '다른 메모', '')
  await tabs(page).nth(0).click()
  await title(page).fill('새 이름')
  await title(page).press('Enter')
  await expect(status(page)).toContainText('notes/새 이름.md · 저장됨')
  await expect.poll(() => tabNames(page)).toEqual(['새 이름', '다른 메모'])
  await notes(page).getByRole('button', { name: '뒤로' }).click()
  await expect(title(page)).toHaveValue('다른 메모')
  await notes(page).getByRole('button', { name: '뒤로' }).click()
  await expect(title(page)).toHaveValue('새 이름')
})

test('notes and folders move by dragging, and from the menu', async ({ page }) => {
  await notes(page).getByRole('button', { name: '새 폴더' }).click()
  await expect(notes(page).getByRole('textbox', { name: '폴더 이름' })).toBeFocused()
  await page.keyboard.type('프로젝트')
  await page.keyboard.press('Enter')
  await tree(page).click({ position: { x: 100, y: 400 } })
  await write(page, '계획', '할 일')
  await write(page, '색인', '[[계획]] 과 [[프로젝트/계획]]')
  await expect(status(page)).toContainText('notes/색인.md')

  await item(page, '계획').dragTo(item(page, '프로젝트'))
  await shell(page, 'ls notes/프로젝트', '\n계획.md\n')
  // 열어 둔 탭이 옮겨진 메모를 따라간다.
  await tabs(page).nth(0).click()
  await expect(status(page)).toContainText('notes/프로젝트/계획.md')
  await expect(body(page)).toHaveValue('할 일')
  // 이름만 적은 링크는 여전히 통한다.
  await tabs(page).nth(1).click()
  await mode(page, '읽기').click()
  await expect(main(page).locator('.md-wikilink.missing')).toHaveCount(0)

  // 메뉴로 다시 맨 위로 옮긴다. 폴더까지 적은 링크는 새 자리로 고쳐진다.
  await item(page, '계획').click({ button: 'right' })
  await menu(page, '다른 폴더로 옮기기…').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['보관함 맨 위'])
  await menu(page, '보관함 맨 위').click()
  await shell(page, 'ls notes/프로젝트 | wc -l', '\n0\n')
  await shell(page, 'cat notes/색인.md', '[[계획]] 과 [[계획]]')

  // 폴더째로 옮긴다.
  await item(page, '계획').dragTo(item(page, '프로젝트'))
  await tree(page).click({ position: { x: 100, y: 400 } })
  await notes(page).getByRole('button', { name: '새 폴더' }).click()
  await expect(notes(page).getByRole('textbox', { name: '폴더 이름' })).toBeFocused()
  await page.keyboard.type('보관')
  await page.keyboard.press('Enter')
  await item(page, '프로젝트').dragTo(item(page, '보관'))
  await shell(page, 'cat notes/보관/프로젝트/계획.md', '할 일')
  // 폴더를 자기 안으로는 옮길 수 없다.
  await item(page, '보관').click({ button: 'right' })
  await menu(page, '다른 폴더로 옮기기…').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['옮길 수 있는 폴더가 없습니다'])
})

test('quick open finds a note by a few letters, and lists recent notes first', async ({ page }) => {
  await write(page, '회의록 11월', 'A')
  await write(page, '예산안', 'B')
  await write(page, '회고', 'C')
  await tabs(page).nth(0).click()

  await page.keyboard.press('ControlOrMeta+o')
  const dialog = notes(page).getByRole('dialog', { name: '빠른 열기' })
  const input = dialog.getByRole('searchbox', { name: '열 메모의 이름' })
  await expect(input).toBeFocused()
  // 아무것도 치지 않으면 최근에 연 순서다.
  await expect(dialog.getByRole('listbox', { name: '최근에 연 메모' }).locator('.notes-title')).toHaveText(['회의록 11월', '회고', '예산안'])

  await page.keyboard.type('회')
  await expect(dialog.getByRole('option').locator('.notes-title')).toHaveText(['회고', '회의록 11월'])
  // 떨어진 글자로도 찾는다.
  await input.fill('회11')
  await expect(dialog.getByRole('option').locator('.notes-title')).toHaveText(['회의록 11월'])
  await input.fill('없는 이름')
  await expect(dialog).toContainText('그런 이름의 메모가 없습니다.')

  await input.fill('예')
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(title(page)).toHaveValue('예산안')
  await expect(body(page)).toBeFocused()

  await notes(page).getByRole('button', { name: '빠른 열기' }).click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveValue('회의록 11월')
  await page.keyboard.press('ControlOrMeta+o')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('the outline lists headings and jumps to them', async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `줄 ${i}`).join('\n\n')
  await write(page, '긴 글', `# 처음\n\n${filler}\n\n## 가운데\n\n${filler}\n\n## 끝\n\n마지막 문단`)
  const outline = notes(page).getByRole('list', { name: '목차' })
  await expect(outline.getByRole('button')).toHaveText(['처음', '가운데', '끝'])

  await outline.getByRole('button', { name: '끝' }).click()
  await expect(body(page)).toBeFocused()
  const caret = await body(page).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionStart + 4))
  expect(caret).toBe('## 끝')
  expect(await body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000)

  await mode(page, '읽기').click()
  await outline.getByRole('button', { name: '가운데' }).click()
  await expect(main(page).getByRole('heading', { name: '가운데' })).toBeInViewport()
  await expect(main(page).getByRole('heading', { name: '처음' })).not.toBeInViewport()
})

test('tags are collected in the sidebar and filter the notes', async ({ page }) => {
  await write(page, '하나', '#할일 #집')
  await write(page, '둘', '#할일')
  await write(page, '셋', '태그 없음')
  await notes(page).locator('summary', { hasText: '태그 2개' }).click()
  const tags = notes(page).getByRole('list', { name: '태그' })
  await expect(tags.getByRole('button')).toHaveText(['#할일 2', '#집 1'])
  await tags.getByRole('button', { name: '#집' }).click()
  await expect(notes(page).getByRole('listbox', { name: '찾은 메모' }).locator('.notes-title')).toHaveText(['하나'])
  // 한 번 더 누르면 풀린다.
  await tags.getByRole('button', { name: '#집' }).click()
  await expect(tree(page)).toBeVisible()
})

test('lists continue on Enter and indent with Tab', async ({ page }) => {
  await write(page, '목록', '')
  await page.keyboard.type('- 과일')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('사과')
  await page.keyboard.press('Enter')
  await page.keyboard.type('배')
  await page.keyboard.press('Enter')
  // 빈 항목에서 Enter: 한 단계 밖으로, 한 번 더: 목록 끝.
  await page.keyboard.press('Enter')
  await page.keyboard.type('채소')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('1. [ ] 장보기')
  await page.keyboard.press('Enter')
  await page.keyboard.type('요리')
  await expect(body(page)).toHaveValue('- 과일\n  - 사과\n  - 배\n- 채소\n1. [ ] 장보기\n2. [ ] 요리')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(body(page)).toHaveValue('- 과일\n  - 사과\n  - 배\n- 채소\n1. [ ] 장보기\n  2. [ ] 요리')
  await expect(status(page)).toContainText('저장됨')

  // 읽기 화면에서는 들여 쓴 만큼 목록 안의 목록이 된다.
  await mode(page, '읽기').click()
  await expect(main(page).locator('ul > li > ul > li')).toHaveText(['사과', '배'])
  await expect(main(page).locator('ol > li > ol > li')).toHaveText(['요리'])
  await shell(page, 'head -n 2 notes/목록.md', '- 과일\n  - 사과\n')
})

test('a checked task is struck through, but not the unchecked tasks under it', async ({ page }) => {
  await write(page, '할 일', '- [x] 큰 일\n  - [ ] 작은 일')
  await mode(page, '읽기').click()
  const line = (text: string) =>
    main(page).locator('.md-item', { hasText: text }).first().evaluate((el) => {
      // 취소선은 위에서 아래로 번지므로, 자신과 모든 조상을 본다.
      const seen: string[] = []
      for (let at: Element | null = el; at && !at.classList.contains('preview'); at = at.parentElement) seen.push(getComputedStyle(at).textDecorationLine)
      return seen.includes('line-through')
    })
  expect(await line('큰 일')).toBe(true)
  expect(await line('작은 일')).toBe(false)
})

test('![[note]] shows that note in place, and code blocks are colored', async ({ page }) => {
  await write(page, '인용', '# 넣을 글\n\n- [ ] 할 일')
  await write(page, '본문', '앞\n\n![[인용]]\n\n![[없는 메모]]\n\n```rust\nfn main() {}\n```')
  await mode(page, '읽기').click()
  const embed = main(page).getByRole('complementary', { name: '넣은 메모: 인용' })
  await expect(embed.getByRole('heading', { name: '넣을 글' })).toBeVisible()
  // 넣어진 글의 체크는 여기서 누를 수 없다 (그 메모의 것이므로).
  await expect(embed.getByRole('checkbox')).toBeDisabled()
  await expect(main(page).locator('.md-wikilink.missing')).toHaveText('없는 메모')
  await expect(main(page).locator('.md-code .syn-keyword')).toHaveText('fn')

  // 원래 메모를 고치면 넣은 곳에도 바로 반영된다.
  await embed.getByRole('button', { name: '인용' }).click()
  await expect(title(page)).toHaveValue('인용')
  await mode(page, '편집').click()
  await body(page).fill('# 고친 글')
  await notes(page).getByRole('button', { name: '뒤로' }).click()
  await mode(page, '읽기').click()
  await expect(embed.getByRole('heading', { name: '고친 글' })).toBeVisible()
})

test('a second note can be kept open beside the one being edited', async ({ page }) => {
  await write(page, '자료', '# 참고할 내용\n\n[[초안]]')
  await write(page, '초안', '쓰는 중')
  await item(page, '자료').click({ button: 'right' })
  await menu(page, '옆에 열기').click()
  const ref = notes(page).getByRole('complementary', { name: '참고 메모' })
  await expect(ref.getByRole('heading', { name: '참고할 내용' })).toBeVisible()
  // 편집하던 메모는 그대로다.
  await expect(title(page)).toHaveValue('초안')
  await body(page).fill('자료를 보며 쓴다')
  await expect(ref).toBeVisible()
  // 참고 메모의 제목을 누르면 그 메모를 편집하러 간다.
  await ref.getByRole('button', { name: '자료', exact: true }).click()
  await expect(title(page)).toHaveValue('자료')
  await ref.getByRole('button', { name: '참고 메모 닫기' }).click()
  await expect(ref).toHaveCount(0)
})

test('the graph draws notes and links, and opens the note clicked', async ({ page }) => {
  await write(page, '중심', '[[왼쪽]] [[오른쪽]] [[아직 없음]]')
  await write(page, '왼쪽', '[[중심]]')
  await write(page, '오른쪽', '')
  await write(page, '외톨이', '')
  await notes(page).getByRole('button', { name: '그래프' }).click()
  const graph = notes(page).getByRole('group', { name: '메모 그래프' })
  await expect(graph.getByRole('button')).toHaveCount(5)
  await expect(graph.locator('line')).toHaveCount(4)
  await expect(notes(page).locator('.graph-hint')).toContainText('메모 4개 · 링크 4개')
  await expect(graph.getByRole('button', { name: '아직 없음 (아직 없는 메모), 링크 1개' })).toHaveClass(/missing/)
  await expect(graph.getByRole('button', { name: /^외톨이/ })).toHaveClass(/current/)

  // 점들이 그림 안에 있고 서로 겹치지 않는다.
  // 그래프는 자리의 크기를 잰 뒤 한 번 다시 그리므로, 자리 잡을 때까지 본다.
  await expect(async () => {
    const spots = await graph.locator('.graph-node').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => [r.x + r.width / 2, r.y]))
    const area = (await notes(page).locator('.note-graph').boundingBox())!
    expect(spots).toHaveLength(5)
    for (const [x, y] of spots) {
      expect(x).toBeGreaterThan(area.x)
      expect(x).toBeLessThan(area.x + area.width)
      expect(y).toBeGreaterThan(area.y)
      expect(y).toBeLessThan(area.y + area.height - 40)
    }
  }).toPass()

  // 올려 둔 점과 이어지지 않은 것은 흐려진다.
  await graph.getByRole('button', { name: /^왼쪽/ }).hover()
  await expect(graph.getByRole('button', { name: /^외톨이/ })).toHaveClass(/dim/)
  await expect(graph.getByRole('button', { name: /^중심/ })).not.toHaveClass(/dim/)

  await graph.getByRole('button', { name: /^중심/ }).click()
  await expect(graph).toHaveCount(0)
  await expect(title(page)).toHaveValue('중심')
  // 아직 없는 메모의 점을 누르면 그 이름으로 만들어진다.
  await notes(page).getByRole('button', { name: '그래프' }).click()
  await graph.getByRole('button', { name: /^아직 없음/ }).click()
  await expect(status(page)).toContainText('notes/아직 없음.md')
})
