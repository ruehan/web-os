// 형식별 보기: 마크다운은 서식을 입혀서, JSON은 가지런히 정리해서, CSV는 표로 보여 준다.
import { For, Match, Show, Switch, createMemo } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { parseCsv } from './csv.ts'
import { highlight, type Lang } from './highlight.ts'
import { parseMarkdown, type Block, type Inline } from './markdown.ts'

/** 미리보기를 제공하는 형식 */
export const previewable = (lang: Lang | undefined): lang is 'markdown' | 'json' | 'csv' =>
  lang === 'markdown' || lang === 'json' || lang === 'csv'

export function Preview(props: { text: string; lang: 'markdown' | 'json' | 'csv' }) {
  return (
    <div class="preview" role="document" aria-label="미리보기">
      <Switch>
        <Match when={props.lang === 'markdown'}>
          <MarkdownView text={props.text} />
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

function Inlines(props: { items: Inline[] }) {
  return (
    <For each={props.items}>
      {(item) => (
        <Switch>
          <Match when={item.type === 'text' && item}>{(t) => t().text}</Match>
          <Match when={item.type === 'code' && item}>{(c) => <code>{c().text}</code>}</Match>
          <Match when={item.type === 'strong' && item}>
            {(s) => (
              <strong>
                <Inlines items={s().children} />
              </strong>
            )}
          </Match>
          <Match when={item.type === 'em' && item}>
            {(e) => (
              <em>
                <Inlines items={e().children} />
              </em>
            )}
          </Match>
          <Match when={item.type === 'link' && item}>
            {(l) => (
              // 바깥 사이트는 새 탭에서 열고, 이 페이지에 접근할 수 없게 한다.
              <a href={l().href} target="_blank" rel="noopener noreferrer">
                <Inlines items={l().children} />
              </a>
            )}
          </Match>
        </Switch>
      )}
    </For>
  )
}

function MarkdownView(props: { text: string }) {
  const blocks = createMemo(() => parseMarkdown(props.text))
  const render = (block: Block) => {
    switch (block.type) {
      case 'heading': {
        // 창 안의 문서이므로 제목 단계를 한 칸 낮춰 페이지의 제목 구조와 겹치지 않게 한다.
        return (
          <Dynamic component={`h${Math.min(6, block.level + 1)}`} class={`md-h${block.level}`}>
            <Inlines items={block.children} />
          </Dynamic>
        )
      }
      case 'paragraph':
        return (
          <p>
            <Inlines items={block.children} />
          </p>
        )
      case 'quote':
        return (
          <blockquote>
            <Inlines items={block.children} />
          </blockquote>
        )
      case 'code':
        return <pre class="md-code">{block.text}</pre>
      case 'rule':
        return <hr />
      case 'list': {
        const items = (
          <For each={block.items}>
            {(item) => (
              <li>
                <Inlines items={item} />
              </li>
            )}
          </For>
        )
        return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
      }
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
