// programs/ 의 Rust 프로그램을 WASI 바이너리로 빌드하고, rootfs/ 의 기본 파일과 함께
// public/ 아래에 초기 파일 묶음으로 내놓는다. 커널은 부팅 때 initrd.json 을 읽어
// 이 파일들을 메모리 파일시스템에 올린다.
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
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
const binDir = join(root, 'public/bin')
const rootfsSrc = join(root, 'rootfs')
const rootfsOut = join(root, 'public/rootfs')
rmSync(binDir, { recursive: true, force: true })
rmSync(rootfsOut, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })

const bin = readdirSync(releaseDir)
  .filter((f) => f.endsWith('.wasm'))
  .map((f) => f.slice(0, -'.wasm'.length))
  .sort()
for (const name of bin) copyFileSync(join(releaseDir, `${name}.wasm`), join(binDir, `${name}.wasm`))

cpSync(rootfsSrc, rootfsOut, { recursive: true })
const files = readdirSync(rootfsSrc, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name !== '.DS_Store')
  .map((e) => relative(rootfsSrc, join(e.parentPath, e.name)).split('\\').join('/'))
  .sort()

writeFileSync(join(root, 'public/initrd.json'), JSON.stringify({ bin, files }))
console.log(`initrd: ${bin.length} programs, ${files.length} files`)
