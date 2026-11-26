// 보관 폴더: 파일시스템 전체를 사용자의 로컬 폴더에도 저장한다.
// 운영체제의 폴더 선택 창은 자동화할 수 없으므로, 선택 창이 브라우저 저장소 안의 폴더를 돌려주도록
// 바꿔치기한다. 돌려받는 핸들의 종류와 쓰는 방법은 실제 로컬 폴더와 같다.
import { expect, test, type Page } from '@playwright/test'
import { appWindow, boot, expectScreen, launch, raise, removeSaved, typeIn } from './helpers.ts'

const term = (page: Page) => appWindow(page, 'terminal')
const settings = (page: Page) => appWindow(page, 'settings')
const status = (page: Page) => settings(page).getByLabel('보관 폴더 상태')

/** 선택 창이 돌려줄 폴더를 정한다. 'cancel'이면 사용자가 취소한 것처럼 동작한다. */
const stubPicker = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.showDirectoryPicker = async () => {
      const choice = (w.__pick as string | undefined) ?? 'backup'
      if (choice === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError')
      return (await navigator.storage.getDirectory()).getDirectoryHandle(choice, { create: true })
    }
  })

const pickNext = (page: Page, folder: string) =>
  page.evaluate((folder) => ((window as unknown as Record<string, unknown>).__pick = folder), folder)

/** 폴더에 직접 파일을 넣는다 (사용자가 탐색기에서 넣은 상황). */
const putOnDisk = (page: Page, folder: string, files: Record<string, string>) =>
  page.evaluate(
    async ({ folder, files }) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true })
      for (const [path, text] of Object.entries(files)) {
        const parts = path.split('/')
        const name = parts.pop()!
        let dir = root
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
        await writable.write(text)
        await writable.close()
      }
    },
    { folder, files },
  )

/** 폴더에 실제로 들어 있는 텍스트 파일들: 경로 → 내용. 실행 파일(/bin)은 이름만 센다. */
const onDisk = (page: Page, folder: string) =>
  page.evaluate(async (folder) => {
    const files: Record<string, string> = {}
    let programs = 0
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()
      for await (const [name, handle] of entries) {
        try {
          if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)
          else if (prefix === 'bin/') programs++
          else files[prefix + name] = await (await (handle as FileSystemFileHandle).getFile()).text()
        } catch (e) {
          // 훑는 사이에 커널이 그 파일을 지웠을 수 있다 (부팅 때 /tmp 를 비우는 경우 등). 없는 것으로 친다.
          if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e
        }
      }
    }
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(folder), '')
    return { files, programs }
  }, folder)

/** 설정을 열고 빈 폴더를 보관 폴더로 정한다. */
async function link(page: Page) {
  await launch(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  await expect(status(page)).toContainText('연결됨')
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await stubPicker(page)
  await boot(page)
})

test('linking an empty folder exports every directory, and later changes follow', async ({ page }) => {
  await typeIn(page, term(page), 'echo mine > note.txt && echo conf > /etc/custom && mkdir /data')
  await expectScreen(page, term(page)).toMatch(/mkdir \/data\nguest@webos:~\$$/)
  await link(page)
  await expect(status(page)).toContainText('backup')

  const first = await onDisk(page, 'backup')
  expect(first.files).toMatchObject({
    '.webos': 'Web OS archive v1\n',
    'etc/custom': 'conf\n',
    'home/guest/note.txt': 'mine\n',
  })
  expect(first.files['etc/motd']).toContain('Web OS')
  expect(first.files['home/guest/README.md']).toContain('환영합니다')
  // 실행 파일까지 모두 나간다. 가상 폴더인 /proc 은 나가지 않는다.
  expect(first.programs).toBe(33)
  expect(Object.keys(first.files).some((path) => path.startsWith('proc/'))).toBe(false)

  await typeIn(page, term(page), 'echo more >> note.txt; rm /etc/custom; echo t > /tmp/scratch; grep localdir /proc/mounts')
  await expectScreen(page, term(page)).toContain('\nlocaldir / rw,persistent\n')
  await expect
    .poll(async () => (await onDisk(page, 'backup')).files)
    .toMatchObject({ 'home/guest/note.txt': 'mine\nmore\n', 'tmp/scratch': 't\n' })
  expect((await onDisk(page, 'backup')).files).not.toHaveProperty('etc/custom')
})

