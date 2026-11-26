// 메모 보관함. 폴더로 정리한 마크다운 메모를 [[링크]]로 서로 잇고, 그림을 함께 보관한다.
// 메모와 그림은 모두 홈의 notes 폴더 아래의 실제 파일이라 터미널, 파일 탐색기, 보관 폴더, 백업에서도 그대로 보인다.
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Errno } from '../../kernel/errno.ts'
import { CodeArea } from '../editor/CodeArea.tsx'
import { languageOf } from '../editor/highlight.ts'
import { toggleTask } from '../editor/markdown.ts'
import { Preview, type PreviewContext } from '../editor/Preview.tsx'
import { isTextField, showMenu } from '../contextmenu.tsx'
import { FileIcon, FolderIcon, NoteIcon } from '../icons.tsx'
import {
  ATTACHMENTS,
  VAULT,
  baseOf,
  buildGraph,
  dirOf,
  extOf,
  extensionForType,
  imageTypeOf,
  isInside,
  isLegacyName,
  joinPath,
  kindOf,
  layoutGraph,
  moveProblem,
  nameProblem,
  outlineOf,
  parseLinks,
  renameLinks,
  resolveLink,
  stemOf,
  tagsOf,
  titleFromText,
  uniqueName,
  type FileKind,
} from '../notes/vault.ts'
import { continueList, indent, type Edit } from '../notes/editing.ts'
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

/** 최근에 연 메모를 기억해 두는 곳 (이 브라우저에만 남는다) */
const RECENT_KEY = 'webos.notes.recent'
const RECENT_LIMIT = 20

