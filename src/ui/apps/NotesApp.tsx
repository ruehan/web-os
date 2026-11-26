// 메모 보관함. 폴더로 정리한 마크다운 메모를 [[링크]]로 서로 잇고, 그림을 함께 보관한다.
// 메모와 그림은 모두 홈의 notes 폴더 아래의 실제 파일이라 터미널, 파일 탐색기, 보관 폴더, 백업에서도 그대로 보인다.
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, onCleanup, type JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Errno } from '../../kernel/errno.ts'
import { CodeArea } from '../editor/CodeArea.tsx'
import { languageOf } from '../editor/highlight.ts'
import { toggleTask } from '../editor/markdown.ts'
import { Preview, type PreviewContext } from '../editor/Preview.tsx'
import { FileIcon, FolderIcon, NoteIcon } from '../icons.tsx'
import {
  ATTACHMENTS,
  VAULT,
  baseOf,
  dirOf,
  extOf,
  extensionForType,
  imageTypeOf,
  isLegacyName,
  joinPath,
  kindOf,
  nameProblem,
  parseLinks,
  renameLinks,
  resolveLink,
  stemOf,
  titleFromText,
  uniqueName,
  type FileKind,
} from '../notes/vault.ts'
import { FsError } from '../system.ts'
import type { AppProps } from './registry.tsx'

/** 마지막 입력 뒤 이만큼 지나면 저장한다. */
const SAVE_DELAY_MS = 400
/** 그림 하나의 최대 크기. 보관함 전체가 메모리에 올라가므로 지나치게 큰 파일은 받지 않는다. */
const IMAGE_LIMIT = 20 * 1024 * 1024

const FORMATS = [
  { ext: 'md', name: '마크다운 (.md)' },
  { ext: 'txt', name: '텍스트 (.txt)' },
] as const

type Mode = 'edit' | 'split' | 'read'
const MODES: { id: Mode; name: string }[] = [
  { id: 'edit', name: '편집' },
  { id: 'split', name: '나란히' },
  { id: 'read', name: '읽기' },
]

/** 보관함 안의 폴더나 파일. path는 보관함 기준이다. */
interface Entry {
  path: string
  kind: 'dir' | FileKind
}

const absolute = (path: string) => (path ? `${VAULT}/${path}` : VAULT)

const stamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

