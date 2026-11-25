// 메모 앱.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, screen, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const notes = (page: Page) => appWindow(page, 'notes')
const body = (page: Page) => notes(page).getByRole('textbox', { name: '메모 내용' })
const items = (page: Page) => notes(page).getByRole('listbox', { name: '메모 목록' }).getByRole('option')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await boot(page)
  await launch(page, '메모')
  await expect(notes(page)).toContainText('아직 메모가 없습니다.')
})

test('a note is saved as you type, as a real file', async ({ page }) => {
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await expect(body(page)).toBeFocused()
  await page.keyboard.type('# 장보기')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- 우유')
  await expect(items(page)).toHaveCount(1)
  await expect(items(page).first()).toContainText('장보기')
  await expect(items(page).first()).toContainText('- 우유')
  // 저장 버튼 없이 저장된다.
  await expect(notes(page).locator('.statusbar')).toContainText('저장됨')

  // 메모는 notes 폴더에 파일 하나로 있다. (이 셸은 * 를 풀어 주지 않으므로 이름을 먼저 알아낸다.)
  await typeIn(page, term(page), 'ls notes')
  await expectScreen(page, term(page)).toMatch(/ls notes\n\d{8}-\d{6}\.md\n/)
  const name = /ls notes\n(\S+\.md)\n/.exec(await screen(page, term(page)))![1]
  await typeIn(page, term(page), `cat notes/${name}`)
  await expectScreen(page, term(page)).toContain(`cat notes/${name}\n# 장보기\n- 우유`)
  // 마크다운 메모는 색이 입혀지고 미리 볼 수 있다.
  await raise(page, '메모')
  await expect(notes(page).locator('.code-layer .syn-heading')).toHaveText('# 장보기\n')
  await notes(page).getByRole('button', { name: '미리보기' }).click()
  await expect(notes(page).getByRole('heading', { name: '장보기' })).toBeVisible()
  await expect(notes(page).getByRole('listitem')).toHaveText(['우유'])
})

test('notes can be written as plain text instead of Markdown', async ({ page }) => {
  await notes(page).getByLabel('새 메모의 형식').selectOption({ label: '텍스트 (.txt)' })
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await page.keyboard.type('# 제목이 아니라 그냥 글')
  await expect(notes(page).locator('.statusbar')).toContainText(/notes\/\d{8}-\d{6}\.txt · 저장됨/)
  // 일반 텍스트는 색을 입히지 않고, 미리보기도 없다.
  await expect(notes(page).locator('.code-layer span')).toHaveCount(0)
  await expect(notes(page).getByRole('button', { name: '미리보기' })).toHaveCount(0)

  await typeIn(page, term(page), 'ls notes')
  await expectScreen(page, term(page)).toMatch(/ls notes\n\d{8}-\d{6}\.txt\n/)
})

test('lists notes newest first, switches between them and finds by content', async ({ page }) => {
  for (const text of ['첫 번째 메모\n사과', '두 번째 메모\n바나나', '세 번째 메모\n사과 파이']) {
    await notes(page).getByRole('button', { name: '새 메모' }).click()
    await body(page).fill(text)
    await expect(notes(page).locator('.statusbar')).toContainText('저장됨')
    // 메모의 이름은 만든 시각(초 단위)이라, 순서를 구분하려면 1초가 지나야 한다.
    await page.waitForTimeout(1050)
  }
  await expect(items(page).locator('.notes-title')).toHaveText(['세 번째 메모', '두 번째 메모', '첫 번째 메모'])

  await items(page).nth(2).click()
  await expect(body(page)).toHaveValue('첫 번째 메모\n사과')
  await expect(items(page).nth(2)).toHaveAttribute('aria-selected', 'true')

  await notes(page).getByRole('searchbox', { name: '메모 찾기' }).fill('사과')
  await expect(items(page).locator('.notes-title')).toHaveText(['세 번째 메모', '첫 번째 메모'])
  await notes(page).getByRole('searchbox', { name: '메모 찾기' }).fill('없는 말')
  await expect(notes(page)).toContainText('찾는 내용이 든 메모가 없습니다.')
  // 찾는 중에도 열어 둔 메모는 그대로다.
  await expect(body(page)).toHaveValue('첫 번째 메모\n사과')
})

test('deleting asks first and removes the file', async ({ page }) => {
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await body(page).fill('지울 메모')
  await expect(notes(page).locator('.statusbar')).toContainText('저장됨')
  await notes(page).getByRole('button', { name: '삭제' }).click()
  await notes(page).getByRole('button', { name: '취소' }).click()
  await expect(items(page)).toHaveCount(1)

  await notes(page).getByRole('button', { name: '삭제' }).click()
  await notes(page).getByRole('button', { name: '지우기' }).click()
  await expect(notes(page)).toContainText('아직 메모가 없습니다.')
  await typeIn(page, term(page), 'ls notes | wc -l')
  await expectScreen(page, term(page)).toContain('wc -l\n0\n')
})

test('notes survive a reload, including text typed just before closing the window', async ({ page }) => {
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await page.keyboard.type('닫기 직전에 친 글')
  // 자동 저장을 기다리지 않고 바로 창을 닫는다.
  await notes(page).getByRole('button', { name: '닫기' }).click()
  await page.waitForTimeout(700)
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await launch(page, '메모')
  await expect(items(page).locator('.notes-title')).toHaveText(['닫기 직전에 친 글'])
  await expect(body(page)).toHaveValue('닫기 직전에 친 글')
})

test('picks up notes changed from the terminal, without losing what is being typed', async ({ page }) => {
  await notes(page).getByRole('button', { name: '새 메모' }).click()
  await body(page).fill('앱에서 쓴 메모')
  await expect(notes(page).locator('.statusbar')).toContainText('저장됨')

  await typeIn(page, term(page), 'echo "터미널에서 쓴 메모" > notes/00000000-000000.md')
  await expect(items(page).locator('.notes-title')).toHaveText(['앱에서 쓴 메모', '터미널에서 쓴 메모'])

  // 치는 도중에 다른 메모 파일이 바뀌어도, 지금 치는 내용은 그대로다.
  await raise(page, '메모')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' 그리고 더')
  await typeIn(page, term(page), 'echo 또 > notes/00000000-000001.md')
  await expect(items(page)).toHaveCount(3)
  await expect(body(page)).toHaveValue('앱에서 쓴 메모 그리고 더')
  await expect(notes(page).locator('.statusbar')).toContainText('저장됨')
  await typeIn(page, term(page), 'cat notes/00000000-000001.md')
  await expectScreen(page, term(page)).toContain('cat notes/00000000-000001.md\n또\n')
})
