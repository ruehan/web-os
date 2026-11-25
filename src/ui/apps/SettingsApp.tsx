import { For, Show, createSignal } from 'solid-js'
import { ACCENTS, THEMES, setSettings, settings } from '../settings.ts'
import type { AppProps } from './registry.tsx'

export function SettingsApp(props: AppProps) {
  const [confirmingReset, setConfirmingReset] = createSignal(false)
  return (
    <div class="app-pane settings">
      <section>
        <h2>화면 모드</h2>
        <div class="segmented" role="group" aria-label="화면 모드">
          <For each={THEMES}>
            {(theme) => (
              <button aria-pressed={settings.theme === theme.id} onClick={() => setSettings('theme', theme.id)}>
                {theme.name}
              </button>
            )}
          </For>
        </div>
      </section>

      <section>
        <h2>강조색</h2>
        <div class="swatches" role="group" aria-label="강조색">
          <For each={ACCENTS}>
            {(accent) => (
              <button
                class="swatch"
                style={{ '--swatch': `light-dark(${accent.light}, ${accent.dark})` }}
                aria-label={accent.name}
                aria-pressed={settings.accent === accent.id}
                title={accent.name}
                onClick={() => setSettings('accent', accent.id)}
              />
            )}
          </For>
        </div>
      </section>

      <section>
        <h2>저장 공간</h2>
        <p class="hint">
          홈 폴더(<code>/home</code>)의 파일은 이 브라우저에 저장되어 새로고침해도 남습니다. 그 밖의 폴더는 다시 열면 처음
          상태로 돌아갑니다.
        </p>
        <Show
          when={confirmingReset()}
          fallback={
            <button class="tool" onClick={() => setConfirmingReset(true)}>
              홈 폴더 초기화…
            </button>
          }
        >
          <div class="confirm" role="alertdialog" aria-label="홈 폴더 초기화">
            <span>홈 폴더의 파일을 모두 지우고 처음 상태로 되돌립니다.</span>
            <button class="tool danger" onClick={() => props.system.resetStorage()}>
              초기화
            </button>
            <button class="tool" onClick={() => setConfirmingReset(false)}>
              취소
            </button>
          </div>
        </Show>
      </section>

      <section>
        <h2>정보</h2>
        <dl class="facts">
          <dt>버전</dt>
          <dd>Web OS 0.5</dd>
          <dt>실행 중</dt>
          <dd>프로세스 {props.system.procs.length}개</dd>
          <dt>격리</dt>
          <dd>프로세스마다 별도 Worker · 블로킹 시스템 콜</dd>
        </dl>
      </section>
    </div>
  )
}
