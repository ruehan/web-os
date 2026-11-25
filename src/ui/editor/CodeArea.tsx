// 문법 색상이 입혀지는 글 입력 영역.
//
// 입력창(textarea)은 글자마다 색을 다르게 칠할 수 없다. 그래서 색을 입힌 글을 뒤에 깔고,
// 그 위에 글자가 투명한 입력창을 정확히 겹쳐 놓는다. 사용자는 입력창에 치지만 눈에는 뒤의 색 입힌 글이 보인다.
// 두 층의 글꼴, 여백, 줄바꿈 규칙이 완전히 같아야 글자와 커서가 어긋나지 않는다.
import { For, createMemo, type JSX } from 'solid-js'
import { highlight, type Lang } from './highlight.ts'

/** 이보다 긴 글은 색을 입히지 않는다 (입력할 때마다 전체를 다시 분석하므로 느려진다). */
const HIGHLIGHT_LIMIT = 200_000

export function CodeArea(props: {
  value: string
  lang: Lang | undefined
  label: string
  ref?: (el: HTMLTextAreaElement) => void
  onInput(value: string): void
  /** 커서가 움직였을 수 있을 때 (입력, 키, 클릭) */
  onCursor?(el: HTMLTextAreaElement): void
  onKeyDown?: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent>
}) {
  let layer!: HTMLPreElement
  const tokens = createMemo(() =>
    props.value.length > HIGHLIGHT_LIMIT ? [{ text: props.value, kind: '' as const }] : highlight(props.value, props.lang),
  )

  return (
    <div class="code-area">
      <pre class="code-layer" ref={layer} aria-hidden="true">
        <For each={tokens()}>{(token) => (token.kind ? <span class={`syn-${token.kind}`}>{token.text}</span> : token.text)}</For>
        {/* 글이 줄바꿈으로 끝나면 마지막 빈 줄의 높이가 사라지므로, 보이지 않는 글자 하나로 받쳐 준다. */}
        {'​'}
      </pre>
      <textarea
        class="code-input"
        ref={props.ref}
        aria-label={props.label}
        spellcheck={false}
        autocapitalize="off"
        value={props.value}
        onInput={(e) => {
          props.onInput(e.currentTarget.value)
          props.onCursor?.(e.currentTarget)
        }}
        onKeyDown={props.onKeyDown}
        onKeyUp={(e) => props.onCursor?.(e.currentTarget)}
        onClick={(e) => props.onCursor?.(e.currentTarget)}
        // 입력창을 스크롤하면 뒤의 색 입힌 글도 같이 움직여야 한다.
        onScroll={(e) => {
          layer.scrollTop = e.currentTarget.scrollTop
          layer.scrollLeft = e.currentTarget.scrollLeft
        }}
      />
    </div>
  )
}
