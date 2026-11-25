// programs/ 의 Rust 프로그램을 WASI 바이너리로 빌드해 public/bin 에 넣는다.
// 커널은 부팅 때 manifest.json 을 읽어 이 바이너리들을 /bin 에 올린다.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = 'wasm32-wasip1'

const result = spawnSync(
  'cargo',
  ['build', '--release', '--target', target, '--manifest-path', join(root, 'programs/Cargo.toml')],
  { stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status ?? 1)

const releaseDir = join(root, 'programs/target', target, 'release')
const outDir = join(root, 'public/bin')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const names = readdirSync(releaseDir)
  .filter((f) => f.endsWith('.wasm'))
  .map((f) => f.slice(0, -'.wasm'.length))
  .sort()
for (const name of names) {
  copyFileSync(join(releaseDir, `${name}.wasm`), join(outDir, `${name}.wasm`))
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(names))
console.log(`programs: ${names.join(', ')}`)
