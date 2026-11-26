// 시스템 콜 추적 창.
import { expect, test } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, pinWindow, raise, typeIn } from './helpers.ts'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
})

const rows = (page: import('@playwright/test').Page) => appWindow(page, 'trace').locator('.trace-row')
/** 열 사이의 간격은 CSS로 띄우므로, 글자만 이어 붙인 형태로 비교한다. */
const lines = async (page: import('@playwright/test').Page) => rows(page).allTextContents()

test('shows the calls a command makes, as they happen', async ({ page }) => {
  const term = await pinWindow(page)
  await launch(page, '시스템 콜')
  const trace = appWindow(page, 'trace')
  await expect(trace).toContainText('터미널에서 명령을 실행하면')
  await expect(rows(page)).toHaveCount(0)

  await typeIn(page, term, 'cat /etc/motd /nope')
  await expect(rows(page).filter({ hasText: 'open("/etc/motd")' })).toHaveCount(1)
  const text = await lines(page)
  // 셸이 cat을 띄우고, cat이 파일을 열어 읽고 쓴 뒤 끝난다.
  expect(text.some((l) => /sh\s*spawn\("\/bin\/cat", \["cat", "\/etc\/motd", "\/nope"\]\)= \d+$/.test(l))).toBe(true)
  expect(text.some((l) => /cat\s*open\("\/etc\/motd"\)= 4$/.test(l))).toBe(true)
  expect(text.some((l) => /cat\s*write\(1, "Web OS /.test(l))).toBe(true)
  expect(text.some((l) => /cat\s*exit\(1\)$/.test(l))).toBe(true)
  await expect(trace).not.toContainText('터미널에서 명령을 실행하면')

  // 실패한 호출은 눈에 띄게 표시된다.
  const failed = rows(page).filter({ hasText: 'open("/nope")' })
  await expect(failed).toHaveClass(/error/)
  await expect(failed).toContainText('= -1 ENOENT')
  // 셸이 cat이 끝나기를 기다린 시간이 함께 나온다.
  await expect(rows(page).filter({ hasText: /sh\s*wait\(\d+, UNTRACED\)/ }).last()).toContainText('초 대기')
})

test('filters by program, pid or call', async ({ page }) => {
  const term = await pinWindow(page)
  await launch(page, '시스템 콜')
  const trace = appWindow(page, 'trace')
  await typeIn(page, term, 'echo one; ls /tmp')
  await expect(rows(page).filter({ hasText: /ls\s*exit\(0\)/ })).toHaveCount(1)
  const all = await rows(page).count()

  await raise(page, '시스템 콜')
  const filter = trace.getByRole('searchbox', { name: '걸러 보기' })
  await filter.fill('echo')
  expect(await rows(page).count()).toBeLessThan(all)
  for (const line of await lines(page)) expect(line.toLowerCase()).toContain('echo')

  await filter.fill('READDIR')
  await expect(rows(page).first()).toContainText('readdir')
  for (const line of await lines(page)) expect(line).toContain('readdir')

  // 조건을 지우면 그동안의 기록이 그대로 돌아온다.
  await filter.fill('')
  await expect(rows(page)).toHaveCount(all)
  await expect(trace.locator('.statusbar')).toContainText(`${all}줄`)
})

test('can be paused and cleared', async ({ page }) => {
  const term = await pinWindow(page)
  await launch(page, '시스템 콜')
  const trace = appWindow(page, 'trace')
  await typeIn(page, term, 'echo before')
  await expect(rows(page).filter({ hasText: '"before\\n"' })).toHaveCount(1)

  // 터미널에 입력하느라 뒤로 간 추적 창을 다시 앞으로 가져온다.
  await raise(page, '시스템 콜')
  await trace.getByRole('button', { name: '일시정지' }).click()
  const frozen = await rows(page).count()
  await typeIn(page, term, 'echo during')
  await expectScreen(page, term).toContain('\nduring\n')
  await expect(trace.locator('.statusbar')).toContainText('건너뜀')
  expect(await rows(page).count()).toBe(frozen)

  await raise(page, '시스템 콜')
  await trace.getByRole('button', { name: '계속' }).click()
  await trace.getByRole('button', { name: '지우기' }).click()
  await expect(rows(page)).toHaveCount(0)
  await typeIn(page, term, 'echo after')
  await expect(rows(page).filter({ hasText: '"after\\n"' })).toHaveCount(1)
  expect((await lines(page)).some((l) => l.includes('during'))).toBe(false)
})

test('keeps up with a flood without freezing the page', async ({ page }) => {
  const term = await pinWindow(page)
  await launch(page, '시스템 콜')
  const trace = appWindow(page, 'trace')
  await typeIn(page, term, 'yes | head -n 30000 | wc -l')
  await expectScreen(page, term).toContain('\n30000\n')
  // 화면에는 최근 것만 남기고, 넘친 호출은 수만 알려 준다.
  expect(await rows(page).count()).toBeLessThanOrEqual(2000)
  await expect(trace.locator('.statusbar')).toContainText('건너뜀')
  await typeIn(page, term, 'echo still-alive')
  await expectScreen(page, term).toContain('\nstill-alive\n')
})

test('tracing stops when the window closes and starts fresh when reopened', async ({ page }) => {
  const term = await pinWindow(page)
  await launch(page, '시스템 콜')
  await typeIn(page, term, 'echo first')
  await expect(rows(page).filter({ hasText: '"first\\n"' })).toHaveCount(1)
  await raise(page, '시스템 콜')
  await appWindow(page, 'trace').getByRole('button', { name: '닫기' }).click()

  await typeIn(page, term, 'echo unseen')
  await expectScreen(page, term).toContain('\nunseen\n')
  await launch(page, '시스템 콜')
  await expect(rows(page)).toHaveCount(0)
  await typeIn(page, term, 'echo second')
  await expect(rows(page).filter({ hasText: '"second\\n"' })).toHaveCount(1)
  expect((await lines(page)).some((l) => l.includes('unseen'))).toBe(false)
})
