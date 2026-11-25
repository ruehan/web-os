// 부팅 화면과 첫 방문 안내.
import { expect, test } from '@playwright/test'
import { appWindow, boot, expectScreen, launch } from './helpers.ts'

test.describe('boot screen', () => {
  test('shows the kernel log line by line, then the desktop', async ({ page }) => {
    // 부팅 화면은 1초 남짓이면 지나가므로, 페이지가 다 불러와지기를 기다리지 않고 바로 살핀다.
    await page.goto('/', { waitUntil: 'commit' })
    const log = page.getByRole('log')
    await expect(log).toContainText('kernel: booting')
    // 한 줄씩 드러나므로 처음에는 마지막 줄이 아직 없다.
    expect(await log.textContent()).not.toContain('kernel: ready')
    await expect(page.locator('.desktop')).toHaveCount(0)

    await expect(log).toContainText('kernel: ready')
    await expect(page.locator('.desktop')).toBeVisible()
    await expect(page.getByTestId('boot')).toHaveCount(0)
    await expectScreen(page, appWindow(page, 'terminal')).toMatch(/\$$/)
  })

  test('any key skips the wait', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' })
    await expect(page.getByRole('log')).toContainText('kernel: booting')
    await page.keyboard.press('Space')
    await expect(page.locator('.desktop')).toBeVisible()
    expect(await page.getByTestId('boot').count()).toBe(0)
  })

  test('is skipped entirely when the user prefers reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const started = Date.now()
    await page.goto('/')
    await expect(page.locator('.desktop')).toBeVisible()
    expect(Date.now() - started).toBeLessThan(700)
  })
})

test.describe('welcome guide', () => {
  test('opens on the first visit only, beside the terminal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await boot(page, { firstVisit: true })
    const welcome = appWindow(page, 'welcome')
    await expect(welcome).toHaveClass(/focused/)
    await expect(welcome).toContainText('브라우저 탭 안에서 돌아가는 작은 운영체제')
    // 터미널을 가리지 않도록 오른쪽 가장자리에 놓인다.
    const box = (await welcome.boundingBox())!
    const terminal = (await appWindow(page, 'terminal').boundingBox())!
    expect(Math.round(box.x + box.width)).toBe(1280 - 24)
    expect(box.x).toBeGreaterThanOrEqual(terminal.x + terminal.width)

    await page.reload()
    await expectScreen(page, appWindow(page, 'terminal')).toMatch(/\$$/)
    await expect(appWindow(page, 'welcome')).toHaveCount(0)
    await launch(page, '시작하기')
    await expect(appWindow(page, 'welcome')).toBeVisible()
  })

  test('its buttons run commands in the open terminal', async ({ page }) => {
    await boot(page, { firstVisit: true })
    const welcome = appWindow(page, 'welcome')
    const terminal = appWindow(page, 'terminal')

    await welcome.getByRole('button', { name: '실행: ps' }).click()
    await expect(terminal).toHaveClass(/focused/)
    await expectScreen(page, terminal).toContain('$ ps\n  PID  PPID STAT TTY COMMAND\n    1     0 S    1   sh\n')
    // 명령을 넘긴 뒤에는 터미널이 키 입력을 받는다.
    await expect(terminal.locator('.terminal textarea')).toBeFocused()

    await page.getByRole('button', { name: '창: 시작하기' }).click()
    await welcome.getByRole('button', { name: '실행: yes | head -n 3' }).click()
    await expectScreen(page, terminal).toContain('head -n 3\ny\ny\ny\n')
    await expect(appWindow(page, 'terminal')).toHaveCount(1)
  })

  test('opens a terminal for the command when none is open', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await boot(page, { firstVisit: true })
    await appWindow(page, 'terminal').getByRole('button', { name: '닫기' }).click()
    await expect(appWindow(page, 'terminal')).toHaveCount(0)

    await appWindow(page, 'welcome').getByRole('button', { name: '실행: ls -l /bin' }).click()
    const terminal = appWindow(page, 'terminal')
    await expect(terminal).toHaveClass(/focused/)
    // 셸이 뜨기 전에 넘긴 명령도 빠짐없이 실행된다.
    await expectScreen(page, terminal).toMatch(/\$ ls -l \/bin\n-\s+\d+ cat\n/)
  })

  test('links open the other apps', async ({ page }) => {
    await boot(page, { firstVisit: true })
    const welcome = appWindow(page, 'welcome')
    await welcome.locator('li', { hasText: '파일 탐색기' }).getByRole('button', { name: '열기' }).click()
    await expect(appWindow(page, 'files')).toHaveClass(/focused/)
    await page.getByRole('button', { name: '창: 시작하기' }).click()
    await welcome.locator('li', { hasText: '프로세스' }).getByRole('button', { name: '열기' }).click()
    await expect(appWindow(page, 'processes')).toHaveClass(/focused/)
  })
})