test('refuses a folder that already holds other files', async ({ page }) => {
  await putOnDisk(page, 'backup', { 'my-photo.txt': 'precious' })
  await launch(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  await expect(settings(page).getByRole('alert')).toContainText('빈 폴더를 골라 주세요')
  await expect(status(page)).toHaveCount(0)
  // 사용자의 파일은 손대지 않았다.
  expect((await onDisk(page, 'backup')).files).toEqual({ 'my-photo.txt': 'precious' })
})

test('cancelling the folder picker changes nothing', async ({ page }) => {
  await pickNext(page, 'cancel')
  await launch(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  await expect(settings(page).getByRole('button', { name: '보관 폴더 정하기…' })).toBeVisible()
  await expect(settings(page).getByRole('alert')).toHaveCount(0)
  await expect(status(page)).toHaveCount(0)
})

test('stays linked across reloads and keeps saving', async ({ page }) => {
  await link(page)
  await typeIn(page, term(page), 'echo one > log.txt')
  await expect.poll(async () => (await onDisk(page, 'backup')).files['home/guest/log.txt']).toBe('one\n')

  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await launch(page, '설정')
  await expect(status(page)).toContainText('연결됨')
  await typeIn(page, term(page), 'echo two >> log.txt')
  await expect.poll(async () => (await onDisk(page, 'backup')).files['home/guest/log.txt']).toBe('one\ntwo\n')
})

test('picking an old archive folder again merges the two sides without asking when nothing conflicts', async ({ page }) => {
  await link(page)
  await raise(page, '설정')
  await settings(page).getByRole('button', { name: '연결 해제' }).click()
  await expect(status(page)).toHaveCount(0)
  // 끊겨 있는 동안 브라우저에서 새로 만든 것과, 그사이 폴더에 직접 넣어 둔 것
  await typeIn(page, term(page), 'cd /; mkdir work; echo offline > work/offline.txt; cd')
  await expectScreen(page, term(page)).toMatch(/cd\nguest@webos:~\$$/)
  await putOnDisk(page, 'backup', { 'home/guest/from-disk.txt': 'added outside', 'photos/a.txt': 'picture' })

  await raise(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  // 내용이 다른 파일이 없으므로 묻지 않고 합친다. 화면도 다시 열리지 않는다.
  await expect(status(page)).toContainText('연결됨')
  await expect(settings(page).getByRole('alertdialog')).toHaveCount(0)
  await typeIn(page, term(page), 'cat from-disk.txt /photos/a.txt')
  await expectScreen(page, term(page)).toContain('a.txt\nadded outsidepicture')
  await expect.poll(async () => (await onDisk(page, 'backup')).files['work/offline.txt']).toBe('offline\n')
  // 연결한 뒤로는 브라우저 쪽이 기준이다: 지우면 폴더에서도 지워진다.
  await typeIn(page, term(page), 'rm from-disk.txt')
  await expect.poll(async () => Object.keys((await onDisk(page, 'backup')).files)).not.toContain('home/guest/from-disk.txt')
})

test('when files differ it asks which side wins, and still merges the rest', async ({ page }) => {
  await link(page)
  // 연결이 끊겨 있는 동안 브라우저에서 바꾼 것과, 그사이 폴더에 직접 손댄 것
  await raise(page, '설정')
  await settings(page).getByRole('button', { name: '연결 해제' }).click()
  await expect(status(page)).toHaveCount(0)
  await typeIn(page, term(page), 'echo offline > offline.txt; rm hello.sh')
  await expectScreen(page, term(page)).toMatch(/rm hello\.sh\nguest@webos:~\$$/)
  await putOnDisk(page, 'backup', { 'home/guest/README.md': 'edited outside', 'stray.txt': 'added outside' })

  await raise(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  const choice = settings(page).getByRole('alertdialog', { name: '보관 폴더의 내용 선택' })
  await expect(choice).toContainText('양쪽에 내용이 다른 파일이 있습니다')
  await choice.getByRole('button', { name: '브라우저의 것으로' }).click()
  await expect(status(page)).toContainText('연결됨')

  // 내용이 다른 파일(README)은 브라우저의 것으로. 한쪽에만 있는 것은 서로 넘어간다:
  // 폴더에 넣어 둔 것은 들어오고, 브라우저에서 지웠지만 폴더에 남아 있던 것도 돌아온다.
  await expect.poll(async () => (await onDisk(page, 'backup')).files['home/guest/offline.txt']).toBe('offline\n')
  const { files } = await onDisk(page, 'backup')
  expect(files['home/guest/README.md']).toContain('환영합니다')
  expect(files['stray.txt']).toBe('added outside')
  expect(Object.keys(files)).toContain('home/guest/hello.sh')
  await typeIn(page, term(page), 'cat /stray.txt; ls')
  await expectScreen(page, term(page)).toContain('added outsideREADME.md  hello.sh  offline.txt\n')
})

test('loading from the folder brings back everything after the browser data is lost', async ({ page }) => {
  await typeIn(page, term(page), 'echo irreplaceable > thesis.txt && echo mine >> README.md && echo conf > /etc/custom')
  await expectScreen(page, term(page)).toMatch(/custom\nguest@webos:~\$$/)
  await link(page)
  await expect.poll(async () => (await onDisk(page, 'backup')).files['home/guest/thesis.txt']).toBe('irreplaceable\n')

  // 브라우저의 데이터가 지워진 상황: 저장된 파일과, 폴더를 기억해 둔 것까지 모두 사라진다.
  await removeSaved(page, ['root', 'ready'])
  await page.evaluate(() => indexedDB.deleteDatabase('webos'))
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'ls')
  await expectScreen(page, term(page)).toContain('ls\nREADME.md  hello.sh\n')

  await launch(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  // 새로 깔린 기본 파일(README)이 폴더의 것과 다르므로 어느 쪽 것으로 할지 묻는다.
  await settings(page).getByRole('button', { name: '폴더의 것으로' }).click()

  // 화면이 다시 열리고, 폴더에 있던 내용으로 돌아온다. 연결도 이어진다.
  await expect(appWindow(page, 'settings')).toHaveCount(0)
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'cat thesis.txt /etc/custom; tail -n 1 README.md; hello | head -n 1')
  await expectScreen(page, term(page)).toContain('head -n 1\nirreplaceable\nconf\nmine\nHello from a real WASM process!\n')
  await launch(page, '설정')
  await expect(status(page)).toContainText('연결됨')
  // 다시 열어도 그대로다 (불러온 내용이 브라우저 저장소에도 들어갔다).
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'cat thesis.txt')
  await expectScreen(page, term(page)).toContain('cat thesis.txt\nirreplaceable\n')
})

test('the choice can be cancelled without touching either side', async ({ page }) => {
  await link(page)
  await settings(page).getByRole('button', { name: '연결 해제' }).click()
  await typeIn(page, term(page), 'echo local-only > local.txt; echo changed >> README.md')
  await expectScreen(page, term(page)).toMatch(/README\.md\nguest@webos:~\$$/)
  await raise(page, '설정')
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  await settings(page).getByRole('alertdialog').getByRole('button', { name: '취소' }).click()
  await expect(status(page)).toHaveCount(0)
  expect(Object.keys((await onDisk(page, 'backup')).files)).not.toContain('home/guest/local.txt')
  await typeIn(page, term(page), 'cat local.txt')
  await expectScreen(page, term(page)).toContain('cat local.txt\nlocal-only\n')
})

test('refuses to read a folder over the limit, until the limit is raised', async ({ page }) => {
  await link(page)
  await settings(page).getByRole('button', { name: '연결 해제' }).click()
  // 기본 한도(파일 2천 개)를 넘도록 폴더에 파일이 잔뜩 들어간 상황
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('backup')
    const junk = await root.getDirectoryHandle('junk', { create: true })
    await Promise.all(Array.from({ length: 2001 }, (_, i) => junk.getFileHandle(`f${i}`, { create: true })))
  })
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  await expect(settings(page).getByRole('alert')).toContainText('폴더가 너무 큽니다 (파일 2,001개 이상')
  await expect(settings(page).getByRole('alert')).toContainText('지금 한도는 100MB · 파일 2천 개입니다')
  // 불러오지 않았으므로 지금 내용은 그대로다.
  await typeIn(page, term(page), 'ls / | wc -l')
  await expectScreen(page, term(page)).toContain('wc -l\n6\n')

  await raise(page, '설정')
  await settings(page).getByRole('button', { name: '500MB · 파일 1만 개' }).click()
  await settings(page).getByRole('button', { name: '보관 폴더 정하기…' }).click()
  // 폴더에만 있는 파일들이므로 묻지 않고 가져온다.
  await expect(status(page)).toContainText('연결됨')
  await typeIn(page, term(page), 'ls /junk | wc -l')
  await expectScreen(page, term(page)).toContain('wc -l\n2001\n')
})

