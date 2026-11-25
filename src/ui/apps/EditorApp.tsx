// 텍스트 편집기. 파일 하나를 열어 고치고 저장한다.
import { Match, Show, Switch, createEffect, createSignal, onMount } from 'solid-js'
import { CodeArea } from '../editor/CodeArea.tsx'
import { languageOf } from '../editor/highlight.ts'
import { Preview, previewable } from '../editor/Preview.tsx'
import { basename } from '../path.ts'
import type { AppProps } from './registry.tsx'

type Status = 'loading' | 'ready' | 'binary' | 'failed'
/** 창 아래에 띄우는 물음: 저장할 위치, 또는 저장하지 않고 닫을지 */
type Prompt = null | 'save-as' | 'close'

const DEFAULT_PATH = '/home/guest/제목 없음.txt'

export function EditorApp(props: AppProps) {
  const fs = props.system.fs
  const [path, setPath] = createSignal(props.args.path ?? '')
  const [text, setText] = createSignal('')
  /** 마지막으로 저장된(또는 읽어 온) 내용 */
  const [saved, setSaved] = createSignal('')
  const [status, setStatus] = createSignal<Status>(path() ? 'loading' : 'ready')
  const [prompt, setPrompt] = createSignal<Prompt>(null)
  const [error, setError] = createSignal('')
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 })
  let area: HTMLTextAreaElement | undefined

  const dirty = () => status() === 'ready' && text() !== saved()
  /** 파일 이름의 확장자에 따라 색상 강조와 미리보기가 달라진다. */
  const lang = () => languageOf(path())
  const [previewing, setPreviewing] = createSignal(false)
  const showPreview = () => previewing() && previewable(lang())
  const bytes = () => new TextEncoder().encode(text()).length

  onMount(async () => {
    if (!path()) return area?.focus()
    try {
      const data = await fs.read(path())
      // 텍스트가 아닌 파일(실행 파일 등)을 열어 저장하면 내용이 망가지므로 편집하지 않는다.
      if (data.includes(0)) return setStatus('binary')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data)
      setText(content)
      setSaved(content)
      setStatus('ready')
    } catch (e) {
      if (e instanceof TypeError) return setStatus('binary')
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    }
  })

  createEffect(() => props.setTitle(`${path() ? basename(path()) : '제목 없음'}${dirty() ? ' •' : ''}`))
  createEffect(() => props.focused() && !prompt() && !showPreview() && area?.focus())

  // 저장하지 않은 내용이 있으면 닫기 전에 묻는다.
  props.guardClose(() => {
    if (!dirty()) return true
    setPrompt('close')
    return false
  })

  /** 저장에 성공하면 true */
  async function save(target = path()): Promise<boolean> {
    if (!target) {
      setPrompt('save-as')
      return false
    }
    try {
      const content = text()
      await fs.write(target, new TextEncoder().encode(content))
      setPath(target)
      setSaved(content)
      setError('')
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  async function saveAs(target: string, thenClose: boolean) {
    if (!target.startsWith('/')) return setError('/ 로 시작하는 전체 경로를 적어 주세요.')
    if (!(await save(target))) return
    setPrompt(null)
    if (thenClose) props.close()
  }

  async function saveAndClose() {
    if (!path()) return setPrompt('save-as')
    if (await save()) props.close()
  }

  function trackCursor(el = area) {
    if (!el) return
    area = el
    const before = el.value.slice(0, el.selectionStart)
    const line = before.split('\n').length
    setCursor({ line, column: before.length - before.lastIndexOf('\n') })
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab' && !e.shiftKey && area) {
      // Tab은 포커스를 옮기지 않고 들여쓰기를 넣는다.
      e.preventDefault()
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end')
      setText(area.value)
      trackCursor()
    }
  }

  // "닫으려다 저장 위치를 물은" 경우에는 저장 후 창을 닫는다.
  let closeAfterSave = false

  return (
    <div class="editor" onKeyDown={onKeyDown}>
      <Switch>
        <Match when={status() === 'loading'}>
          <p class="editor-note">여는 중…</p>
        </Match>
        <Match when={status() === 'binary'}>
          <p class="editor-note">
            <strong>{basename(path())}</strong> 은(는) 텍스트 파일이 아니라서 편집할 수 없습니다.
            <br />
            실행 파일이라면 터미널에서 경로를 입력해 실행할 수 있습니다.
          </p>
        </Match>
        <Match when={status() === 'failed'}>
          <p class="editor-note status-error" role="alert">
            {error()}
          </p>
        </Match>
        <Match when={status() === 'ready'}>
          <Show when={previewable(lang())}>
            <div class="toolbar">
              <div class="segmented" role="group" aria-label="보기 방식">
                <button aria-pressed={!previewing()} onClick={() => setPreviewing(false)}>
                  편집
                </button>
                <button aria-pressed={previewing()} onClick={() => setPreviewing(true)}>
                  미리보기
                </button>
              </div>
            </div>
          </Show>
          <Show
            when={showPreview()}
            fallback={
              <CodeArea
                ref={(el) => (area = el)}
                label="파일 내용"
                lang={lang()}
                value={text()}
                onInput={setText}
                onCursor={trackCursor}
              />
            }
          >
            <Preview text={text()} lang={lang() as 'markdown'} />
          </Show>

          <Show when={prompt() === 'save-as'}>
            <form
              class="promptbar"
              onSubmit={(e) => {
                e.preventDefault()
                void saveAs(new FormData(e.currentTarget).get('path')!.toString().trim(), closeAfterSave)
              }}
            >
              <label for="save-path">저장할 위치</label>
              <input id="save-path" name="path" value={DEFAULT_PATH} ref={(el) => queueMicrotask(() => el.select())} />
              <button class="tool primary" type="submit">
                저장
              </button>
              <button class="tool" type="button" onClick={() => (setPrompt(null), setError(''), (closeAfterSave = false))}>
                취소
              </button>
            </form>
          </Show>
          <Show when={prompt() === 'close'}>
            <div class="promptbar" role="alertdialog" aria-label="저장하지 않은 변경">
              <span class="prompt-text">저장하지 않은 변경이 있습니다.</span>
              <button
                class="tool primary"
                onClick={() => {
                  closeAfterSave = true
                  void saveAndClose()
                }}
              >
                저장하고 닫기
              </button>
              <button class="tool danger" onClick={() => props.close()}>
                저장 안 함
              </button>
              <button class="tool" onClick={() => setPrompt(null)}>
                취소
              </button>
            </div>
          </Show>

          <footer class="statusbar">
            <Show
              when={!error()}
              fallback={
                <span class="status-error" role="alert">
                  {error()}
                </span>
              }
            >
              <span class="status-name">{path() || '아직 저장하지 않은 파일'}</span>
            </Show>
            <span>
              {cursor().line}:{cursor().column}
            </span>
            <span>{bytes()}바이트</span>
            <button class="tool" disabled={!dirty() && !!path()} onClick={() => void save()}>
              저장
            </button>
          </footer>
        </Match>
      </Switch>
    </div>
  )
}
