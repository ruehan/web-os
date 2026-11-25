// 메모. 파일 이름이나 위치를 신경 쓰지 않고 바로 적는다. 적는 대로 저장되고,
// 메모 하나는 홈의 notes 폴더에 파일 하나로 남는다 (터미널이나 파일 탐색기에서도 보인다).
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Errno } from '../../kernel/errno.ts'
import { CodeArea } from '../editor/CodeArea.tsx'
import { languageOf } from '../editor/highlight.ts'
import { Preview, previewable } from '../editor/Preview.tsx'
import { FsError } from '../system.ts'
import type { AppProps } from './registry.tsx'

const DIR = '/home/guest/notes'
/** 마지막 입력 뒤 이만큼 지나면 저장한다. */
const SAVE_DELAY_MS = 400

const FORMATS = [
  { ext: 'md', name: '마크다운 (.md)' },
  { ext: 'txt', name: '텍스트 (.txt)' },
] as const

interface Note {
  /** 파일 이름. 만든 시각으로 짓기 때문에 이름순이 곧 만든 순서다. */
  name: string
  text: string
}

/** 목록에 보여 줄 제목: 첫 줄에서 마크다운 제목 표시(#)를 뗀 것 */
function titleOf(note: Note): string {
  const first = note.text.split('\n').find((line) => line.trim() !== '') ?? ''
  return first.replace(/^#+\s*/, '').trim() || '빈 메모'
}

/** 제목 다음에 오는 첫 내용 한 줄 */
function excerptOf(note: Note): string {
  const lines = note.text.split('\n').filter((line) => line.trim() !== '')
  return (lines[1] ?? '').trim()
}

const stamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

export function NotesApp(props: AppProps) {
  const fs = props.system.fs
  const [notes, setNotes] = createStore<Note[]>([])
  const [current, setCurrent] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal('')
  const [format, setFormat] = createSignal<(typeof FORMATS)[number]['ext']>('md')
  const [previewing, setPreviewing] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')
  let area: HTMLTextAreaElement | undefined
  /** 아직 저장하지 않은 메모들: 이름 → 저장 타이머 */
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  let latest = 0

  const note = () => notes.find((n) => n.name === current())
  const lang = () => (current() ? languageOf(current()!) : undefined)
  const visible = createMemo(() => {
    const q = query().trim().toLowerCase()
    return q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes
  })

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  async function load() {
    const request = ++latest
    try {
      await fs.mkdir(DIR).catch((e) => {
        if (!(e instanceof FsError && e.errno === Errno.EXIST)) throw e
      })
      const files = (await fs.list(DIR)).filter((e) => !e.dir && !e.name.startsWith('.'))
      const loaded = await Promise.all(
        files.map(async (file) => ({ name: file.name, text: new TextDecoder().decode(await fs.read(`${DIR}/${file.name}`)) })),
      )
      if (request !== latest) return
      // 지금 치고 있어서 아직 저장하지 않은 메모는 화면의 내용이 더 새것이다.
      // 방금 만들어서 파일이 아직 없는 메모도 여기서 사라지면 안 된다. (정렬: 최근에 만든 것이 위로)
      for (const name of pending.keys()) {
        const unsaved = notes.find((n) => n.name === name)
        if (!unsaved) continue
        const onDisk = loaded.find((item) => item.name === name)
        if (onDisk) onDisk.text = unsaved.text
        else loaded.push({ name, text: unsaved.text })
      }
      loaded.sort((a, b) => b.name.localeCompare(a.name))
      setNotes(reconcile(loaded, { key: 'name' }))
      if (!loaded.some((n) => n.name === current())) setCurrent(loaded[0]?.name ?? null)
    } catch (e) {
      report(e)
    }
  }

  // 처음 열 때와, 터미널 등 다른 곳에서 메모 파일이 바뀔 때 다시 읽는다.
  createEffect(() => {
    props.system.fsVersion()
    void load()
  })

  async function save(name: string) {
    pending.delete(name)
    const text = notes.find((n) => n.name === name)?.text
    if (text === undefined) return
    try {
      await fs.write(`${DIR}/${name}`, new TextEncoder().encode(text))
      setError('')
    } catch (e) {
      report(e)
    }
    setSaving(pending.size > 0)
  }

  function edit(text: string) {
    const name = current()
    if (!name) return
    setNotes((n) => n.name === name, 'text', text)
    clearTimeout(pending.get(name))
    pending.set(name, setTimeout(() => void save(name), SAVE_DELAY_MS))
    setSaving(true)
  }

  // 창을 닫을 때 아직 저장하지 않은 것이 있으면 바로 저장한다.
  onCleanup(() => {
    for (const [name, timer] of pending) {
      clearTimeout(timer)
      void save(name)
    }
  })

  function select(name: string) {
    setCurrent(name)
    setConfirmingDelete(false)
    setPreviewing(false)
  }

  function create() {
    let name = `${stamp()}.${format()}`
    for (let n = 2; notes.some((x) => x.name === name); n++) name = `${stamp()}-${n}.${format()}`
    // 파일이 만들어지기를 기다리지 않고 바로 적을 수 있게 한다. 기다리는 사이에 친 글자가
    // 갈 곳이 없거나 이전 메모에 들어가면 안 된다. 파일은 뒤에서 만들어지고, 내용은 자동 저장이 채운다.
    setNotes((list) => [{ name, text: '' }, ...list])
    setQuery('')
    select(name)
    queueMicrotask(() => area?.focus())
    pending.set(name, setTimeout(() => void save(name), 0))
  }

  async function remove() {
    const name = current()
    setConfirmingDelete(false)
    if (!name) return
    clearTimeout(pending.get(name))
    pending.delete(name)
    try {
      await fs.remove(`${DIR}/${name}`)
      const rest = notes.filter((n) => n.name !== name)
      setNotes(reconcile(rest, { key: 'name' }))
      setCurrent(rest[0]?.name ?? null)
    } catch (e) {
      report(e)
    }
  }

  return (
    <div class="notes">
      <aside class="notes-side">
        <div class="toolbar">
          <button class="tool primary" onClick={create}>
            새 메모
          </button>
          <select class="tool" aria-label="새 메모의 형식" value={format()} onChange={(e) => setFormat(e.currentTarget.value as 'md')}>
            <For each={FORMATS}>{(f) => <option value={f.ext}>{f.name}</option>}</For>
          </select>
        </div>
        <input
          class="notes-search"
          type="search"
          aria-label="메모 찾기"
          placeholder="메모 찾기"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <ul class="notes-list" role="listbox" aria-label="메모 목록">
          <For
            each={visible()}
            fallback={<li class="notes-empty">{notes.length ? '찾는 내용이 든 메모가 없습니다.' : '아직 메모가 없습니다.'}</li>}
          >
            {(item) => (
              <li
                class="notes-item"
                role="option"
                tabindex="0"
                aria-selected={current() === item.name}
                onClick={() => select(item.name)}
                onKeyDown={(e) => e.key === 'Enter' && select(item.name)}
              >
                <span class="notes-title">{titleOf(item)}</span>
                <span class="notes-excerpt">{excerptOf(item) || item.name}</span>
              </li>
            )}
          </For>
        </ul>
      </aside>

      <section class="notes-main">
        <Show when={note()} fallback={<p class="editor-note">“새 메모”를 눌러 적기 시작하세요.</p>}>
          {(open) => (
            <>
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
                when={previewing() && previewable(lang())}
                fallback={
                  <CodeArea ref={(el) => (area = el)} label="메모 내용" lang={lang()} value={open().text} onInput={edit} />
                }
              >
                <Preview text={open().text} lang={lang() as 'markdown'} />
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
                  <span class="status-name">
                    notes/{open().name} · {saving() ? '저장 중…' : '저장됨'}
                  </span>
                </Show>
                <Show
                  when={confirmingDelete()}
                  fallback={
                    <button class="tool" onClick={() => setConfirmingDelete(true)}>
                      삭제
                    </button>
                  }
                >
                  <span>이 메모를 지울까요?</span>
                  <button class="tool danger" onClick={remove}>
                    지우기
                  </button>
                  <button class="tool" onClick={() => setConfirmingDelete(false)}>
                    취소
                  </button>
                </Show>
              </footer>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}