function savedRecent(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** 이름에 친 글자들이 순서대로 들어 있는가. 붙어 있으면 앞쪽일수록, 흩어져 있으면 그다음으로 친다. 없으면 -1. */
function matchScore(name: string, typed: string): number {
  const at = name.indexOf(typed)
  if (at >= 0) return at
  let from = 0
  for (const ch of typed) {
    from = name.indexOf(ch, from) + 1
    if (from === 0) return -1
  }
  return 1000 + name.length
}

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
  /** 탭으로 열어 둔 파일들 */
  const [tabs, setTabs] = createSignal<string[]>([])
  /** 지나온 파일들과 그 안에서의 지금 위치 (뒤로, 앞으로) */
  const [trail, setTrail] = createSignal<{ list: string[]; at: number }>({ list: [], at: -1 })
  /** 옆에 참고로 펼쳐 둔 메모 */
  const [side, setSide] = createSignal<string | null>(null)
  const [graphOpen, setGraphOpen] = createSignal(false)
  /** 빠른 열기 창에 친 글자. 닫혀 있으면 null. */
  const [quick, setQuick] = createSignal<string | null>(null)
  const [quickAt, setQuickAt] = createSignal(0)
  const [recent, setRecent] = createSignal(savedRecent())
  /** 끌고 있는 항목과, 지금 놓으면 들어갈 폴더 */
  const [dragging, setDragging] = createSignal<string | null>(null)
  const [dropDir, setDropDir] = createSignal<string | null>(null)
  let root!: HTMLDivElement
  /** 사용자가 탭을 모두 닫았다. 다른 메모를 열 때까지는 알아서 열지 않는다. */
  let stayEmpty = false
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
      batch(() => {
        setEntries(reconcile(found, { key: 'path' }))
        setTexts(reconcile(loaded))
        // 사라진 파일은 탭, 지나온 길, 최근 목록에서도 뺀다.
        const known = new Set(found.map((e) => e.path))
        remap((path) => (known.has(path) ? path : null))
        if (!current() && !stayEmpty) show(tabs().at(-1) ?? found.find((e) => e.kind === 'note')?.path ?? null)
      })
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

  // ───────────── 탭과 지나온 길 ─────────────

  /** 파일을 화면에 올린다: 탭에 없으면 탭을 만들고, 최근 목록과 지나온 길에 적는다. */
  function show(path: string | null, record = true) {
    batch(() => {
      setCurrent(path)
      if (!path) return
      setTabs((list) => (list.includes(path) ? list : [...list, path]))
      if (kindOf(path) === 'note') setRecent((list) => [path, ...list.filter((p) => p !== path)].slice(0, RECENT_LIMIT))
      if (record) {
        setTrail(({ list, at }) => (list[at] === path ? { list, at } : { list: [...list.slice(0, at + 1), path], at: at + 1 }))
      }
    })
  }

  /** 경로가 바뀌거나(이름 바꾸기, 옮기기) 없어졌을 때(null), 경로를 기억하는 모든 곳을 함께 고친다. */
  function remap(to: (path: string) => string | null) {
    const each = (list: string[]) => [...new Set(list.map(to).filter((p): p is string => p !== null))]
    batch(() => {
      setTabs(each)
      setRecent(each)
      setSide((path) => path && to(path))
      setTrail(({ list, at }) => {
        const next: string[] = []
        let pos = -1
        list.forEach((path, i) => {
          const moved = to(path)
          if (moved !== null && next.at(-1) !== moved) next.push(moved)
          if (i === at) pos = next.length - 1
        })
        return { list: next, at: pos }
      })
      setCurrent((path) => path && to(path))
    })
  }

  createEffect(() => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent()))
    } catch {
      // 저장하지 못해도 이번에 켜 둔 동안에는 그대로 쓸 수 있다.
    }
  })

  const canGo = (step: number) => trail().list[trail().at + step] !== undefined

  /** 뒤로(-1), 앞으로(+1) */
  function go(step: number) {
    const { list, at } = trail()
    const path = list[at + step]
    if (path === undefined) return
    setTrail({ list, at: at + step })
    open(path, false)
  }

  function closeTab(path: string) {
    const list = tabs()
    const at = list.indexOf(path)
    if (at < 0) return
    const rest = list.filter((p) => p !== path)
    batch(() => {
      setTabs(rest)
      if (current() !== path) return
      // 닫은 탭의 오른쪽, 없으면 왼쪽 탭으로 간다.
      const next = rest[at] ?? rest[at - 1] ?? null
      stayEmpty = next === null
      if (next) open(next)
      else setCurrent(null)
    })
  }

  // ───────────── 열기, 만들기, 이름 바꾸기, 옮기기, 지우기 ─────────────

  function open(path: string, record = true) {
    stayEmpty = false
    batch(() => {
      show(path, record)
      setGraphOpen(false)
      setQuick(null)
      setActiveDir(dirOf(path))
      setConfirmingDelete(null)
      setLinking(null)
      setError('')
      // 그 파일이 든 폴더들이 접혀 있으면 펼친다.
      setCollapsed((set) => new Set([...set].filter((dir) => !`${path}/`.startsWith(`${dir}/`))))
    })
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
      remap((path) => (path === from ? to : path))
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
      remap(moved)
      setActiveDir(moved)
      await load()
    } catch (e) {
      report(e)
    }
  }

  /** 파일이나 폴더를 다른 폴더로 옮긴다 (dest가 빈 문자열이면 보관함 맨 위). */
  async function move(path: string, dest: string) {
    const problem = moveProblem(path, dest, namesIn(dest))
    if (problem !== undefined) return void (problem && setError(problem))
    const to = joinPath(dest, baseOf(path))
    const moved = (p: string) => (isInside(p, path) ? to + p.slice(path.length) : p)
    const known = files()
    try {
      await Promise.all([...pending.keys()].map(save))
      await fs.rename(absolute(path), absolute(to))
      batch(() => {
        remap(moved)
        setActiveDir(moved)
        setCollapsed((set) => new Set([...set].filter((dir) => !isInside(dest, dir) || dest === '')))
        setError('')
      })
      await load()
      // 이름만 적은 링크는 그대로 통한다. 폴더까지 적은 링크([[폴더/메모]])만 새 자리로 고친다.
      for (const old of known) if (isInside(old, path)) await relink(old, moved(old), known)
    } catch (e) {
      report(e)
    }
  }

  /** 옮길 수 있는 폴더들을 메뉴로 보여 준다. */
  function moveMenu(e: MouseEvent, path: string) {
    const dirs = ['', ...entries.filter((x) => x.kind === 'dir').map((x) => x.path)].filter(
      (dir) => moveProblem(path, dir, namesIn(dir)) === undefined,
    )
    showMenu(
      e,
      dirs.length
        ? dirs.map((dir) => ({ label: dir || '보관함 맨 위', onSelect: () => void move(path, dir) }))
        : [{ label: '옮길 수 있는 폴더가 없습니다', onSelect: () => {}, disabled: true }],
    )
  }

  /** 끌어다 놓을 수 있는 자리에 붙이는 동작들. dest는 놓았을 때 들어갈 폴더. */
  const dropInto = (dest: () => string) => ({
    onDragOver: (e: DragEvent) => {
      const path = dragging()
      if (!path || moveProblem(path, dest(), namesIn(dest())) !== undefined) return
      e.preventDefault()
      e.stopPropagation()
      setDropDir(dest())
    },
    onDrop: (e: DragEvent) => {
      const path = dragging()
      if (!path) return
      e.preventDefault()
      e.stopPropagation()
      setDropDir(null)
      setDragging(null)
      void move(path, dest())
    },
  })

  const dragFrom = (item: Entry) => ({
    onDragStart: (e: DragEvent) => {
      // 편집 화면에 놓으면 그 자리에 링크가 들어간다.
      const link = item.kind === 'note' ? `[[${stemOf(item.path)}]]` : item.kind === 'dir' ? '' : `![[${baseOf(item.path)}]]`
      e.dataTransfer?.setData('text/plain', link)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'
      e.stopPropagation()
      setDragging(item.path)
    },
    onDragEnd: () => {
      setDragging(null)
      setDropDir(null)
    },
  })

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
      remap((p) => (isInside(p, path) ? null : p))
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
    // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이다.
    if (e.isComposing) return
    if (lang() === 'markdown' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      let change: Edit | null = null
      if (e.key === 'Enter' && !e.shiftKey && el.selectionStart === el.selectionEnd) change = continueList(el.value, el.selectionStart)
      else if (e.key === 'Tab') change = indent(el.value, el.selectionStart, el.selectionEnd, e.shiftKey)
      if (change) {
        e.preventDefault()
        el.value = change.text
        el.setSelectionRange(change.start, change.end)
        edit(change.text)
        trackCaret(el)
      }
      return
    }
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

  /** ![[메모]]로 넣을 메모의 내용 */
  function readNote(target: string) {
    const path = resolveLink(target, files())
    return path && kindOf(path) === 'note' ? texts[path] : undefined
  }

  const context: PreviewContext = {
    linkExists: (target) => resolveLink(target, files()) !== undefined,
    openLink,
    readImage,
    readNote,
    revision: files,
    toggleTask: (line) => edit(toggleTask(text(), line)),
    openTag: (name) => setQuery(`#${name}`),
  }
  /** 옆에 펼친 참고 메모용. 체크를 눌러도 지금 편집하는 메모가 바뀌면 안 되므로 누를 수 없게 한다. */
  const sideContext: PreviewContext = { ...context, toggleTask: undefined }

  // ───────────── 목차, 태그 ─────────────

  const outline = createMemo(() => (entry()?.kind === 'note' && lang() === 'markdown' ? outlineOf(text()) : []))

  /** 보관함의 모든 태그와, 그 태그가 든 메모의 수 (많은 것부터) */
  const allTags = createMemo(() => {
    const count = new Map<string, number>()
    for (const path of notes()) for (const tag of tagsOf(texts[path] ?? '')) count.set(tag, (count.get(tag) ?? 0) + 1)
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
  })

  /** 목차에서 고른 제목으로 간다: 편집 화면은 커서를 그 줄에 두고, 읽기 화면은 그 제목이 보이게 한다. */
  function jump(line: number) {
    const lines = text().split('\n')
    if (area?.isConnected) {
      const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0)
      area.focus({ preventScroll: true })
      area.setSelectionRange(offset, offset)
      // 긴 줄이 여러 줄로 접히면 줄 번호만으로는 높이를 알 수 없어, 전체 높이의 비율로 어림한다.
      area.scrollTop = Math.max(0, (line / lines.length) * area.scrollHeight - 30)
      trackCaret(area)
    }
    const heading = [...root.querySelectorAll<HTMLElement>(`.preview [data-line="${line}"]`)].find((h) => !h.closest('.md-embed, .note-ref'))
    const scroller = heading?.closest('.preview')
    if (heading && scroller) scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
  }

  // ───────────── 빠른 열기 ─────────────

  /** 친 글자가 없으면 최근에 연 메모부터, 있으면 이름이 맞는 메모를 가까운 순서로 */
  const quickHits = createMemo(() => {
    const typed = (quick() ?? '').trim().toLowerCase()
    const all = notes()
    if (!typed) return [...recent().filter((p) => all.includes(p)), ...all.filter((p) => !recent().includes(p))].slice(0, 8)
    return all
      .map((path) => ({ path, score: matchScore(stemOf(path).toLowerCase(), typed) }))
      .filter((hit) => hit.score >= 0)
      .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path, 'ko'))
      .slice(0, 8)
      .map((hit) => hit.path)
  })

  function openQuick() {
    setQuickAt(0)
    setQuick('')
  }

  function closeQuick() {
    setQuick(null)
    area?.focus()
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
              draggable={true}
              {...dragFrom(item)}
              {...dropInto(() => dirOf(item.path))}
              onClick={() => open(item.path)}
              onKeyDown={(e) => e.key === 'Enter' && open(item.path)}
              onContextMenu={(e) =>
                showMenu(e, [
                  { label: '열기', onSelect: () => open(item.path) },
                  item.kind === 'note' && { label: '옆에 열기', onSelect: () => setSide(item.path) },
                  item.kind === 'note' && {
                    label: '이름 바꾸기',
                    onSelect: () => {
                      open(item.path)
                      queueMicrotask(() => titleInput?.select())
                    },
                  },
                  item.kind !== 'note' && {
                    label: '메모에 넣는 글 복사',
                    onSelect: () => void navigator.clipboard?.writeText(`![[${baseOf(item.path)}]]`),
                  },
                  item.kind === 'note' && {
                    label: '링크 복사',
                    onSelect: () => void navigator.clipboard?.writeText(`[[${stemOf(item.path)}]]`),
                  },
                  { label: '다른 폴더로 옮기기…', onSelect: () => moveMenu(e, item.path) },
                  'separator',
                  { label: '삭제…', onSelect: () => setConfirmingDelete(item.path), danger: true },
                ])
              }
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
              classList={{ active: activeDir() === item.path, 'drop-target': dropDir() === item.path }}
              style={{ 'padding-left': `${8 + (tree.level - 1) * 14}px` }}
              draggable={renamingDir() !== item.path}
              {...dragFrom(item)}
              {...dropInto(() => item.path)}
              onClick={() => {
                setActiveDir(item.path)
                toggleDir(item.path)
              }}
              onDblClick={() => setRenamingDir(item.path)}
              onContextMenu={(e) => {
                if (isTextField(e.target)) return
                setActiveDir(item.path)
                showMenu(e, [
                  { label: '여기에 새 메모', onSelect: newNote },
                  { label: '여기에 새 폴더', onSelect: () => void newFolder() },
                  'separator',
                  { label: '이름 바꾸기', onSelect: () => setRenamingDir(item.path) },
                  { label: '다른 폴더로 옮기기…', onSelect: () => moveMenu(e, item.path) },
                  { label: '삭제…', onSelect: () => setConfirmingDelete(item.path), danger: true },
                ])
              }}
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

  /** 메모를 점으로, 링크를 선으로 그린 관계도 */
  const GraphView = () => {
    let box!: HTMLDivElement
    const [size, setSize] = createSignal({ w: 600, h: 400 })
    const [hover, setHover] = createSignal<string | null>(null)
    onMount(() => {
      const measure = () => box.clientWidth && setSize({ w: box.clientWidth, h: box.clientHeight })
      const observer = new ResizeObserver(measure)
      observer.observe(box)
      onCleanup(() => observer.disconnect())
    })
    const graph = createMemo(() =>
      layoutGraph(buildGraph(notes().map((path) => ({ path, text: texts[path] ?? '' })), files()), size().w, size().h),
    )
    const spot = createMemo(() => new Map(graph().nodes.map((node) => [node.id, node])))
    /** 마우스를 올린 점과 그 이웃들. 이것만 또렷하게 그린다. */
    const near = createMemo(() => {
      const id = hover()
      if (!id) return null
      const set = new Set([id])
      for (const link of graph().links) {
        if (link.source === id) set.add(link.target)
        if (link.target === id) set.add(link.source)
      }
      return set
    })
    const dim = (id: string) => near() !== null && !near()!.has(id)
    const pick = (id: string, label: string, exists: boolean) => (exists ? open(id) : openLink(label))

    return (
      <div class="note-graph" ref={box}>
        <Show when={graph().nodes.length} fallback={<p class="editor-note">메모를 만들고 [[링크]]로 이으면 여기에 그려집니다.</p>}>
          <svg width={size().w} height={size().h} role="group" aria-label="메모 그래프">
            <For each={graph().links}>
              {(link) => (
                <line
                  classList={{ dim: dim(link.source) || dim(link.target), lit: near() !== null && !dim(link.source) && !dim(link.target) }}
                  x1={spot().get(link.source)!.x}
                  y1={spot().get(link.source)!.y}
                  x2={spot().get(link.target)!.x}
                  y2={spot().get(link.target)!.y}
                />
              )}
            </For>
            <For each={graph().nodes}>
              {(node) => (
                <g
                  class="graph-node"
                  classList={{ missing: !node.exists, current: node.id === current(), dim: dim(node.id) }}
                  role="button"
                  tabindex="0"
                  aria-label={`${node.label}${node.exists ? '' : ' (아직 없는 메모)'}, 링크 ${node.degree}개`}
                  transform={`translate(${node.x} ${node.y})`}
                  onClick={() => pick(node.id, node.label, node.exists)}
                  onKeyDown={(e) => e.key === 'Enter' && pick(node.id, node.label, node.exists)}
                  onPointerEnter={() => setHover(node.id)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(node.id)}
                  onBlur={() => setHover(null)}
                >
                  {/* 점이 작아도 쉽게 누를 수 있도록, 보이지 않는 넓은 원이 이름표까지 덮는다. */}
                  <circle class="graph-hit" r="22" cy="6" />
                  <circle r={5 + Math.min(7, node.degree * 1.5)} />
                  <text y={20 + Math.min(7, node.degree * 1.5)} text-anchor="middle">
                    {node.label}
                  </text>
                </g>
              )}
            </For>
          </svg>
        </Show>
        <p class="graph-hint">
          메모 {graph().nodes.filter((n) => n.exists).length}개 · 링크 {graph().links.length}개 · 점을 누르면 그 메모가 열립니다. 점선은 링크만 있고 아직 없는 메모입니다.
        </p>
      </div>
    )
  }

  const tabName = (path: string) => (kindOf(path) === 'note' ? stemOf(path) : baseOf(path))
  const deleting = () => entries.find((e) => e.path === confirmingDelete())

  return (
    <div
      class="notes"
      ref={root}
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return
        const key = e.key.toLowerCase()
        // 보관함 어디에 초점이 있든 Ctrl/Cmd+Alt+N 으로 새 메모를 만든다. (Ctrl/Cmd+N 은 브라우저가 새 창에 쓴다.)
        if (e.altKey && key === 'n') newNote()
        else if (e.altKey && e.key === 'ArrowLeft') go(-1)
        else if (e.altKey && e.key === 'ArrowRight') go(1)
        else if (!e.altKey && key === 'o') openQuick()
        else return
        e.preventDefault()
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
        <div class="notes-find">
          <input
            class="notes-search"
            type="search"
            aria-label="메모 찾기"
            placeholder="메모 찾기"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button class="tool" aria-pressed={graphOpen()} title="메모 사이의 링크를 그림으로 봅니다" onClick={() => setGraphOpen((on) => !on)}>
            그래프
          </button>
        </div>
        <Show
          when={query().trim()}
          fallback={
            <ul
              class="notes-tree"
              role="tree"
              aria-label="보관함"
              classList={{ 'drop-target': dropDir() === '' }}
              {...dropInto(() => '')}
              onDragLeave={(e) => e.target === e.currentTarget && setDropDir(null)}
              onClick={(e) => e.target === e.currentTarget && setActiveDir('')}
              // 항목이 아닌 빈 곳: 보관함 맨 위에 만든다.
              onContextMenu={(e) => {
                if (e.target !== e.currentTarget) return
                setActiveDir('')
                showMenu(e, [
                  { label: '새 메모', onSelect: newNote },
                  { label: '새 폴더', onSelect: () => void newFolder() },
                ])
              }}
            >
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

        <Show when={outline().length}>
          <details class="side-section" open>
            <summary>목차</summary>
            <ul aria-label="목차">
              <For each={outline()}>
                {(heading) => (
                  <li>
                    <button style={{ 'padding-left': `${10 + (heading.level - 1) * 10}px` }} onClick={() => jump(heading.line)}>
                      {heading.title}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
        <Show when={allTags().length}>
          <details class="side-section">
            <summary>태그 {allTags().length}개</summary>
            <ul class="tag-list" aria-label="태그">
              <For each={allTags()}>
                {([tag, count]) => (
                  <li>
                    <button class="md-tag" aria-pressed={query() === `#${tag}`} onClick={() => setQuery((q) => (q === `#${tag}` ? '' : `#${tag}`))}>
                      #{tag} <span class="tag-count">{count}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
      </aside>

      <section class="notes-main">
        <div class="note-tabs">
          <button class="tool" aria-label="뒤로" title="뒤로" disabled={!canGo(-1)} onClick={() => go(-1)}>
            ←
          </button>
          <button class="tool" aria-label="앞으로" title="앞으로" disabled={!canGo(1)} onClick={() => go(1)}>
            →
          </button>
          <div class="tab-strip" role="tablist" aria-label="열어 둔 메모">
            <For each={tabs()}>
              {(path) => (
                <div
                  class="note-tab"
                  role="tab"
                  tabindex="0"
                  title={path}
                  aria-selected={current() === path && !graphOpen()}
                  onClick={() => open(path)}
                  onKeyDown={(e) => e.key === 'Enter' && open(path)}
                  // 가운데 버튼으로 누르면 닫는다.
                  onAuxClick={(e) => e.button === 1 && closeTab(path)}
                  onContextMenu={(e) =>
                    showMenu(e, [
                      { label: '탭 닫기', onSelect: () => closeTab(path) },
                      { label: '다른 탭 모두 닫기', onSelect: () => (open(path), setTabs([path])), disabled: tabs().length < 2 },
                      kindOf(path) === 'note' && 'separator',
                      kindOf(path) === 'note' && { label: '옆에 열기', onSelect: () => setSide(path) },
                    ])
                  }
                >
                  <span class="tab-name">{tabName(path)}</span>
                  <button
                    class="tab-close"
                    aria-label={`${tabName(path)} 탭 닫기`}
                    title="탭 닫기"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(path)
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
          <button class="tool" title="이름으로 메모 열기 (Ctrl/Cmd+O)" onClick={openQuick}>
            빠른 열기
          </button>
        </div>

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

        <Show when={graphOpen()}>
          <GraphView />
        </Show>
        <Show
          when={!graphOpen() && entry()}
          fallback={
            <p class="editor-note" hidden={graphOpen()}>
              “새 메모”를 눌러 적기 시작하세요.
              {/* 열어 둔 메모가 없으면 상태 줄도 없으므로, 오류는 여기에 보여 준다. */}
              <Show when={error()}>
                <span class="status-error" role="alert">
                  <br />
                  {error()}
                </span>
              </Show>
            </p>
          }
        >
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
                  <Show when={side() !== null && texts[side()!] !== undefined}>
                    <aside class="note-ref" aria-label="참고 메모">
                      <div class="note-ref-head">
                        <button class="md-wikilink" title="이 메모를 편집하러 가기" onClick={() => open(side()!)}>
                          {stemOf(side()!)}
                        </button>
                        <button class="tab-close" aria-label="참고 메모 닫기" title="닫기" onClick={() => setSide(null)}>
                          ×
                        </button>
                      </div>
                      <Preview text={texts[side()!]!} lang="markdown" context={sideContext} />
                    </aside>
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

        <Show when={quick() !== null}>
          <div class="quick-open" onPointerDown={(e) => e.target === e.currentTarget && closeQuick()}>
            <div class="quick-panel" role="dialog" aria-label="빠른 열기">
              <input
                type="search"
                aria-label="열 메모의 이름"
                placeholder="메모 이름"
                ref={(el) => queueMicrotask(() => el.focus())}
                value={quick() ?? ''}
                onInput={(e) => {
                  setQuickAt(0)
                  setQuick(e.currentTarget.value)
                }}
                onKeyDown={(e) => {
                  if (e.isComposing) return
                  const hits = quickHits()
                  if (e.key === 'ArrowDown') setQuickAt((i) => (i + 1) % Math.max(1, hits.length))
                  else if (e.key === 'ArrowUp') setQuickAt((i) => (i - 1 + hits.length) % Math.max(1, hits.length))
                  else if (e.key === 'Enter') {
                    const path = hits[quickAt()]
                    if (path) {
                      open(path)
                      queueMicrotask(() => area?.focus())
                    }
                  } else if (e.key === 'Escape') closeQuick()
                  else return
                  e.preventDefault()
                  e.stopPropagation()
                }}
              />
              <ul role="listbox" aria-label={(quick() ?? '').trim() ? '이름이 맞는 메모' : '최근에 연 메모'}>
                <For each={quickHits()} fallback={<li class="notes-empty">그런 이름의 메모가 없습니다.</li>}>
                  {(path, i) => (
                    <li role="option" aria-selected={i() === quickAt()} onPointerEnter={() => setQuickAt(i())} onClick={() => open(path)}>
                      <span class="notes-title">{stemOf(path)}</span>
                      <span class="notes-excerpt">{dirOf(path)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </div>
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
