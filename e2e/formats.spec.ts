// 형식별 지원: 새 파일의 형식 고르기, 문법 색상, 미리보기.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, fileRow, launch, raise, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const editor = (page: Page) => appWindow(page, 'editor')
const text = (page: Page) => editor(page).getByRole('textbox', { name: '파일 내용' })

/** 터미널에서 파일을 만든 뒤 편집기로 연다. */
async function open(page: Page, name: string, content: string) {
  await page.evaluate(() => 0)
  await typeIn(page, term(page), `cat > ${name}`)
  await page.keyboard.insertText(content)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+d')
  await expectScreen(page, term(page)).toMatch(/guest@webos:~\$$/)
  await launch(page, '파일')
  await fileRow(page, name).dblclick()
  await expect(text(page)).toBeVisible()
}

/** 색이 입혀진 조각들: "종류:글" */
const colored = (page: Page) =>
  editor(page)
    .locator('.code-layer span')
    .evaluateAll((spans) => spans.map((s) => `${s.className.replace('syn-', '')}:${s.textContent}`))

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await boot(page)
})

test('a new file can be created in several formats', async ({ page }) => {
  await launch(page, '파일')
  const files = appWindow(page, 'files')
  // 새 파일의 형식을 고르는 단추들 (이름과 확장자)
  const types = files.getByRole('button', { name: /\.(txt|md|json|sh|csv)$/ })
  await files.getByRole('button', { name: '새 파일', exact: true }).click()
  await expect(types).toHaveText(['텍스트 .txt', '마크다운 .md', 'JSON .json', '셸 스크립트 .sh', 'CSV .csv'])

  await files.getByRole('button', { name: 'JSON .json' }).click()
  const rename = files.getByRole('textbox', { name: '새 이름' })
  await expect(rename).toHaveValue('새 파일.json')
  await expect(rename).toBeFocused()
  await page.keyboard.type('config')
  await page.keyboard.press('Enter')
  await expect(fileRow(page, 'config.json')).toBeVisible()
  await expect(types).toHaveCount(0)

  // 처음부터 올바른 JSON이라 미리보기가 바로 된다.
  await fileRow(page, 'config.json').dblclick()
  await expect(text(page)).toHaveValue('{}\n')
  await editor(page).getByRole('button', { name: '미리보기' }).click()
  await expect(editor(page).getByRole('document', { name: '미리보기' })).toHaveText('{}')

  await raise(page, 'guest')
  await files.getByRole('button', { name: '새 파일', exact: true }).click()
  await files.getByRole('button', { name: '마크다운 .md' }).click()
  await expect(rename).toHaveValue('새 파일.md')
  // 형식 고르기는 다시 누르면 닫힌다.
  await page.keyboard.press('Enter')
  await files.getByRole('button', { name: '새 파일', exact: true }).click()
  await files.getByRole('button', { name: '새 파일', exact: true }).click()
  await expect(types).toHaveCount(0)
})

test('code is colored by its syntax, and what you type lines up with it', async ({ page }) => {
  await launch(page, '파일')
  await fileRow(page, 'hello.sh').dblclick()
  await expect.poll(() => colored(page)).toContain('comment:# 셸 스크립트 예제')
  const spans = await colored(page)
  expect(spans).toContain('name:${USER}')
  expect(spans).toContain('keyword:echo')
  expect(spans).toContain('string:"현재 위치: $PWD"')

  // 색을 입힌 글과 입력창은 같은 자리에 같은 크기로 겹쳐 있어야 한다.
  const boxes = await editor(page)
    .locator('.code-area')
    .evaluate((area) => {
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return [r.x, r.y, r.width, r.height].map(Math.round)
      }
      const style = (el: Element) => {
        const s = getComputedStyle(el)
        return [s.fontFamily, s.fontSize, s.lineHeight, s.padding, s.whiteSpace, s.tabSize].join('|')
      }
      const [layer, input] = [area.querySelector('.code-layer')!, area.querySelector('.code-input')!]
      return { layer: rect(layer), input: rect(input), same: style(layer) === style(input), ink: getComputedStyle(input).color }
    })
  expect(boxes.layer).toEqual(boxes.input)
  expect(boxes.same).toBe(true)
  // 입력창의 글자는 투명해서, 보이는 것은 뒤의 색 입힌 글이다.
  expect(boxes.ink).toBe('rgba(0, 0, 0, 0)')

  // 치는 대로 색이 다시 입혀진다.
  await text(page).focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('if true; then exit 3; fi # 끝')
  await expect.poll(() => colored(page)).toContain('comment:# 끝')
  expect(await colored(page)).toEqual(expect.arrayContaining(['keyword:if', 'keyword:then', 'number:3', 'keyword:fi']))
  await page.keyboard.press('Control+s')
  await typeIn(page, term(page), 'tail -n 1 hello.sh')
  // 마지막 줄에 줄바꿈을 치지 않았으므로 셸이 % 표시를 붙인다.
  await expectScreen(page, term(page)).toContain('tail -n 1 hello.sh\nif true; then exit 3; fi # 끝%\n')
})

