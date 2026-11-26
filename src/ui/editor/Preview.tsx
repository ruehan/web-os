// 형식별 보기: 마크다운은 서식을 입혀서, JSON은 가지런히 정리해서, CSV는 표로 보여 준다.
import { For, Match, Show, Switch, createMemo, createResource, onCleanup } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { parseCsv } from './csv.ts'
import { highlight, type Lang } from './highlight.ts'
import { parseMarkdown, type Block, type Inline, type ListBlock } from './markdown.ts'

/** 미리보기를 제공하는 형식 */
export const previewable = (lang: Lang | undefined): lang is 'markdown' | 'json' | 'csv' =>
  lang === 'markdown' || lang === 'json' || lang === 'csv'

/**
 * 메모 보관함처럼 "다른 파일을 아는" 곳에서 마크다운을 그릴 때 넘기는 것들.
 * 없으면 메모 링크는 글자로만 보이고, 보관함 안의 그림은 그려지지 않는다.
 */
export interface PreviewContext {
  /** [[대상]]이 가리키는 메모가 있는가 (없는 메모는 다르게 표시한다) */
  linkExists(target: string): boolean
  /** 메모 링크를 눌렀다 */
  openLink(target: string): void
  /** 보관함 안의 그림을 읽는다. 없거나 그림이 아니면 undefined. */
  readImage(target: string): Promise<{ data: Uint8Array; type: string } | undefined>
  /** ![[메모]]로 넣을 다른 메모의 내용. 그런 메모가 없으면 undefined. */
  readNote?(target: string): string | undefined
  /** 보관함의 파일 목록이 바뀔 때마다 달라지는 값. 읽으면 변경을 구독하게 되어, 나중에 생긴 그림도 다시 찾아 그린다. */
  revision(): unknown
  /** 체크 목록의 체크를 눌렀다 (원문의 줄 번호) */
  toggleTask?(line: number): void
  /** 태그를 눌렀다 */
  openTag?(name: string): void
}

export function Preview(props: { text: string; lang: 'markdown' | 'json' | 'csv'; context?: PreviewContext }) {
  return (
    <div class="preview" role="document" aria-label="미리보기">
      <Switch>
        <Match when={props.lang === 'markdown'}>
          <MarkdownView text={props.text} context={props.context} />
        </Match>
        <Match when={props.lang === 'json'}>
          <JsonView text={props.text} />
        </Match>
        <Match when={props.lang === 'csv'}>
          <CsvView text={props.text} />
        </Match>
      </Switch>
    </div>
  )
}

/** 보관함 안의 그림. 파일의 내용을 읽어 와 그 자리에 보여 준다. */
function VaultImage(props: { target: string; alt: string; context: PreviewContext }) {
  // 파일 내용으로 만든 임시 주소는 다 쓰면 놓아 줘야 메모리가 새지 않는다.
  let url: string | undefined
  const release = () => url && URL.revokeObjectURL(url)
  onCleanup(release)
  const [source] = createResource(
    // 대상이 같아도 보관함의 파일 목록이 바뀌면 다시 읽는다 (방금 넣은 그림, 이름이 바뀐 그림).
    () => ({ target: props.target, revision: props.context.revision() }),
    async ({ target }) => {
      const image = await props.context.readImage(target)
      release()
      url = image && URL.createObjectURL(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.type }))
      return url ?? null
    },
  )
  return (
    <Show when={source()} fallback={<span class="md-missing">{source.loading ? '' : `그림을 찾을 수 없음: ${props.target}`}</span>}>
      {(src) => <img class="md-image" src={src()} alt={props.alt || props.target} />}
    </Show>
  )
}

