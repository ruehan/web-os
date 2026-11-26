// 실행 메뉴와 막대에 고정한 앱.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, box, expectScreen } from './helpers.ts'

const menu = (page: Page) => page.getByRole('dialog', { name: '앱', exact: true })
const menuButton = (page: Page) => page.getByRole('button', { name: '앱', exact: true })
const pinnedNames = (page: Page) => page.locator('.rail-button.pinned').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

test('the rail keeps a few pinned apps; the menu lists them all', async ({ page }) => {
  expect(await pinnedNames(page)).toEqual(['터미널', '파일', '메모'])
  await expect(menu(page)).toHaveCount(0)

  await menuButton(page).click()
  await expect(menu(page).locator('.launcher-app')).toHaveText([
    '터미널', '파일', '편집기', '메모', '프로세스', '시스템 콜', '시스템 로그', '설정', '시작하기',
  ])
  await expect(menu(page).getByRole('searchbox', { name: '앱 찾기' })).toBeFocused()
  // 창을 가리지 않도록 막대 바로 옆에 뜬다.
  expect((await box(menu(page))).x).toBe(52 + 8)

  await menu(page).getByRole('button', { name: '설정', exact: true }).click()
  await expect(appWindow(page, 'settings')).toHaveClass(/focused/)
  await expect(menu(page)).toHaveCount(0)
})

test('typing filters the list, and Enter opens the first match', async ({ page }) => {
  await menuButton(page).click()
  await page.keyboard.type('시스템')
  await expect(menu(page).locator('.launcher-app')).toHaveText(['시스템 콜', '시스템 로그'])
  await page.keyboard.press('Enter')
  await expect(appWindow(page, 'trace')).toHaveClass(/focused/)

  await menuButton(page).click()
  await page.keyboard.type('없는 앱')
  await expect(menu(page)).toContainText('찾는 앱이 없습니다.')
  await page.keyboard.press('Enter')
  await expect(page.locator('.window')).toHaveCount(2)
})

test('closes with Escape, by clicking elsewhere, or by pressing the button again', async ({ page }) => {
  await menuButton(page).click()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  await menuButton(page).click()
  await expect(menu(page)).toBeVisible()
  await menuButton(page).click()
  await expect(menu(page)).toHaveCount(0)

  await menuButton(page).click()
  const terminal = await box(appWindow(page, 'terminal'))
  await page.mouse.click(terminal.x + terminal.w - 60, terminal.y + terminal.h - 60)
  await expect(menu(page)).toHaveCount(0)
  // 메뉴를 닫은 그 클릭이 창에도 전달되어, 터미널이 바로 입력을 받는다.
  await page.keyboard.type('echo still-typing')
  await page.keyboard.press('Enter')
  await expectScreen(page, appWindow(page, 'terminal')).toContain('\nstill-typing\n')
})

test('apps can be pinned to and removed from the rail, and the choice is remembered', async ({ page }) => {
  await menuButton(page).click()
  const pin = (name: string) => menu(page).getByRole('button', { name: `${name} 막대에 고정` })
  await expect(pin('터미널')).toHaveAttribute('aria-pressed', 'true')
  await expect(pin('설정')).toHaveAttribute('aria-pressed', 'false')

  await pin('설정').click()
  await pin('메모').click()
  expect(await pinnedNames(page)).toEqual(['터미널', '파일', '설정'])
  // 고정을 바꿔도 메뉴는 열려 있다 (여러 개를 이어서 바꿀 수 있다).
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(appWindow(page, 'settings')).toHaveClass(/focused/)

  await page.reload()
  await expectScreen(page, appWindow(page, 'terminal')).toMatch(/\$$/)
  expect(await pinnedNames(page)).toEqual(['터미널', '파일', '설정'])
})

test('on a narrow screen the menu opens above the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await menuButton(page).click()
  const panel = await box(menu(page))
  const rail = await box(page.locator('.rail'))
  expect(panel.x).toBe(8)
  expect(panel.w).toBe(390 - 16)
  expect(panel.y + panel.h).toBeLessThanOrEqual(rail.y)
  await menu(page).getByRole('button', { name: '메모', exact: true }).click()
  await expect(appWindow(page, 'notes')).toHaveClass(/focused/)
})