test('plain text files are not colored', async ({ page }) => {
  await open(page, 'plain.txt', 'if "quoted" # not a comment 42')
  await expect(text(page)).toHaveValue('if "quoted" # not a comment 42\n')
  expect(await colored(page)).toEqual([])
  await expect(editor(page).getByRole('button', { name: '미리보기' })).toHaveCount(0)
})

test('Markdown can be previewed with its formatting', async ({ page }) => {
  await launch(page, '파일')
  await fileRow(page, 'README.md').dblclick()
  await expect.poll(() => colored(page)).toContain('heading:# 환영합니다\n')

  await editor(page).getByRole('button', { name: '미리보기' }).click()
  const preview = editor(page).getByRole('document', { name: '미리보기' })
  await expect(preview.getByRole('heading', { name: '환영합니다' })).toBeVisible()
  await expect(preview.locator('p').first()).toContainText('이 터미널에서 실행되는 모든 명령은')
  await expect(text(page)).toHaveCount(0)

  // 편집으로 돌아가 고치면 미리보기에 반영된다. 파일에 든 태그는 글자 그대로 보일 뿐 실행되지 않는다.
  await editor(page).getByRole('button', { name: '편집' }).click()
  await text(page).fill('# 제목\n\n**굵게** 와 `코드`, [링크](https://example.com)\n\n- 하나\n- 둘\n\n<img src=x onerror="window.hacked=1">\n')
  await editor(page).getByRole('button', { name: '미리보기' }).click()
  await expect(preview.locator('strong')).toHaveText('굵게')
  await expect(preview.locator('code')).toHaveText('코드')
  await expect(preview.getByRole('link', { name: '링크' })).toHaveAttribute('href', 'https://example.com')
  await expect(preview.getByRole('link', { name: '링크' })).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(preview.getByRole('listitem')).toHaveText(['하나', '둘'])
  await expect(preview).toContainText('<img src=x onerror="window.hacked=1">')
  await expect(preview.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked)).toBeUndefined()

  // 미리보기 중에도 저장할 수 있고, 저장하지 않은 채 닫으려 하면 묻는다.
  await expect(editor(page).locator('.title')).toHaveText('README.md •')
  await editor(page).getByRole('button', { name: '닫기' }).click()
  await expect(editor(page).getByRole('alertdialog')).toContainText('저장하지 않은 변경이 있습니다.')
})

test('JSON is shown tidied up, or the mistake is pointed out', async ({ page }) => {
  await open(page, 'data.json', '{"이름":"값","목록":[1,2,{"깊이":true}],"없음":null}')
  await expect.poll(() => colored(page)).toEqual(expect.arrayContaining(['name:"이름"', 'string:"값"', 'number:1', 'keyword:true', 'keyword:null']))

  await editor(page).getByRole('button', { name: '미리보기' }).click()
  const preview = editor(page).getByRole('document', { name: '미리보기' })
  await expect(preview.locator('.json-view')).toHaveText(
    '{\n  "이름": "값",\n  "목록": [\n    1,\n    2,\n    {\n      "깊이": true\n    }\n  ],\n  "없음": null\n}',
  )
  await expect(preview.locator('.syn-name').first()).toHaveText('"이름"')

  await editor(page).getByRole('button', { name: '편집' }).click()
  await text(page).fill('{"a": 1,}')
  await editor(page).getByRole('button', { name: '미리보기' }).click()
  await expect(preview.getByRole('alert')).toContainText('올바른 JSON이 아닙니다')
})

test('CSV is shown as a table', async ({ page }) => {
  await open(page, 'people.csv', '이름,나이,메모\n"김, 철수",30,"말했다 ""안녕"""\n영희,25')
  await editor(page).getByRole('button', { name: '미리보기' }).click()
  const table = editor(page).getByRole('table')
  await expect(table.getByRole('columnheader')).toHaveText(['이름', '나이', '메모'])
  await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText(['김, 철수', '30', '말했다 "안녕"'])
  // 칸이 모자란 줄도 표가 어긋나지 않는다.
  await expect(table.getByRole('row').nth(2).getByRole('cell')).toHaveText(['영희', '25', ''])
  await expect(editor(page).getByRole('document', { name: '미리보기' })).toContainText('2줄 · 3칸')
})