test('resetting to the first state also drops the link, but not the folder', async ({ page }) => {
  await typeIn(page, term(page), 'echo kept-on-disk > keep.txt')
  await expectScreen(page, term(page)).toMatch(/keep\.txt\nguest@webos:~\$$/)
  await link(page)
  await settings(page).getByRole('button', { name: '처음 상태로 되돌리기…' }).click()
  await settings(page).getByRole('button', { name: '되돌리기', exact: true }).click()

  await expect(appWindow(page, 'settings')).toHaveCount(0)
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await typeIn(page, term(page), 'ls')
  await expectScreen(page, term(page)).toContain('ls\nREADME.md  hello.sh\n')
  // 연결이 남아 있었다면 폴더의 예전 내용이 되살아나거나, 초기 상태가 폴더를 덮어썼을 것이다.
  await launch(page, '설정')
  await expect(status(page)).toHaveCount(0)
  expect((await onDisk(page, 'backup')).files['home/guest/keep.txt']).toBe('kept-on-disk\n')
})

test('is unavailable where the browser cannot do it', async ({ page }) => {
  await page.addInitScript(() => delete (window as unknown as Record<string, unknown>).showDirectoryPicker)
  await page.reload()
  await expectScreen(page, term(page)).toMatch(/\$$/)
  await launch(page, '설정')
  await expect(settings(page)).toContainText('이 브라우저는 컴퓨터의 폴더에 보관하는 기능을 지원하지 않습니다')
  await expect(settings(page).getByRole('button', { name: '보관 폴더 정하기…' })).toHaveCount(0)
})
