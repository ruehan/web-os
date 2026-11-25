import { For, Show, createSignal } from 'solid-js'
import { ACCENTS, MOUNT_LIMITS, THEMES, setSettings, settings } from '../settings.ts'
import type { AppProps } from './registry.tsx'

export function SettingsApp(props: AppProps) {
  const [confirmingReset, setConfirmingReset] = createSignal(false)
  const [mountError, setMountError] = createSignal('')
  const mounts = props.system.mounts

  /** 폴더 작업을 실행하고, 실패하면 이유를 보여 준다. */
  const attempt = (work: () => Promise<unknown>) => {
    setMountError('')
    work().catch((e) => setMountError(e instanceof Error ? e.message : String(e)))
  }
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
        <h2>로컬 폴더</h2>
        <Show
          when={mounts.supported}
          fallback={
            <p class="hint">
              이 브라우저는 로컬 폴더 연결을 지원하지 않습니다. 데스크톱의 Chrome이나 Edge에서 사용할 수 있습니다.
            </p>
          }
        >
          <p class="hint">
            컴퓨터의 폴더를 <code>/mnt</code> 아래에 연결하면, 여기서 고친 내용이 실제 파일에 저장됩니다. 연결해 둔
            동안에는 그 폴더를 다른 프로그램에서 고치지 마세요. 같은 파일을 양쪽에서 고치면 이쪽 내용으로 덮어씁니다.
          </p>
          <ul class="mount-list" aria-label="연결된 폴더">
            <For each={mounts.list}>
              {(mount) => (
                <li>
                  <div class="mount-text">
                    <code>{mount.path}</code>
                    <small classList={{ 'status-error': !!mount.error }}>
                      {mount.error ?? (mount.state === 'connected' ? '연결됨' : '다시 연결해야 합니다')}
                    </small>
                  </div>
                  <Show when={mount.state === 'remembered'}>
                    <button class="tool primary" onClick={() => attempt(() => mounts.reconnect(mount.name))}>
                      다시 연결
                    </button>
                  </Show>
                  <button class="tool" onClick={() => attempt(() => mounts.disconnect(mount.name))}>
                    {mount.state === 'connected' ? '연결 해제' : '잊기'}
                  </button>
                </li>
              )}
            </For>
          </ul>
          <button class="tool" onClick={() => attempt(() => mounts.connect())}>
            폴더 연결…
          </button>
          <Show when={mountError()}>
            <p class="status-error mount-error" role="alert">
              {mountError()}
            </p>
          </Show>

          <h3>연결할 수 있는 폴더 크기</h3>
          <div class="segmented" role="group" aria-label="연결할 수 있는 폴더 크기">
            <For each={MOUNT_LIMITS}>
              {(limit) => (
                <button aria-pressed={settings.mountLimit === limit.id} onClick={() => setSettings('mountLimit', limit.id)}>
                  {limit.name}
                </button>
              )}
            </For>
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
