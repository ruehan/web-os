// 파일 탐색기. 커널의 파일시스템을 둘러보고, 만들고, 이름을 바꾸고, 지운다.
import { For, Show, createEffect, createSignal } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { FsEntry } from '../../kernel/abi.ts'
import { Errno } from '../../kernel/errno.ts'
import { FileIcon, FolderIcon, UpIcon } from '../icons.tsx'
import { basename, crumbs, dirname, formatSize, join } from '../path.ts'
import { FsError } from '../system.ts'
import type { AppProps } from './registry.tsx'

/** 새로 만들 수 있는 파일 형식과 처음 넣어 둘 내용 */
const FILE_TYPES = [
  { name: '텍스트', ext: '.txt', content: '' },
  { name: '마크다운', ext: '.md', content: '' },
  { name: 'JSON', ext: '.json', content: '{}\n' },
  { name: '셸 스크립트', ext: '.sh', content: '' },
  { name: 'CSV', ext: '.csv', content: '' },
]

export function FilesApp(props: AppProps) {
  const fs = props.system.fs
  const [cwd, setCwd] = createSignal(props.args.path ?? '/home/guest')
  const [entries, setEntries] = createStore<FsEntry[]>([])
  const [selected, setSelected] = createSignal<string | null>(null)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const [error, setError] = createSignal('')
  const [dropping, setDropping] = createSignal(false)
  /** 새 파일의 형식을 고르는 중인가 */
  const [choosingType, setChoosingType] = createSignal(false)
  let list!: HTMLUListElement
  let latest = 0

  const current = () => entries.find((e) => e.name === selected())

  /** 항목을 고른다. 이전 작업의 오류 안내는 더 볼 필요가 없으므로 지운다. */
  function select(name: string | null) {
    setError('')
    setConfirmingDelete(false)
    setSelected(name)
  }

  async function refresh() {
    const request = ++latest
    const path = cwd()
    try {
      // 점으로 시작하는 파일(셸 이력 등)은 숨긴다.
      const found = (await fs.list(path)).filter((e) => !e.name.startsWith('.'))
      if (request !== latest) return // 더 새로운 요청이 이미 나갔다
      // 폴더 먼저, 그다음 이름순
      found.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ko'))
      // 이름이 같은 항목은 기존 줄을 그대로 둔다. 줄을 새로 만들면 이름을 고치던 입력창이 사라진다.
      setEntries(reconcile(found, { key: 'name' }))
      if (!found.some((e) => e.name === selected())) setSelected(null)
    } catch (e) {
      // 보고 있던 폴더가 지워졌으면 위로 올라간다.
      if (e instanceof FsError && (e.errno === Errno.NOENT || e.errno === Errno.NOTDIR) && path !== '/') {
        setCwd(dirname(path))
      } else report(e)
    }
  }

  // 폴더를 옮기거나, 터미널 등 다른 곳에서 파일이 바뀌면 목록을 다시 읽는다.
  createEffect(() => {
    cwd()
    props.system.fsVersion()
    void refresh()
  })
  createEffect(() => props.setTitle(cwd() === '/' ? '/' : basename(cwd())))

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  /** 파일 작업을 실행하고, 실패하면 창 아래에 이유를 보여 준다. */
  async function attempt(action: () => Promise<void>) {
    setError('')
    try {
      await action()
    } catch (e) {
      report(e)
    }
    await refresh()
  }

  function go(path: string) {
    setSelected(null)
    setRenaming(null)
    setConfirmingDelete(false)
    setChoosingType(false)
    setError('')
    setCwd(path)
  }

  function open(entry: FsEntry) {
    if (entry.dir) go(join(cwd(), entry.name))
    else props.launch('editor', { path: join(cwd(), entry.name) })
  }

  /** "새 폴더", "새 폴더 2", ... 중 아직 없는 이름 */
  function freshName(base: string, ext = '') {
    const taken = new Set(entries.map((e) => e.name))
    for (let n = 1; ; n++) {
      const name = `${base}${n > 1 ? ` ${n}` : ''}${ext}`
      if (!taken.has(name)) return name
    }
  }

  const create = (name: string, make: (path: string) => Promise<void>) =>
    attempt(async () => {
      await make(join(cwd(), name))
      await refresh()
      setSelected(name)
      setRenaming(name) // 만들자마자 이름을 고칠 수 있게 한다
    })

  function rename(from: string, to: string) {
    setRenaming(null)
    list.focus()
    if (!to || to === from) return
    if (to.includes('/')) return setError('이름에는 / 를 쓸 수 없습니다.')
    void attempt(async () => {
      await fs.rename(join(cwd(), from), join(cwd(), to))
      setSelected(to)
    })
  }

  function remove() {
    const name = selected()
    setConfirmingDelete(false)
    if (name) void attempt(() => fs.remove(join(cwd(), name)))
  }

  /** 컴퓨터에서 끌어다 놓은 파일을 현재 폴더에 올린다 (직접 컴파일한 .wasm 도 이렇게 넣는다). */
  function upload(files: FileList) {
    void attempt(async () => {
      for (const file of files) {
        await fs.write(join(cwd(), file.name), new Uint8Array(await file.arrayBuffer()))
      }
    })
  }

  function onKeyDown(e: KeyboardEvent) {
    if (renaming()) return
    const names = entries.map((entry) => entry.name)
    const index = names.indexOf(selected() ?? '')
    const entry = current()
    if (e.key === 'ArrowDown') select(names[Math.min(names.length - 1, index + 1)] ?? null)
    else if (e.key === 'ArrowUp') select(names[Math.max(0, index - 1)] ?? null)
    else if (e.key === 'Enter' && entry) open(entry)
    else if (e.key === 'F2' && entry) setRenaming(entry.name)
    else if ((e.key === 'Delete' || e.key === 'Backspace') && entry) setConfirmingDelete(true)
    else if (e.key === 'Escape') setConfirmingDelete(false)
    else return
    e.preventDefault()
  }

  return (
    <div
      class="files"
      classList={{ dropping: dropping() }}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        if (e.dataTransfer?.files.length) upload(e.dataTransfer.files)
      }}
    >
      <div class="toolbar">
        <button class="tool icon" aria-label="위 폴더로" disabled={cwd() === '/'} onClick={() => go(dirname(cwd()))}>
          <UpIcon />
        </button>
        <nav class="crumbs" aria-label="현재 위치">
          <For each={crumbs(cwd())}>
            {(crumb) => (
              <button class="crumb" onClick={() => go(crumb.path)}>
                {crumb.name}
              </button>
            )}
          </For>
        </nav>
        <button class="tool" onClick={() => create(freshName('새 폴더'), fs.mkdir)}>
          새 폴더
        </button>
        <button class="tool" aria-expanded={choosingType()} onClick={() => setChoosingType((v) => !v)}>
          새 파일
        </button>
      </div>
      <Show when={choosingType()}>
        <div class="toolbar type-bar" role="group" aria-label="새 파일의 형식">
          <For each={FILE_TYPES}>
            {(type) => (
              <button
                class="tool"
                onClick={() => {
                  setChoosingType(false)
                  void create(freshName('새 파일', type.ext), (path) => fs.write(path, new TextEncoder().encode(type.content)))
                }}
              >
                {type.name} <span class="type-ext">{type.ext}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <ul class="file-list" ref={list} tabindex="0" role="listbox" aria-label="파일 목록" onKeyDown={onKeyDown}>
        <For each={entries} fallback={<li class="file-empty">비어 있는 폴더입니다. 파일을 끌어다 놓으면 여기에 올라갑니다.</li>}>
          {(entry) => (
            <li
              class="file-row"
              role="option"
              aria-selected={selected() === entry.name}
              onClick={() => select(entry.name)}
              onDblClick={() => renaming() || open(entry)}
            >
              <span class="file-icon" classList={{ dir: entry.dir }}>
                {entry.dir ? <FolderIcon /> : <FileIcon />}
              </span>
              <Show when={renaming() === entry.name} fallback={<span class="file-name">{entry.name}</span>}>
                <input
                  class="file-rename"
                  aria-label="새 이름"
                  value={entry.name}
                  ref={(el) =>
                    queueMicrotask(() => {
                      el.focus()
                      // 확장자는 남기고 이름 부분만 선택한다.
                      const dot = entry.dir ? -1 : entry.name.lastIndexOf('.')
                      el.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
                    })
                  }
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') rename(entry.name, e.currentTarget.value.trim())
                    else if (e.key === 'Escape') rename(entry.name, entry.name)
                  }}
                  onBlur={(e) => renaming() === entry.name && rename(entry.name, e.currentTarget.value.trim())}
                />
              </Show>
              <span class="file-size">{entry.dir ? `항목 ${entry.size}개` : formatSize(entry.size)}</span>
            </li>
          )}
        </For>
      </ul>

      <footer class="statusbar">
        <Show
          when={!error()}
          fallback={
            <span class="status-error" role="alert">
              {error()}
            </span>
          }
        >
          <Show when={current()} fallback={<span>항목 {entries.length}개</span>}>
            {(entry) => (
              <Show
                when={confirmingDelete()}
                fallback={
                  <>
                    <span class="status-name">{entry().name}</span>
                    <button class="tool" onClick={() => setRenaming(entry().name)}>
                      이름 바꾸기
                    </button>
                    <button class="tool" onClick={() => setConfirmingDelete(true)}>
                      삭제
                    </button>
                  </>
                }
              >
                <span class="status-name">
                  “{entry().name}”{entry().dir && entry().size > 0 ? `과 그 안의 항목 ${entry().size}개` : ''}을(를) 지울까요?
                </span>
                <button class="tool danger" onClick={remove}>
                  지우기
                </button>
                <button class="tool" onClick={() => setConfirmingDelete(false)}>
                  취소
                </button>
              </Show>
            )}
          </Show>
        </Show>
      </footer>
    </div>
  )
}
