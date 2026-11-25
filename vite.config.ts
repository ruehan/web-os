import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// SharedArrayBuffer(블로킹 시스템 콜의 기반)는 교차 출처 격리 상태에서만 쓸 수 있다.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [solid()],
  worker: { format: 'es' },
  build: {
    // light-dark()를 그대로 내보낸다. 구형 브라우저용으로 변환되면 시스템 설정만 따르게 되어
    // 설정 앱의 밝게/어둡게 전환이 먹지 않는다. (SharedArrayBuffer 요건상 어차피 최신 브라우저만 지원한다.)
    cssTarget: ['chrome123', 'firefox120', 'safari17.5'],
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
