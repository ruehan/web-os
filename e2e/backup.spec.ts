// 백업 파일로 내보내고 되살리기, 그리고 저장해 둔 것이 사라졌을 때의 알림.
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { unpackTar } from '../src/kernel/tar.ts'
import { appWindow, boot, expectScreen, launch, raise, removeSaved, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const settings = (page: Page) => appWindow(page, 'settings')

/** 설정에서 백업 파일을 내려받아 그 내용을 돌려준다. */
async function download(page: Page) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    settings(page).getByRole('button', { name: '백업 파일 내려받기' }).click(),
  ])
  return { name: file.suggestedFilename(), data: readFileSync(await file.path()) }
}

/** 백업 파일을 골라 되살리기를 확인한다. */
async function restore(page: Page, name: string, data: Buffer) {
  await settings(page).getByLabel('백업 파일', { exact: true }).setInputFiles({ name, mimeType: 'application/x-tar', buffer: data })
  const confirm = settings(page).getByRole('alertdialog', { name: '백업에서 되살리기' })
  await expect(confirm).toContainText(`“${name}”의 내용으로 바꿉니다`)
  await confirm.getByRole('button', { name: '되살리기' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await boot(page)
})

test('downloads everything as a tar file and restores from it', async ({ page }) => {
  await typeIn(page, term(page), 'echo 소중한 내용 > 논문.txt && echo conf > /etc/custom && mkdir -p /data/깊은/폴더')
  await expectScreen(page, term(page)).toMatch(/폴더\nguest@webos:~\$$/)
  await launch(page, '설정')
  await expect(settings(page).getByLabel('백업 상태')).toContainText('아직 없음')

  const backup = await download(page)
  expect(backup.name).toMatch(/^webos-backup-\d{8}-\d{4}\.tar$/)
  await expect(settings(page).getByLabel('백업 상태')).toContainText('방금 전')

  // 내려받은 파일은 일반 tar 묶음이고, 모든 디렉터리가 들어 있다.
  const entries = unpackTar(backup.data)
  const text = (path: string) => new TextDecoder().decode(entries.find((e) => e.path === path)?.data)
  expect(text('home/guest/논문.txt')).toBe('소중한 내용\n')
  expect(text('etc/custom')).toBe('conf\n')
  expect(entries.some((e) => e.path === 'data/깊은/폴더' && !e.data)).toBe(true)
  expect(entries.filter((e) => e.path.startsWith('bin/')).length).toBe(33)
  expect(entries.some((e) => e.path.startsWith('proc'))).toBe(false)

  // 그 뒤로 내용이 달라진다.
  await typeIn(page, term(page), 'rm 논문.txt /etc/custom; echo later > later.txt')
  await expectScreen(page, term(page)).toMatch(/later\.txt\nguest@webos:~\$$/)

  await raise(page, '설정')
  await restore(page, backup.name, backup.data)
  // 화면이 다시 열리고 백업 시점의 내용으로 돌아온다.
  await expect(appWindow(page, 'settings')).toHaveCount(0)
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'cat 논문.txt /etc/custom; ls /data/깊은; ls')
  await expectScreen(page, term(page)).toContain('; ls\n소중한 내용\nconf\n폴더\nREADME.md  hello.sh  논문.txt\n')
  // 다시 열어도 유지된다.
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'cat 논문.txt')
  await expectScreen(page, term(page)).toContain('cat 논문.txt\n소중한 내용\n')
})

test('asks before replacing, and cancelling keeps everything', async ({ page }) => {
  await launch(page, '설정')
  const backup = await download(page)
  await typeIn(page, term(page), 'echo newer > newer.txt')
  await expectScreen(page, term(page)).toMatch(/newer\.txt\nguest@webos:~\$$/)
  await raise(page, '설정')
  await settings(page).getByLabel('백업 파일', { exact: true }).setInputFiles({ name: backup.name, mimeType: 'application/x-tar', buffer: backup.data })
  await settings(page).getByRole('alertdialog').getByRole('button', { name: '취소' }).click()
  await expect(settings(page).getByRole('alertdialog')).toHaveCount(0)
  await typeIn(page, term(page), 'cat newer.txt')
  await expectScreen(page, term(page)).toContain('cat newer.txt\nnewer\n')
})

