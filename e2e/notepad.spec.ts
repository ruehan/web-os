// 메모장: 글 입력 칸을 가진 WASM 프로세스. 목록과 단추는 프로세스가 그리고, 글을 치는 곳은 화면의 실제 입력 칸이다.
import { expect, test, type Locator, type Page } from '@playwright/test'
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

/** 캔버스 안의 좌표를 누른다. */
async function clickAt(surface: Locator, x: number, y: number) {
  await surface.click({ position: { x, y } })
}

/** 캔버스 안의 사각형에 칠해진 색의 종류 수. 글자가 그려져 있으면 여러 색(경계의 중간색 포함)이 나온다. */
const colorsIn = (surface: Locator, x: number, y: number, w: number, h: number) =>
  surface.evaluate(
    (el: HTMLCanvasElement, [x, y, w, h]) => {
      const scale = el.width / el.clientWidth
      const data = el.getContext('2d')!.getImageData(x! * scale, y! * scale, w! * scale, h! * scale).data
      const seen = new Set<number>()
      for (let i = 0; i < data.length; i += 4) seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!)
      return seen.size
    },
    [x, y, w, h],
  )

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test('creates a note, types into a real text field, and saves to a file', async ({ page }) => {
  await launch(page, '메모장')
  await expect(canvas(page)).toBeVisible()
  await expect(editor(page)).toHaveCount(0)
  await clickAt(canvas(page), 40, 22) // "새 메모" 단추
  // 새 메모가 열리면 입력 칸이 나타나 커서를 받는다.
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('첫 줄입니다')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second line')
  await expect(editor(page)).toHaveValue('첫 줄입니다\nsecond line')
  // 치는 동안 커서가 자리를 지킨다 (프로그램이 다시 그려도 칸을 새로 만들지 않는다).
  await page.keyboard.type('!')
  await expect(editor(page)).toHaveValue('첫 줄입니다\nsecond line!')
  await shell(page, 'cat "notes/새 메모.md"', '첫 줄입니다\nsecond line!')
  await shell(page, 'ps', /\n\s*\d+\s.*notepad\n/)
})

test('the field sits where the program put it and follows the window size', async ({ page }) => {
  await launch(page, '메모장')
  await clickAt(canvas(page), 40, 22)
  await expect(editor(page)).toBeFocused()
  const [frame, field] = [(await canvas(page).boundingBox())!, (await editor(page).boundingBox())!]
  expect({ x: field.x - frame.x, y: field.y - frame.y, w: field.width, h: field.height }).toEqual({ x: 228, y: 56, w: 514, h: 432 })
  await pad(page).getByRole('button', { name: '최대화' }).click()
  await expect.poll(async () => (await editor(page).boundingBox())!.width).toBe(1226 - 228 - 18)
  // 크기가 바뀌어도 쓰던 글과 커서는 그대로다.
  await page.keyboard.type('그대로')
  await expect(editor(page)).toHaveValue('그대로')
})

test('opens notes made elsewhere and picks up outside changes when focused again', async ({ page }) => {
  await shell(page, 'mkdir notes; echo 우유 사기 > notes/장보기.md; echo 안건 > notes/회의.md', /\$$/)
  await launch(page, '메모장')
  await expect(canvas(page)).toBeVisible()
  // 목록의 첫 줄에 글자가 그려졌다.
  await expect.poll(() => colorsIn(canvas(page), 10, 46, 150, 26)).toBeGreaterThan(2)
  await clickAt(canvas(page), 60, 44 + 15)
  await expect(editor(page)).toHaveValue('우유 사기\n')
  await clickAt(canvas(page), 60, 44 + 45)
  await expect(editor(page)).toHaveValue('안건\n')

  await shell(page, 'echo 터미널에서 고침 > notes/회의.md', /\$$/)
  await page.getByRole('button', { name: '창: 메모장' }).click()
  await expect(editor(page)).toHaveValue('터미널에서 고침\n')
  // 창이 앞으로 오면 쓰던 칸으로 커서가 돌아온다.
  await expect(editor(page)).toBeFocused()
})

test('Ctrl+S in the field saves at once instead of opening the browser dialog', async ({ page }) => {
  await launch(page, '메모장')
  await clickAt(canvas(page), 40, 22)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('바로 저장')
  const prevented = await editor(page).evaluate((el) => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(prevented).toBe(true)
  // 복사·붙여넣기·되돌리기는 칸이 스스로 처리하도록 막지 않는다.
  for (const key of ['c', 'v', 'z', 'a']) {
    expect(await editor(page).evaluate((el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })), key)).toBe(true)
  }
  await shell(page, 'cat "notes/새 메모.md"', '바로 저장')
})

test('saves on close, and the window calls show in the trace', async ({ page }) => {
  await launch(page, '시스템 콜')
  await launch(page, '메모장')
  await clickAt(canvas(page), 40, 22)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('닫기 직전')
  await pad(page).getByRole('button', { name: '닫기' }).click()
  await expect(pad(page)).toHaveCount(0)
  const trace = appWindow(page, 'trace')
  await expect(trace).toContainText(/guimeasure\(19 bytes\)\s*= 1 widths/)
  await expect(trace).toContainText(/guievent\((\d+ms)?\)\s*= input\(1, \d+, 0\)/)
  await expect(trace).toContainText('guitext(1, 0, 32768)')
  await shell(page, 'cat "notes/새 메모.md"', '닫기 직전')
})

test('scrolls its list with the wheel', async ({ page }) => {
  await shell(page, 'mkdir notes; cd notes; touch 01.md 02.md 03.md 04.md 05.md 06.md 07.md 08.md 09.md 10.md 11.md 12.md 13.md 14.md 15.md 16.md 17.md 18.md 19.md 20.md 21.md 22.md', /\$$/)
  await launch(page, '메모장')
  await expect(canvas(page)).toBeVisible()
  await expect.poll(() => colorsIn(canvas(page), 10, 46, 150, 26)).toBeGreaterThan(2)
  const box = (await canvas(page).boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 200)
  await page.mouse.wheel(0, 2000)
  // 끝까지 밀면 마지막 메모(22)가 맨 아래 줄에 온다. 그 줄을 눌러 열어 본다.
  await page.waitForTimeout(150)
  await clickAt(canvas(page), 60, 500 - 15)
  await expect(editor(page)).toBeVisible()
  await editor(page).fill('마지막 메모')
  await shell(page, 'cat 22.md', '마지막 메모')
})

test('the notes app sees what the notepad wrote', async ({ page }) => {
  await launch(page, '메모장')
  await clickAt(canvas(page), 40, 22)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('# 두 앱이 같은 파일을 본다')
  await launch(page, '메모')
  const notes = appWindow(page, 'notes')
  await expect(notes.getByRole('tree', { name: '보관함' }).locator('.tree-name')).toHaveText(['새 메모'])
  await expect(notes.getByRole('textbox', { name: '메모 내용' })).toHaveValue('# 두 앱이 같은 파일을 본다')
})
