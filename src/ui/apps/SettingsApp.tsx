import { For, Show, createEffect, createSignal } from 'solid-js'
import { formatSize } from '../path.ts'
import { ACCENTS, MOUNT_LIMITS, THEMES, setSettings, settings } from '../settings.ts'
import type { AppProps } from './registry.tsx'

export function SettingsApp(props: AppProps) {
  const [confirmingReset, setConfirmingReset] = createSignal(false)
  const [archiveError, setArchiveError] = createSignal('')
  /** 예전 보관 폴더를 골라서, 어느 쪽 내용을 살릴지 묻는 중인가 */
  const [choosing, setChoosing] = createSignal(false)
  const archive = props.system.archive

  /** 폴더 작업을 실행하고, 실패하면 이유를 보여 준다. */
  const attempt = (work: () => Promise<unknown>) => {
    setArchiveError('')
    work().catch((e) => setArchiveError(e instanceof Error ? e.message : String(e)))
  }

  const pick = () => attempt(async () => setChoosing((await archive.pick()) === 'needs-choice'))
  const resolve = (choice: 'export' | 'import' | 'cancel') => {
    setChoosing(false)
    attempt(() => archive.resolve(choice))
  }
  const storage = props.system.storage
  const [protectDenied, setProtectDenied] = createSignal(false)

  // 창을 열 때와 파일이 바뀔 때마다 사용량을 다시 읽는다.
  createEffect(() => {
    props.system.fsVersion()
    void storage.refresh()
  })

  async function protect() {
    setProtectDenied(!(await storage.protect()))
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
          파일은 이 브라우저에 저장되어 새로고침해도 남습니다. 다만 <code>/tmp</code>는 켤 때마다 비우고,{' '}
          <code>/bin</code>의 기본 프로그램은 매번 최신으로 맞춥니다.
        </p>
        <dl class="facts storage-facts" aria-label="저장 상태">
          <Show when={storage.status.usage !== undefined && storage.status.quota}>
            <dt>사용량</dt>
            <dd>
              {formatSize(storage.status.usage!)} / {formatSize(storage.status.quota!)}
            </dd>
          </Show>
          <Show when={storage.status.protected !== undefined}>
            <dt>보호</dt>
            <dd>
              <Show
                when={storage.status.protected}
                fallback={
                  <>
                    <span class="status-error">보호되지 않음</span> · 디스크 공간이 부족해지면 브라우저가 이 데이터를 지울 수
                    있습니다.
                  </>
                }
              >
                보호됨 · 브라우저가 이 데이터를 임의로 지우지 않습니다.
              </Show>
            </dd>
          </Show>
        </dl>
        <Show when={storage.status.protected === false}>
          <button class="tool" onClick={protect}>
            보호 요청
          </button>
          <Show when={protectDenied()}>
            <p class="hint storage-note" role="status">
              브라우저가 아직 허용하지 않았습니다. 이 사이트를 자주 쓰거나, 북마크하거나, 앱으로 설치하면 허용될 수
              있습니다. 그 전까지는 중요한 파일을 따로 보관해 두세요.
            </p>
          </Show>
        </Show>
      </section>

      <section>
        <h2>보관 폴더</h2>
        <Show
          when={archive.supported}
          fallback={
            <p class="hint">
              이 브라우저는 컴퓨터의 폴더에 보관하는 기능을 지원하지 않습니다. 데스크톱의 Chrome이나 Edge에서 사용할 수
              있습니다.
            </p>
          }
        >
          <p class="hint">
            컴퓨터의 폴더 하나를 정해 두면, 모든 디렉터리(<code>/proc</code> 제외)가 그 폴더에도 실제 파일로 저장됩니다.
            브라우저의 데이터가 지워져도 폴더에서 되살릴 수 있습니다. 이 폴더는 Web OS 전용으로 두세요. 폴더에 직접 넣거나
            고친 것은 다음에 연결할 때 이쪽 내용으로 덮어쓰이거나 지워집니다.
          </p>

          <Show when={archive.status.state !== 'none'}>
            <div class="archive-status" aria-label="보관 폴더 상태">
              <div class="mount-text">
                <code>{archive.status.name}</code>
                <small classList={{ 'status-error': !!archive.status.error }}>
                  {archive.status.error ??
                    (archive.status.state === 'linked'
                      ? '연결됨 · 바뀐 내용이 이 폴더에도 저장됩니다'
                      : '멈춤 · 다시 연결하면 그동안 바뀐 내용을 저장합니다')}
                </small>
              </div>
              <Show when={archive.status.state === 'paused'}>
                <button class="tool primary" onClick={() => attempt(archive.resume)}>
                  다시 연결
                </button>
              </Show>
              <button class="tool" onClick={() => attempt(archive.unlink)}>
                연결 해제
              </button>
            </div>
          </Show>

          <Show
            when={choosing()}
            fallback={
              <Show when={archive.status.state === 'none'}>
                <button class="tool" onClick={pick}>
                  보관 폴더 정하기…
                </button>
              </Show>
            }
          >
            <div class="confirm" role="alertdialog" aria-label="보관 폴더의 내용 선택">
              <span>예전에 보관하던 폴더입니다. 어느 쪽 내용을 살릴까요?</span>
              <button class="tool primary" onClick={() => resolve('import')}>
                폴더의 내용 불러오기
              </button>
              <button class="tool danger" onClick={() => resolve('export')}>
                지금 내용으로 폴더 덮어쓰기
              </button>
              <button class="tool" onClick={() => resolve('cancel')}>
                취소
              </button>
              <small class="hint">불러오면 지금 브라우저에 있는 파일은 사라지고 화면이 다시 열립니다.</small>
            </div>
          </Show>

          <Show when={archiveError()}>
            <p class="status-error mount-error" role="alert">
              {archiveError()}
            </p>
          </Show>

          <h3>불러올 수 있는 폴더 크기</h3>
          <div class="segmented" role="group" aria-label="불러올 수 있는 폴더 크기">
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
        <h2>초기화</h2>
        <Show
          when={confirmingReset()}
          fallback={
            <button class="tool" onClick={() => setConfirmingReset(true)}>
              처음 상태로 되돌리기…
            </button>
          }
        >
          <div class="confirm" role="alertdialog" aria-label="처음 상태로 되돌리기">
            <span>
              브라우저에 저장된 파일을 모두 지우고 처음 상태로 되돌립니다. 보관 폴더와의 연결은 끊기지만 폴더의 파일은
              남습니다.
            </span>
            <button class="tool danger" onClick={() => void props.system.resetStorage()}>
              되돌리기
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
          <dd>Web OS 0.6</dd>
          <dt>실행 중</dt>
          <dd>프로세스 {props.system.procs.length}개</dd>
          <dt>격리</dt>
          <dd>프로세스마다 별도 Worker · 블로킹 시스템 콜</dd>
        </dl>
      </section>
    </div>
  )
}
