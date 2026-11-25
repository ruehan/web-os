import { For } from 'solid-js'
import { ACCENTS, THEMES, setSettings, settings } from '../settings.ts'
import type { AppProps } from './registry.tsx'

export function SettingsApp(props: AppProps) {
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
        <h2>정보</h2>
        <dl class="facts">
          <dt>버전</dt>
          <dd>Web OS 0.4</dd>
          <dt>실행 중</dt>
          <dd>프로세스 {props.system.procs.length}개</dd>
          <dt>격리</dt>
          <dd>프로세스마다 별도 Worker · 블로킹 시스템 콜</dd>
        </dl>
      </section>
    </div>
  )
}
