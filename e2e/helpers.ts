import { expect, type Locator, type Page } from '@playwright/test'

export const PROMPT = 'guest@webos:~$'

/** 입력을 받고 있는(맨 위) 창. 다른 창이 앞으로 오면 그 창을 가리키게 된다. */
export const focusedWindow = (page: Page) => page.locator('.window.focused')

/** 지금 맨 위에 있는 창을 고정해서 가리킨다. 나중에 다른 창이 앞으로 와도 같은 창이다. */
export async function pinWindow(page: Page) {
  const id = await focusedWindow(page).getAttribute('data-window')
  return page.locator(`.window[data-window="${id}"]`)
}

/** 터미널 창의 글자를 줄 단위로 읽는다. 창을 지정하지 않으면 맨 위 창을 읽는다. */
export const screen = (page: Page, win: Locator = focusedWindow(page)) =>
  win.locator('.terminal .line').evaluateAll((lines) =>
    lines
      .map((line) => line.textContent ?? '')
      .join('\n')
      .trimEnd(),
  )

export const expectScreen = (page: Page, win?: Locator) => expect.poll(() => screen(page, win))

/** 맨 위 터미널 창에 한 줄을 입력한다. */
export async function type(page: Page, line: string) {
  await focusedWindow(page).locator('.terminal textarea').focus()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

/** 왼쪽 레일에서 앱을 실행한다. */
export const launch = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click()

/**
 * 페이지를 열고 첫 터미널의 프롬프트가 뜰 때까지 기다린다.
 * 대부분의 테스트는 재방문 상태(안내 창 없음, 부팅 연출 없음)에서 시작한다.
 */
export async function boot(page: Page, options: { firstVisit?: boolean } = {}) {
  // 움직임 줄이기: 부팅 연출을 건너뛰고, 창이 열리는 애니메이션 도중에 위치를 재는 일도 없앤다.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (!options.firstVisit) await page.addInitScript(() => localStorage.setItem('webos.welcomed', '1'))
  await page.goto('/')
  await expectScreen(page, appWindow(page, 'terminal')).toMatch(/\$$/)
}

export async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element is not visible')
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
}

/** 요소의 한 지점을 잡아 (dx, dy)만큼 끈다. */
export async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, release = true) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 })
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 })
  if (release) await page.mouse.up()
}

/** 지정한 터미널 창을 앞으로 가져와 한 줄을 입력한다. */
export async function typeIn(page: Page, win: Locator, line: string) {
  await win.locator('.terminal textarea').focus()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

/** 다른 창에 가려진 창을 레일의 창 목록에서 골라 앞으로 가져온다. */
export async function raise(page: Page, title: string) {
  const tab = page.getByRole('button', { name: `창: ${title}`, exact: true })
  if (!(await tab.evaluate((el) => el.classList.contains('active')))) await tab.click()
}

export const appWindow = (page: Page, app: string) => page.locator(`.window[data-app="${app}"]`)

export const fileRow = (page: Page, name: string) =>
  appWindow(page, 'files').locator('.file-row').filter({ has: page.locator('.file-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })

/**
 * 브라우저 저장소의 맨 위 항목들을 지운다 (브라우저가 데이터를 지운 상황을 흉내 낼 때 쓴다).
 * 커널이 마침 그 파일에 쓰고 있으면 브라우저가 삭제를 거절하므로, 끝날 때까지 잠깐씩 기다리며 다시 시도한다.
 */
export const removeSaved = (page: Page, names: string[]) =>
  page.evaluate(async (names) => {
    const origin = await navigator.storage.getDirectory()
    for (const name of names) {
      for (let attempt = 0; ; attempt++) {
        try {
          await origin.removeEntry(name, { recursive: true })
          break
        } catch (e) {
          if (e instanceof DOMException && e.name === 'NotFoundError') break
          if (attempt >= 30) throw e
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }
  }, names)
