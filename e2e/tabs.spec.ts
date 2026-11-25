// 한 번에 한 탭만 OS를 돌린다.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, screen, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')

/** 같은 브라우저에서 두 번째 탭을 연다. */
async function secondTab(first: Page) {
  const page = await first.context().newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => localStorage.setItem('webos.welcomed', '1'))
  await page.goto('/')
  return page
}

test('a second tab does not start a second copy', async ({ page }) => {
  await boot(page)
  const other = await secondTab(page)
  const notice = other.getByRole('alertdialog', { name: '다른 탭에서 사용 중입니다' })
  await expect(notice).toBeVisible()
  await expect(other.locator('.desktop')).toHaveCount(0)
  // 첫 탭은 그대로 동작한다.
  await typeIn(page, term(page), 'echo still-here')
  await expectScreen(page, term(page)).toContain('\nstill-here\n')
})

test('taking over saves the work in the old tab first', async ({ page }) => {
  await boot(page)
  // 저장이 미뤄져 있는 동안(0.25초) 곧바로 넘겨받아도 내용이 따라와야 한다.
  await typeIn(page, term(page), 'echo carried > moved.txt')
  await expectScreen(page, term(page)).toMatch(/moved\.txt\nguest@webos:~\$$/)

  const other = await secondTab(page)
  await other.getByRole('button', { name: '이 탭에서 이어 쓰기' }).click()
  await expectScreen(other, term(other)).toMatch(/\$$/)
  await typeIn(other, term(other), 'cat moved.txt')
  await expectScreen(other, term(other)).toContain('cat moved.txt\ncarried\n')

  // 원래 탭은 물러나고, 더 이상 OS가 돌지 않는다.
  await expect(page.getByRole('alertdialog', { name: '다른 탭으로 옮겨 갔습니다' })).toBeVisible()
  await expect(page.locator('.desktop')).toHaveCount(0)
})

test('the session can be taken back and forth without losing changes', async ({ page }) => {
  await boot(page)
  const other = await secondTab(page)
  await other.getByRole('button', { name: '이 탭에서 이어 쓰기' }).click()
  await expectScreen(other, term(other)).toMatch(/\$$/)
  await typeIn(other, term(other), 'echo from-second > second.txt')
  await expectScreen(other, term(other)).toMatch(/second\.txt\nguest@webos:~\$$/)

  await page.getByRole('button', { name: '다시 이 탭에서 쓰기' }).click()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'cat second.txt')
  await expectScreen(page, term(page)).toContain('cat second.txt\nfrom-second\n')
  await expect(other.getByRole('alertdialog', { name: '다른 탭으로 옮겨 갔습니다' })).toBeVisible()
})

test('closing the active tab frees the session for the next one', async ({ page }) => {
  await boot(page)
  const other = await secondTab(page)
  await expect(other.getByRole('alertdialog')).toBeVisible()
  await page.close()
  await other.reload()
  await expectScreen(other, term(other)).toMatch(/\$$/)
})

test('an unresponsive tab does not block a takeover forever', async ({ page }) => {
  // 첫 탭이 넘겨 달라는 요청을 듣지 못하는 상황 (멈췄거나 응답이 없는 탭)
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).BroadcastChannel = class {
      onmessage = null
      postMessage() {}
      close() {}
    }
  })
  await boot(page)
  const other = await secondTab(page)
  await other.getByRole('button', { name: '이 탭에서 이어 쓰기' }).click()
  // 잠시 기다려 본 뒤 가져온다.
  await expect.poll(() => screen(other, term(other)), { timeout: 10_000 }).toMatch(/\$$/)
  // 자리를 빼앗긴 탭도 스스로 멈춘다.
  await expect(page.getByRole('alertdialog', { name: '다른 탭으로 옮겨 갔습니다' })).toBeVisible()
  await expect(page.locator('.desktop')).toHaveCount(0)
})