test('refuses files that are not backups, leaving the current files alone', async ({ page }) => {
  await typeIn(page, term(page), 'echo safe > safe.txt')
  await expectScreen(page, term(page)).toMatch(/safe\.txt\nguest@webos:~\$$/)
  await launch(page, '설정')
  const alert = settings(page).getByRole('alert')

  await restore(page, 'photo.tar', Buffer.from('this is not a tar file at all'))
  await expect(alert).toHaveText('Web OS의 백업 파일이 아니거나 파일이 손상됐습니다.')

  // 형식은 맞지만 이 OS의 백업이 아닌 묶음
  const { packTar } = await import('../src/kernel/tar.ts')
  await restore(page, 'other.tar', Buffer.from(packTar([{ path: 'notes.txt', data: new TextEncoder().encode('x') }])))
  await expect(alert).toHaveText('Web OS의 백업 파일이 아니거나 파일이 손상됐습니다.')

  // 내려받다 끊긴 백업
  const backup = await download(page)
  await restore(page, backup.name, backup.data.subarray(0, backup.data.length - 4096))
  await expect(alert).toHaveText('Web OS의 백업 파일이 아니거나 파일이 손상됐습니다.')

  await typeIn(page, term(page), 'cat safe.txt')
  await expectScreen(page, term(page)).toContain('cat safe.txt\nsafe\n')
})

test('a restored backup also reaches the linked folder', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('backup-folder', { create: true })
  })
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'echo v1 > doc.txt')
  await expectScreen(page, term(page)).toMatch(/doc\.txt\nguest@webos:~\$$/)
  await launch(page, '설정')
  const backup = await download(page)
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  await expect(settings(page).getByLabel('보관 폴더 상태')).toContainText('연결됨')
  await typeIn(page, term(page), 'echo v2 > doc.txt; echo extra > extra.txt')
  await expectScreen(page, term(page)).toMatch(/extra\.txt\nguest@webos:~\$$/)

  await raise(page, '설정')
  await restore(page, backup.name, backup.data)
  await expect(appWindow(page, 'settings')).toHaveCount(0)
  await expectScreen(page, term(page)).toMatch(/\$$/)
  const onDisk = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('backup-folder')
    const guest = await (await root.getDirectoryHandle('home')).getDirectoryHandle('guest')
    const names: string[] = []
    for await (const name of (guest as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name)
    const doc = await (await (await guest.getFileHandle('doc.txt')).getFile()).text()
    return { names: names.filter((n) => !n.startsWith('.')).sort(), doc }
  })
  expect(onDisk).toEqual({ names: ['README.md', 'doc.txt', 'hello.sh'], doc: 'v1\n' })
})

test.describe('when saved data has disappeared', () => {
  /** 며칠 쓰던 브라우저에서 저장소가 지워진 상황을 만든다 (쓴 흔적은 남아 있다). */
  const wipe = async (page: Page) => {
    // 저장된 상태에서 한 번 더 시작해야 "쓰던 브라우저"로 기록된다.
    await page.waitForTimeout(600)
    await page.reload()
    await expectScreen(page, term(page)).toMatch(/\$$/)
    await removeSaved(page, ['root', 'ready'])
  }

  test('says so instead of silently starting over, and points to the way back', async ({ page }) => {
    await typeIn(page, term(page), 'echo mine > mine.txt')
    await expectScreen(page, term(page)).toMatch(/mine\.txt\nguest@webos:~\$$/)
    await wipe(page)
    await page.reload()
    await expectScreen(page, term(page)).toMatch(/\$$/)

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('저장해 둔 파일을 찾을 수 없습니다')
    await expect(alert).toContainText('보관 폴더나 백업 파일이 있으면 설정에서 되살릴 수 있습니다')
    await alert.getByRole('button', { name: '설정 열기' }).click()
    await expect(settings(page)).toHaveClass(/focused/)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 한 번 알린 뒤에는 다시 알리지 않는다 (지금 상태가 새 출발점이다).
    await page.reload()
    await expectScreen(page, term(page)).toMatch(/\$$/)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('does not appear on a first visit or after a deliberate reset', async ({ page }) => {
    await expect(page.getByRole('alert')).toHaveCount(0)
    await launch(page, '설정')
    await settings(page).getByRole('button', { name: '처음 상태로 되돌리기…' }).click()
    await settings(page).getByRole('button', { name: '되돌리기', exact: true }).click()
    await expect(appWindow(page, 'settings')).toHaveCount(0)
    await expectScreen(page, term(page)).toMatch(/\$$/)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('can be dismissed', async ({ page }) => {
    await wipe(page)
    await page.reload()
    await expectScreen(page, term(page)).toMatch(/\$$/)
    await page.getByRole('alert').getByRole('button', { name: '닫기' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await typeIn(page, term(page), 'echo still-works')
    await expectScreen(page, term(page)).toContain('\nstill-works\n')
  })
})
