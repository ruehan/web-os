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
  server: { headers: isolation },
  preview: { headers: isolation },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