function Inlines(props: { items: Inline[]; context?: PreviewContext }) {
  const local = (src: string) => !/^[a-z][a-z0-9+.-]*:/i.test(src)
  return (
    <For each={props.items}>
      {(item) => (
        <Switch>
          <Match when={item.type === 'text' && item}>{(t) => t().text}</Match>
          <Match when={item.type === 'code' && item}>{(c) => <code>{c().text}</code>}</Match>
          <Match when={item.type === 'strong' && item}>
            {(s) => (
              <strong>
                <Inlines items={s().children} context={props.context} />
              </strong>
            )}
          </Match>
          <Match when={item.type === 'em' && item}>
            {(e) => (
              <em>
                <Inlines items={e().children} context={props.context} />
              </em>
            )}
          </Match>
          <Match when={item.type === 'link' && item}>
            {(l) => (
              // 바깥 사이트는 새 탭에서 열고, 이 페이지에 접근할 수 없게 한다.
              <a href={l().href} target="_blank" rel="noopener noreferrer">
                <Inlines items={l().children} context={props.context} />
              </a>
            )}
          </Match>
          <Match when={item.type === 'image' && item}>
            {(image) => (
              <Show
                when={props.context && local(image().src)}
                fallback={
                  // 바깥 그림: 이 페이지는 교차 출처 격리 상태라, 다른 사이트의 그림은 그쪽이 허용한 경우에만 보인다.
                  <Show when={/^https?:/i.test(image().src)} fallback={<span class="md-missing">{image().alt || image().src}</span>}>
                    <img class="md-image" src={image().src} alt={image().alt} crossorigin="anonymous" referrerpolicy="no-referrer" />
                  </Show>
                }
              >
                <VaultImage target={decodeURI(image().src)} alt={image().alt} context={props.context!} />
              </Show>
            )}
          </Match>
          <Match when={item.type === 'wikilink' && item}>
            {(link) => (
              <Show when={props.context} fallback={<span class="md-wikilink">{link().label}</span>}>
                {(context) => (
                  <Show
                    when={link().embed && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(link().target)}
                    fallback={
                      <button
                        class="md-wikilink"
                        classList={{ missing: !context().linkExists(link().target) }}
                        title={context().linkExists(link().target) ? link().target : `아직 없는 메모: ${link().target} (누르면 만듭니다)`}
                        onClick={() => context().openLink(link().target)}
                      >
                        {link().label}
                      </button>
                    }
                  >
                    <VaultImage target={link().target} alt={link().label} context={context()} />
                  </Show>
                )}
              </Show>
            )}
          </Match>
          <Match when={item.type === 'tag' && item}>
            {(tag) => (
              <Show when={props.context?.openTag} fallback={<span class="md-tag">#{tag().name}</span>}>
                <button class="md-tag" onClick={() => props.context!.openTag!(tag().name)}>
                  #{tag().name}
                </button>
              </Show>
            )}
          </Match>
        </Switch>
      )}
    </For>
  )
}

/** 코드 블록의 언어 이름(```rust 등)을 색상 분석기가 아는 형식으로 바꾼다. */
const CODE_LANGS: Record<string, Lang> = {
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  json: 'json',
  js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js',
  rs: 'rust', rust: 'rust',
}

/** 넣기가 서로를 가리킬 때 끝없이 그리지 않도록 깊이를 제한한다. */
const EMBED_DEPTH = 3

function MarkdownView(props: { text: string; context?: PreviewContext; depth?: number; interactive?: boolean }) {
  const blocks = createMemo(() => parseMarkdown(props.text))
  const inline = (items: Inline[]) => <Inlines items={items} context={props.context} />
  // 다른 메모에 넣어져 보이는 글에서는 체크를 누를 수 없다 (누르면 바뀌는 것이 그 메모가 아니라 지금 메모이기 때문에).
  const canToggle = () => props.interactive !== false && !!props.context?.toggleTask

  const list = (block: ListBlock) => {
    const items = (
      <For each={block.items}>
        {(item) => (
          <li classList={{ 'md-task': item.checked !== undefined, done: item.checked === true }}>
            <Show when={item.checked !== undefined}>
              <input
                type="checkbox"
                checked={item.checked}
                disabled={!canToggle()}
                aria-label="완료"
                onChange={() => props.context?.toggleTask?.(item.line)}
              />
            </Show>
            <span class="md-item">{inline(item.children)}</span>
            <Show when={item.sub}>{(sub) => list(sub())}</Show>
          </li>
        )}
      </For>
    )
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
  }

  const render = (block: Block) => {
    switch (block.type) {
      case 'heading':
        // 창 안의 문서이므로 제목 단계를 한 칸 낮춰 페이지의 제목 구조와 겹치지 않게 한다.
        return (
          <Dynamic component={`h${Math.min(6, block.level + 1)}`} class={`md-h${block.level}`} data-line={block.line}>
            {inline(block.children)}
          </Dynamic>
        )
      case 'paragraph':
        return <p>{inline(block.children)}</p>
      case 'quote':
        return <blockquote>{inline(block.children)}</blockquote>
      case 'code':
        return (
          <pre class="md-code">
            <For each={highlight(block.text, CODE_LANGS[block.lang.toLowerCase()])}>
              {(token) => (token.kind ? <span class={`syn-${token.kind}`}>{token.text}</span> : token.text)}
            </For>
          </pre>
        )
      case 'embed': {
        const depth = props.depth ?? 0
        const body = () => props.context?.readNote?.(block.target)
        return (
          <Show
            when={body() !== undefined && depth < EMBED_DEPTH}
            fallback={
              <p>
                <Inlines items={[{ type: 'wikilink', target: block.target, label: block.label, embed: false }]} context={props.context} />
              </p>
            }
          >
            <aside class="md-embed" aria-label={`넣은 메모: ${block.label}`}>
              <button class="md-wikilink md-embed-title" onClick={() => props.context?.openLink(block.target)}>
                {block.label}
              </button>
              <MarkdownView text={body()!} context={props.context} depth={depth + 1} interactive={false} />
            </aside>
          </Show>
        )
      }
      case 'rule':
        return <hr />
      case 'table':
        return (
          <table class="csv-view md-table">
            <thead>
              <tr>
                <For each={block.head}>{(cell) => <th>{inline(cell)}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={block.rows}>
                {(row) => (
                  <tr>
                    <For each={row}>{(cell) => <td>{inline(cell)}</td>}</For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        )
      case 'list':
        return list(block)
    }
  }
  return (
    <Show when={blocks().length} fallback={<p class="preview-empty">내용이 없습니다.</p>}>
      <For each={blocks()}>{render}</For>
    </Show>
  )
}

function JsonView(props: { text: string }) {
  const result = createMemo(() => {
    try {
      return { formatted: JSON.stringify(JSON.parse(props.text), null, 2) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  return (
    <Show
      when={result().formatted !== undefined}
      fallback={
        <p class="preview-error" role="alert">
          올바른 JSON이 아닙니다: {result().error}
        </p>
      }
    >
      <pre class="json-view">
        <For each={highlight(result().formatted!, 'json')}>
          {(token) => (token.kind ? <span class={`syn-${token.kind}`}>{token.text}</span> : token.text)}
        </For>
      </pre>
    </Show>
  )
}

function CsvView(props: { text: string }) {
  const rows = createMemo(() => parseCsv(props.text))
  const width = () => Math.max(0, ...rows().map((row) => row.length))
  /** 줄마다 칸 수가 달라도 표가 어긋나지 않게 빈 칸으로 채운다. */
  const padded = (row: string[]) => Array.from({ length: width() }, (_, i) => row[i] ?? '')
  return (
    <Show when={rows().length} fallback={<p class="preview-empty">내용이 없습니다.</p>}>
      <table class="csv-view">
        <thead>
          <tr>
            <For each={padded(rows()[0]!)}>{(cell) => <th>{cell}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={rows().slice(1)}>
            {(row) => (
              <tr>
                <For each={padded(row)}>{(cell) => <td>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <p class="preview-note">
        {rows().length - 1}줄 · {width()}칸
      </p>
    </Show>
  )
}