export function NotesApp(props: AppProps) {
  const fs = props.system.fs
  const [entries, setEntries] = createStore<Entry[]>([])
  /** 메모의 내용: 경로 → 글 */
  const [texts, setTexts] = createStore<Record<string, string>>({})
  /** 열어 둔 파일 (메모 또는 그림) */
  const [current, setCurrent] = createSignal<string | null>(null)
  /** 새 메모와 새 폴더가 만들어질 폴더 */
  const [activeDir, setActiveDir] = createSignal('')
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set([ATTACHMENTS]))
  const [mode, setMode] = createSignal<Mode>('edit')
  const [query, setQuery] = createSignal('')
  const [format, setFormat] = createSignal<(typeof FORMATS)[number]['ext']>('md')
  const [renamingDir, setRenamingDir] = createSignal<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')
  /** 커서가 닫히지 않은 [[ 안에 있을 때: 지금까지 친 글자와 그 시작 위치 */
  const [linking, setLinking] = createSignal<{ from: number; typed: string } | null>(null)
  let area: HTMLTextAreaElement | undefined
  let titleInput: HTMLInputElement | undefined
  let imagePicker!: HTMLInputElement
  /** 아직 저장하지 않은 메모들: 경로 → 저장 타이머 */
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** 이름을 바꾸는 중인 메모들. 끝날 때까지 저장을 미룬다 (새 이름으로 먼저 저장하면 이름 바꾸기가 실패한다). */
  const busy = new Set<string>()
  let latest = 0
  let migrated = false

  // ───────────── 보관함 읽기 ─────────────

  const files = createMemo(() => entries.filter((e) => e.kind !== 'dir').map((e) => e.path))
  const notes = createMemo(() => entries.filter((e) => e.kind === 'note').map((e) => e.path))
  const entry = () => entries.find((e) => e.path === current())
  const text = () => texts[current() ?? ''] ?? ''
  const lang = () => (current() ? languageOf(current()!) : undefined)
  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  /** 트리에 보이는 이름: 메모는 확장자를 뗀 제목 */
  const shown = (e: Entry) => (e.kind === 'note' ? stemOf(e.path) : baseOf(e.path))
  /** 폴더 바로 아래의 항목들: 폴더 먼저, 그다음 보이는 이름순 ("메모 2"는 "메모" 다음, "메모 10"은 "메모 9" 다음) */
  const childrenOf = (dir: string) =>
    entries
      .filter((e) => dirOf(e.path) === dir)
      .sort(
        (a, b) =>
          Number(b.kind === 'dir') - Number(a.kind === 'dir') || shown(a).localeCompare(shown(b), 'ko', { numeric: true }),
      )
  const namesIn = (dir: string) => childrenOf(dir).map((e) => baseOf(e.path))

  async function walk(dir: string, out: Entry[]): Promise<Entry[]> {
    for (const item of await fs.list(absolute(dir))) {
      if (item.name.startsWith('.')) continue
      const path = joinPath(dir, item.name)
      out.push({ path, kind: item.dir ? 'dir' : kindOf(path) })
      if (item.dir) await walk(path, out)
    }
    return out
  }

  async function load(): Promise<void> {
    const request = ++latest
    try {
      await fs.mkdir(VAULT).catch((e) => {
        if (!(e instanceof FsError && e.errno === Errno.EXIST)) throw e
      })
      const found = await walk('', [])
      const loaded: Record<string, string> = {}
      await Promise.all(
        found
          .filter((e) => e.kind === 'note')
          .map(async (e) => (loaded[e.path] = new TextDecoder().decode(await fs.read(absolute(e.path))))),
      )
      if (request !== latest) return

      // 예전 메모 앱은 만든 시각을 파일 이름으로 썼다. 제목이 곧 파일 이름이 되도록 한 번 바꿔 준다.
      if (!migrated) {
        migrated = true
        let renamed = false
        for (const e of found) {
          const title = e.kind === 'note' && isLegacyName(e.path) ? titleFromText(loaded[e.path]!) : ''
          if (!title) continue
          const siblings = found.filter((x) => dirOf(x.path) === dirOf(e.path)).map((x) => baseOf(x.path))
          const path = joinPath(dirOf(e.path), uniqueName(siblings, title, extOf(e.path)))
          await fs.rename(absolute(e.path), absolute(path))
          e.path = path
          renamed = true
        }
        if (renamed) return load()
      }

      // 지금 치고 있어서 아직 저장하지 않은 메모는 화면의 내용이 더 새것이다.
      // 방금 만들어서 파일이 아직 없는 메모도 여기서 사라지면 안 된다.
      for (const path of pending.keys()) {
        if (texts[path] === undefined) continue
        loaded[path] = texts[path]!
        if (!found.some((e) => e.path === path)) found.push({ path, kind: 'note' })
      }
      found.sort((a, b) => a.path.localeCompare(b.path, 'ko'))
      setEntries(reconcile(found, { key: 'path' }))
      setTexts(reconcile(loaded))
      if (!found.some((e) => e.path === current())) setCurrent(found.find((e) => e.kind === 'note')?.path ?? null)
    } catch (e) {
      report(e)
    }
  }

  // 처음 열 때와, 터미널 등 다른 곳에서 보관함의 파일이 바뀔 때 다시 읽는다.
  createEffect(() => {
    props.system.fsVersion()
    void load()
  })

  // ───────────── 저장 ─────────────

  async function save(path: string): Promise<void> {
    // 이름을 바꾸는 중이면 그대로 둔다. 이름 바꾸기가 끝나면서 저장한다.
    if (busy.has(path)) return
    clearTimeout(pending.get(path))
    pending.delete(path)
    const content = texts[path]
    if (content !== undefined) {
      try {
        await fs.write(absolute(path), new TextEncoder().encode(content))
        setError('')
      } catch (e) {
        report(e)
      }
    }
    setSaving(pending.size > 0)
  }

  function edit(content: string) {
    const path = current()
    if (!path) return
    setTexts(path, content)
    clearTimeout(pending.get(path))
    pending.set(
      path,
      setTimeout(() => void save(path), SAVE_DELAY_MS),
    )
    setSaving(true)
  }

  // 창을 닫을 때 아직 저장하지 않은 것이 있으면 바로 저장한다.
  onCleanup(() => {
    for (const path of [...pending.keys()]) void save(path)
  })

  // ───────────── 열기, 만들기, 이름 바꾸기, 지우기 ─────────────

  function open(path: string) {
    setCurrent(path)
    setActiveDir(dirOf(path))
    setConfirmingDelete(null)
    setLinking(null)
    setError('')
    // 그 파일이 든 폴더들이 접혀 있으면 펼친다.
    setCollapsed((set) => new Set([...set].filter((dir) => !`${path}/`.startsWith(`${dir}/`))))
  }

  function createNote(stem = '제목 없음', dir = activeDir()): string {
    const path = joinPath(dir, uniqueName(namesIn(dir), stem, format()))
    // 파일이 만들어지기를 기다리지 않고 바로 적을 수 있게 한다. 파일은 뒤에서 만들어지고, 내용은 자동 저장이 채운다.
    setEntries(entries.length, { path, kind: 'note' })
    setTexts(path, '')
    setQuery('')
    open(path)
    pending.set(
      path,
      setTimeout(() => void save(path), 0),
    )
    return path
  }

  function newNote() {
    createNote()
    // 새 메모는 제목부터 정하도록 제목 칸에 커서를 둔다.
    queueMicrotask(() => titleInput?.select())
  }

  async function newFolder() {
    const dir = activeDir()
    const path = joinPath(dir, uniqueName(namesIn(dir), '새 폴더', ''))
    try {
      await fs.mkdir(absolute(path))
      await load()
      setCollapsed((set) => new Set([...set].filter((d) => d !== dir)))
      setRenamingDir(path)
    } catch (e) {
      report(e)
    }
  }

  /** 다른 메모들 안의, 옛 경로를 가리키던 링크를 새 경로로 고쳐 쓴다. */
  async function relink(oldPath: string, newPath: string, known: string[]) {
    for (const path of notes()) {
      const before = texts[path]
      if (path === oldPath || before === undefined) continue
      const after = renameLinks(before, oldPath, newPath, known)
      if (after === before) continue
      setTexts(path, after)
      await fs.write(absolute(path), new TextEncoder().encode(after))
    }
  }

  /** 열어 둔 메모의 제목(파일 이름)을 바꾼다. */
  async function rename(stem: string) {
    const from = current()
    if (!from || stem === stemOf(from)) return
    const problem = nameProblem(stem)
    if (problem) return setError(problem)
    const to = joinPath(dirOf(from), extOf(from) ? `${stem}.${extOf(from)}` : stem)
    if (namesIn(dirOf(from)).some((name) => name.toLowerCase() === baseOf(to).toLowerCase() && name !== baseOf(from))) {
      return setError('같은 이름의 파일이 이미 있습니다.')
    }
    // 화면에서는 바로 새 이름이 된다. 파일을 옮기는 동안 사용자가 내용을 치기 시작해도
    // 그 글자가 옛 이름의 메모로 들어가지 않게 하기 위해서다.
    const known = files()
    const content = texts[from] ?? ''
    clearTimeout(pending.get(from))
    pending.delete(from)
    busy.add(to)
    pending.set(to, undefined as never) // 아직 저장하지 않은 것으로 표시해, 그사이의 다시 읽기가 내용을 덮어쓰지 않게 한다
    // 한꺼번에 바꾼다. 하나씩 바꾸면 "열어 둔 메모가 목록에 없는" 순간이 생겨 편집 화면이 새로 만들어지고 커서를 잃는다.
    batch(() => {
      setEntries((e) => e.path === from, 'path', to)
      setTexts(to, content)
      setTexts(from, undefined as never)
      setCurrent(to)
      setError('')
      // 파일이 실제로 옮겨지고 저장될 때까지는 "저장 중"이다.
      setSaving(true)
    })
    try {
      // 아직 한 번도 저장하지 않은 새 메모일 수 있으므로, 옮기기 전에 파일부터 확실히 만든다.
      await fs.write(absolute(from), new TextEncoder().encode(content))
      await fs.rename(absolute(from), absolute(to))
      await relink(from, to, known)
    } catch (e) {
      report(e)
    } finally {
      busy.delete(to)
    }
    await save(to)
    await load()
  }

  async function renameDir(from: string, name: string) {
    setRenamingDir(null)
    if (name === baseOf(from)) return
    const problem = nameProblem(name)
    if (problem) return setError(problem)
    const to = joinPath(dirOf(from), name)
    if (namesIn(dirOf(from)).some((n) => n.toLowerCase() === name.toLowerCase())) return setError('같은 이름이 이미 있습니다.')
    try {
      await Promise.all([...pending.keys()].map(save))
      await fs.rename(absolute(from), absolute(to))
      const moved = (path: string) => (`${path}/`.startsWith(`${from}/`) ? to + path.slice(from.length) : path)
      setCurrent((path) => path && moved(path))
      setActiveDir(moved)
      await load()
    } catch (e) {
      report(e)
    }
  }

  async function remove(path: string) {
    setConfirmingDelete(null)
    for (const key of [...pending.keys()]) {
      if (`${key}/`.startsWith(`${path}/`)) {
        clearTimeout(pending.get(key))
        pending.delete(key)
      }
    }
    try {
      await fs.remove(absolute(path))
      if (`${activeDir()}/`.startsWith(`${path}/`)) setActiveDir(dirOf(path))
      await load()
    } catch (e) {
      report(e)
    }
  }

  // ───────────── 링크 ─────────────

  /** [[대상]]을 누르면 그 메모를 열고, 아직 없으면 그 이름으로 만든다. */
  function openLink(target: string) {
    const found = resolveLink(target, files())
    if (found) return open(found)
    const stem = baseOf(target)
    const problem = nameProblem(stem)
    if (problem) return setError(problem)
    createNote(stem, dirOf(current() ?? ''))
    queueMicrotask(() => area?.focus())
  }

  /** 이 메모를 가리키는 다른 메모들 */
  const backlinks = createMemo(() => {
    const here = current()
    if (!here) return []
    const known = files()
    return notes()
      .filter((path) => path !== here)
      .flatMap((path) => {
        const line = (texts[path] ?? '')
          .split('\n')
          .find((l) => parseLinks(l).some((link) => resolveLink(link.target, known) === here))
        return line === undefined ? [] : [{ path, line: line.trim() }]
      })
  })

  /** [[ 뒤에 친 글자로 고를 수 있는 파일들 */
  const suggestions = createMemo(() => {
    const state = linking()
    if (!state) return []
    const typed = state.typed.trim().toLowerCase()
    return files()
      .filter((path) => path !== current() && kindOf(path) !== 'other')
      .map((path) => (kindOf(path) === 'note' ? stemOf(path) : baseOf(path)))
      .filter((name, i, all) => name.toLowerCase().includes(typed) && all.indexOf(name) === i)
      .slice(0, 6)
  })

  function trackCaret(el: HTMLTextAreaElement) {
    area = el
    const before = el.value.slice(0, el.selectionStart)
    const open = /\[\[([^\[\]\n|#]*)$/.exec(before)
    setLinking(open ? { from: before.length - open[1]!.length, typed: open[1]! } : null)
  }

  function completeLink(name: string) {
    const state = linking()
    if (!state || !area) return
    // 뒤에 이미 ]] 가 있으면 다시 붙이지 않는다.
    const closed = area.value.slice(area.selectionStart, area.selectionStart + 2) === ']]'
    area.setRangeText(closed ? name : `${name}]]`, state.from, area.selectionStart, 'end')
    if (closed) area.selectionStart = area.selectionEnd = area.selectionStart + 2
    setLinking(null)
    edit(area.value)
    area.focus()
  }

  /** 고른 글을 앞뒤 기호로 감싼다 (굵게, 기울임, 링크). */
  function wrap(el: HTMLTextAreaElement, before: string, after: string) {
    const [from, to] = [el.selectionStart, el.selectionEnd]
    el.setRangeText(before + el.value.slice(from, to) + after, from, to, 'select')
    el.selectionStart = from + before.length
    el.selectionEnd = to + before.length
    edit(el.value)
  }

  const onEditorKey: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (e) => {
    const el = e.currentTarget
    if ((e.key === 'Tab' || e.key === 'Enter') && suggestions().length) {
      e.preventDefault()
      return completeLink(suggestions()[0]!)
    }
    if (e.key === 'Escape' && linking()) return setLinking(null)
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === 'b') wrap(el, '**', '**')
    else if (key === 'i') wrap(el, '*', '*')
    else if (key === 'k') wrap(el, '[[', ']]')
    else return
    e.preventDefault()
  }

  // ───────────── 그림 ─────────────

  /** 그림 파일들을 보관함에 저장하고, 메모의 커서 자리에 넣는다. 그림이 하나도 없으면 false. */
  function addImages(dropped: File[], el: HTMLTextAreaElement | undefined = area): boolean {
    const images = dropped.filter((file) => file.type.startsWith('image/') || kindOf(file.name) === 'image')
    if (images.length === 0) {
      setError('그림 파일만 넣을 수 있습니다.')
      return false
    }
    const note = current()
    void (async () => {
      try {
        await fs.mkdir(absolute(ATTACHMENTS)).catch((e) => {
          if (!(e instanceof FsError && e.errno === Errno.EXIST)) throw e
        })
        const taken = namesIn(ATTACHMENTS)
        const embeds: string[] = []
        for (const file of images) {
          if (file.size > IMAGE_LIMIT) throw new Error(`그림이 너무 큽니다 (${file.name}). 20MB까지 넣을 수 있습니다.`)
          const ext = kindOf(file.name) === 'image' ? extOf(file.name) : extensionForType(file.type)
          // 화면에서 붙여 넣은 그림은 이름이 모두 "image.png"라, 붙여 넣은 시각으로 이름을 짓는다.
          const generic = !file.name || /^image\.\w+$/i.test(file.name)
          const name = uniqueName(taken, generic ? `붙여넣은 그림 ${stamp()}` : stemOf(file.name), ext)
          taken.push(name)
          const path = joinPath(ATTACHMENTS, name)
          await fs.write(absolute(path), new Uint8Array(await file.arrayBuffer()))
          // 목록을 다시 읽을 때까지 기다리지 않고 바로 알려, 넣자마자 읽기 화면에 그려지게 한다.
          batch(() => {
            if (!entries.some((e) => e.path === ATTACHMENTS)) setEntries(entries.length, { path: ATTACHMENTS, kind: 'dir' })
            if (!entries.some((e) => e.path === path)) setEntries(entries.length, { path, kind: 'image' })
          })
          embeds.push(`![[${name}]]`)
        }
        setError('')
        if (!note || current() !== note || kindOf(note) !== 'note') return
        const insert = embeds.join('\n')
        if (el && el.isConnected) {
          el.setRangeText(insert, el.selectionStart, el.selectionEnd, 'end')
          edit(el.value)
        } else {
          // 읽기 보기처럼 입력창이 없을 때는 메모 끝에 붙인다.
          const body = texts[note] ?? ''
          edit(body + (body && !body.endsWith('\n') ? '\n' : '') + insert + '\n')
        }
      } catch (e) {
        report(e)
      }
    })()
    return true
  }

  /** 링크나 그림 주소가 가리키는 보관함 안의 그림을 읽는다. */
  async function readImage(target: string) {
    const path = resolveLink(target, files())
    const type = path && imageTypeOf(path)
    if (!path || !type) return undefined
    return { data: await fs.read(absolute(path)), type }
  }

  const context: PreviewContext = {
    linkExists: (target) => resolveLink(target, files()) !== undefined,
    openLink,
    readImage,
    revision: files,
    toggleTask: (line) => edit(toggleTask(text(), line)),
    openTag: (name) => setQuery(`#${name}`),
  }

  // ───────────── 찾기 ─────────────

  const results = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return []
    return notes().flatMap((path) => {
      const body = texts[path] ?? ''
      const line = body.split('\n').find((l) => l.toLowerCase().includes(q))
      if (line === undefined && !stemOf(path).toLowerCase().includes(q)) return []
      return [{ path, line: (line ?? body.split('\n').find((l) => l.trim()) ?? '').trim() }]
    })
  })

  // ───────────── 화면 ─────────────

  const toggleDir = (dir: string) =>
    setCollapsed((set) => {
      const next = new Set(set)
      if (!next.delete(dir)) next.add(dir)
      return next
    })

  const iconFor = (kind: Entry['kind']) => (kind === 'dir' ? <FolderIcon /> : kind === 'note' ? <NoteIcon /> : <FileIcon />)

  /** 폴더 하나의 내용을 그린다. 폴더 안의 폴더는 자기 자신을 다시 불러 그린다. */
  const Tree = (tree: { dir: string; level: number }): JSX.Element => (
    <For each={childrenOf(tree.dir)}>
      {(item) => (
        <Show
          when={item.kind === 'dir'}
          fallback={
            <li
              class="tree-row"
              role="treeitem"
              tabindex="0"
              aria-level={tree.level}
              aria-selected={current() === item.path}
              style={{ 'padding-left': `${8 + (tree.level - 1) * 14}px` }}
              onClick={() => open(item.path)}
              onKeyDown={(e) => e.key === 'Enter' && open(item.path)}
            >
              <span class="tree-icon">{iconFor(item.kind)}</span>
              <span class="tree-name">{shown(item)}</span>
              <Show when={item.kind === 'note' && extOf(item.path) !== 'md'}>
                <span class="tree-ext">{extOf(item.path)}</span>
              </Show>
            </li>
          }
        >
          <li role="treeitem" aria-level={tree.level} aria-expanded={!collapsed().has(item.path)} aria-label={baseOf(item.path)}>
            <div
              class="tree-row tree-dir"
              classList={{ active: activeDir() === item.path }}
              style={{ 'padding-left': `${8 + (tree.level - 1) * 14}px` }}
              onClick={() => {
                setActiveDir(item.path)
                toggleDir(item.path)
              }}
              onDblClick={() => setRenamingDir(item.path)}
            >
              <span class="tree-icon dir">{iconFor('dir')}</span>
              <Show when={renamingDir() === item.path} fallback={<span class="tree-name">{baseOf(item.path)}</span>}>
                <input
                  class="tree-rename"
                  aria-label="폴더 이름"
                  value={baseOf(item.path)}
                  ref={(el) => queueMicrotask(() => el.select())}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void renameDir(item.path, e.currentTarget.value.trim())
                    else if (e.key === 'Escape') setRenamingDir(null)
                  }}
                  onBlur={(e) => renamingDir() === item.path && void renameDir(item.path, e.currentTarget.value.trim())}
                />
              </Show>
              <Show when={activeDir() === item.path && renamingDir() !== item.path}>
                <button
                  class="tree-action"
                  aria-label={`${baseOf(item.path)} 폴더 지우기`}
                  title="폴더 지우기"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmingDelete(item.path)
                  }}
                >
                  ×
                </button>
              </Show>
            </div>
            <Show when={!collapsed().has(item.path)}>
              <ul role="group">
                <Tree dir={item.path} level={tree.level + 1} />
              </ul>
            </Show>
          </li>
        </Show>
      )}
    </For>
  )

  /** 트리에서 고른 그림 파일을 크게 보여 준다. */
  const ImageView = (view: { path: string }) => {
    let url: string | undefined
    onCleanup(() => url && URL.revokeObjectURL(url))
    const [source] = createResource(
      () => view.path,
      async (path) => {
        const image = await readImage(path)
        if (url) URL.revokeObjectURL(url)
        url = image && URL.createObjectURL(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.type }))
        return url ?? null
      },
    )
    return (
      <div class="note-image">
        <Show when={source()} fallback={<p class="editor-note">{source.loading ? '' : '그림을 열 수 없습니다.'}</p>}>
          {(src) => <img src={src()} alt={baseOf(view.path)} />}
        </Show>
        <p class="hint">
          메모에 넣으려면 <code>![[{baseOf(view.path)}]]</code> 라고 적습니다.
        </p>
      </div>
    )
  }

  const deleting = () => entries.find((e) => e.path === confirmingDelete())

  return (
    <div
      class="notes"
      onKeyDown={(e) => {
        // 보관함 어디에 초점이 있든 Ctrl/Cmd+Alt+N 으로 새 메모를 만든다. (Ctrl/Cmd+N 은 브라우저가 새 창에 쓴다.)
        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
          e.preventDefault()
          newNote()
        }
      }}
    >
      <aside class="notes-side">
        <div class="toolbar">
          <button class="tool primary" onClick={newNote}>
            새 메모
          </button>
          <select class="tool" aria-label="새 메모의 형식" value={format()} onChange={(e) => setFormat(e.currentTarget.value as 'md')}>
            <For each={FORMATS}>{(f) => <option value={f.ext}>{f.name}</option>}</For>
          </select>
          <button class="tool" onClick={newFolder}>
            새 폴더
          </button>
        </div>
        <input
          class="notes-search"
          type="search"
          aria-label="메모 찾기"
          placeholder="메모 찾기"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show
          when={query().trim()}
          fallback={
            <ul class="notes-tree" role="tree" aria-label="보관함" onClick={(e) => e.target === e.currentTarget && setActiveDir('')}>
              <Show when={entries.length} fallback={<li class="notes-empty">아직 메모가 없습니다.</li>}>
                <Tree dir="" level={1} />
              </Show>
            </ul>
          }
        >
          <ul class="notes-tree" role="listbox" aria-label="찾은 메모">
            <For each={results()} fallback={<li class="notes-empty">찾는 내용이 든 메모가 없습니다.</li>}>
              {(hit) => (
                <li
                  class="notes-hit"
                  role="option"
                  tabindex="0"
                  aria-selected={current() === hit.path}
                  onClick={() => open(hit.path)}
                  onKeyDown={(e) => e.key === 'Enter' && open(hit.path)}
                >
                  <span class="notes-title">{stemOf(hit.path)}</span>
                  <span class="notes-excerpt">{hit.line || hit.path}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </aside>

      <section class="notes-main">
        <Show when={deleting()}>
          {(target) => (
            <div class="promptbar" role="alertdialog" aria-label="지우기 확인">
              <span class="prompt-text">
                “{baseOf(target().path)}”
                {target().kind === 'dir' ? ' 폴더와 그 안의 모든 것을' : target().kind === 'image' ? ' 그림을' : ' 메모를'} 지울까요?
              </span>
              <button class="tool danger" onClick={() => void remove(target().path)}>
                지우기
              </button>
              <button class="tool" onClick={() => setConfirmingDelete(null)}>
                취소
              </button>
            </div>
          )}
        </Show>

        <Show when={entry()} fallback={<p class="editor-note">“새 메모”를 눌러 적기 시작하세요.</p>}>
          {(file) => (
            <>
              <div class="toolbar note-head">
                <Show
                  when={file().kind === 'note'}
                  fallback={<span class="note-title static">{baseOf(file().path)}</span>}
                >
                  <input
                    class="note-title"
                    ref={titleInput}
                    aria-label="제목"
                    value={stemOf(file().path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        area?.focus()
                      } else if (e.key === 'Escape') {
                        e.currentTarget.value = stemOf(file().path)
                        area?.focus()
                      }
                    }}
                    onBlur={(e) => {
                      const input = e.currentTarget
                      void rename(input.value.trim()).then(() => (input.value = stemOf(current() ?? '')))
                    }}
                  />
                  <Show when={lang() === 'markdown'}>
                    <div class="segmented" role="group" aria-label="보기 방식">
                      <For each={MODES}>
                        {(m) => (
                          <button aria-pressed={mode() === m.id} onClick={() => setMode(m.id)}>
                            {m.name}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <button class="tool" onClick={() => imagePicker.click()}>
                    그림 넣기
                  </button>
                </Show>
                <button class="tool" onClick={() => setConfirmingDelete(file().path)}>
                  삭제
                </button>
              </div>

              <Show when={file().kind === 'note'} fallback={<ImageView path={file().path} />}>
                <div class="note-body" classList={{ split: mode() === 'split' && lang() === 'markdown' }}>
                  <Show when={mode() !== 'read' || lang() !== 'markdown'}>
                    <CodeArea
                      ref={(el) => (area = el)}
                      label="메모 내용"
                      lang={lang()}
                      value={text()}
                      onInput={edit}
                      onCursor={trackCaret}
                      onKeyDown={onEditorKey}
                      onFiles={addImages}
                    />
                  </Show>
                  <Show when={mode() !== 'edit' && lang() === 'markdown'}>
                    <Preview text={text()} lang="markdown" context={context} />
                  </Show>
                </div>

                <Show when={suggestions().length}>
                  <div class="link-bar" role="listbox" aria-label="링크할 메모">
                    <span class="hint-inline">링크할 메모 (Tab으로 첫 번째 선택)</span>
                    <For each={suggestions()}>
                      {(name) => (
                        <button class="tool" role="option" aria-selected="false" onPointerDown={(e) => e.preventDefault()} onClick={() => completeLink(name)}>
                          {name}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={backlinks().length}>
                  <details class="backlinks">
                    <summary>이 메모를 가리키는 메모 {backlinks().length}개</summary>
                    <ul>
                      <For each={backlinks()}>
                        {(link) => (
                          <li>
                            <button class="md-wikilink" onClick={() => open(link.path)}>
                              {stemOf(link.path)}
                            </button>
                            <span class="notes-excerpt">{link.line}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                </Show>
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
                    notes/{file().path}
                    {file().kind === 'note' ? ` · ${saving() ? '저장 중…' : '저장됨'}` : ''}
                  </span>
                </Show>
                <Show when={file().kind === 'note'}>
                  <span>{[...text()].length.toLocaleString()}자</span>
                </Show>
              </footer>
            </>
          )}
        </Show>

        <input
          ref={imagePicker}
          type="file"
          accept="image/*"
          multiple
          aria-label="넣을 그림"
          hidden
          onChange={(e) => {
            addImages([...(e.currentTarget.files ?? [])])
            e.currentTarget.value = ''
          }}
        />
      </section>
    </div>
  )
}
