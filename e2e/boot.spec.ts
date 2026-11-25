// 실제 브라우저에서 Worker 프로세스와 블로킹 시스템 콜(SharedArrayBuffer + Atomics)이
// 동작하는지 확인한다.
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('console')).toContainText('kernel: ready')
})

test('page is cross-origin isolated', async ({ page }) => {
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  await expect(page.getByTestId('console')).toContainText('cross-origin isolated = true')
})

test('runs a WASM binary as a process', async ({ page }) => {
  await page.getByRole('button', { name: 'hello' }).click()
  const log = page.getByTestId('console')
  await expect(log).toContainText('Hello from a real WASM process!')
  await expect(log).toContainText('argv = ["hello", "world"]')
  await expect(log).toContainText('USER = guest')
  await expect(log).toContainText('[1] exited with code 0')
})

test('file syscalls and exit codes work', async ({ page }) => {
  const log = page.getByTestId('console')
  await page.getByRole('button', { name: 'fsdemo' }).click()
  await expect(log).toContainText('seek(6) -> line')
  await expect(log).toContainText('size = 23')
  // stderr는 버퍼링 없이 조각나서 오지만 화면에는 한 줄로 보여야 한다.
  await expect(log.locator('.err')).toHaveText(['open missing: NotFound'])
  await expect(log).toContainText('[1] exited with code 0')

  await page.getByRole('button', { name: 'exitcode 42' }).click()
  await expect(log).toContainText('[2] exited with code 42')
})

test('a busy process does not freeze the UI and can be killed', async ({ page }) => {
  const log = page.getByTestId('console')
  await page.getByRole('button', { name: 'spin' }).click()
  await expect(log).toContainText('spinning... 1s')
  await expect(page.getByTestId('procs')).toContainText('프로세스 1개')

  // spin이 CPU를 점유하는 동안에도 다른 프로세스가 실행된다.
  await page.getByRole('button', { name: 'hello' }).click()
  await expect(log).toContainText('[2] exited with code 0')

  await page.getByRole('button', { name: 'kill' }).click()
  await expect(log).toContainText('[1] exited with code 137')
  await expect(page.getByTestId('procs')).toContainText('프로세스 0개')

  // 종료 후에는 더 이상 출력이 늘지 않는다.
  const before = await log.textContent()
  await page.waitForTimeout(1500)
  expect(await log.textContent()).toBe(before)
})
