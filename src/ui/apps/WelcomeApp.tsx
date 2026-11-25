// 첫 방문자를 위한 안내. 무엇을 보고 있는지 설명하고, 눌러서 바로 해 볼 수 있게 한다.
import { For } from 'solid-js'
import type { AppProps } from './registry.tsx'

const TRY: { title: string; command: string; note?: string }[] = [
  { title: '어떤 프로그램이 있는지 보기', command: 'ls -l /bin' },
  { title: '프로그램 두 개를 파이프로 잇기', command: 'yes | head -n 3', note: 'head가 끝나면 yes도 함께 종료됩니다.' },
  { title: '실행 중인 프로세스 보기', command: 'ps' },
  { title: '프로세스를 실시간으로 지켜보기', command: 'top', note: '화면 전체를 쓰는 프로그램입니다. q로 나갑니다.' },
  {
    title: '터미널에서 파일 고치기',
    command: 'vi README.md',
    note: 'i로 입력을 시작하고 Esc로 마칩니다. :wq 는 저장하고 나가기, :q! 는 버리고 나가기입니다.',
  },
  {
    title: '멈추지 않는 프로그램 돌리기',
    command: 'spin',
    note: 'CPU를 계속 쓰지만 화면은 멈추지 않습니다. Ctrl+C 또는 프로세스 앱에서 종료하세요.',
  },
]

export function WelcomeApp(props: AppProps) {
  return (
    <div class="app-pane welcome">
      <h1>Web OS</h1>
      <p>
        브라우저 탭 안에서 돌아가는 작은 운영체제입니다. 터미널의 명령은 흉내 낸 것이 아니라 Rust로 작성해
        WebAssembly로 컴파일한 실제 프로그램이고, 각각 별도의 프로세스로 실행되어 커널에 시스템 콜을 보냅니다.
      </p>

      <h2>터미널에서 해 보기</h2>
      <ul class="try-list">
        <For each={TRY}>
          {(item) => (
            <li>
              <div class="try-text">
                <span>{item.title}</span>
                <code>{item.command}</code>
                {item.note && <small>{item.note}</small>}
              </div>
              <button
                class="tool primary"
                aria-label={`실행: ${item.command}`}
                onClick={() => props.launch('terminal', { run: item.command })}
              >
                실행
              </button>
            </li>
          )}
        </For>
      </ul>

      <h2>더 둘러보기</h2>
      <ul class="try-list">
        <li>
          <div class="try-text">
            <span>파일 탐색기</span>
            <small>홈 폴더의 파일은 새로고침해도 남습니다. 직접 컴파일한 .wasm 파일을 끌어다 놓으면 터미널에서 실행할 수 있습니다.</small>
          </div>
          <button class="tool" onClick={() => props.launch('files')}>
            열기
          </button>
        </li>
        <li>
          <div class="try-text">
            <span>시스템 콜</span>
            <small>프로그램이 커널에 보내는 요청을 실시간으로 봅니다. 열어 둔 채 터미널에서 명령을 실행해 보세요.</small>
          </div>
          <button class="tool" onClick={() => props.launch('trace')}>
            열기
          </button>
        </li>
        <li>
          <div class="try-text">
            <span>프로세스</span>
            <small>실행 중인 프로세스를 보고 종료할 수 있습니다.</small>
          </div>
          <button class="tool" onClick={() => props.launch('processes')}>
            열기
          </button>
        </li>
      </ul>

      <p class="hint">이 안내는 왼쪽 막대의 나침반 아이콘으로 언제든 다시 열 수 있습니다.</p>
    </div>
  )
}
