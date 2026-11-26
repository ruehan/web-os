// 플레이리스트 글의 뼈대를 만든다: pnpm playlist "제목" [유튜브 주소…]
//
// rootfs/usr/share/music/playlists/ 아래에 "날짜-제목.md"를 만든다. 이 폴더의 글은 커밋해서 배포하면
// 누구나 보는 플레이리스트가 된다. 만든 뒤에 파일을 열어 소개글과 곡마다의 이야기를 쓰면 된다.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const [title, ...urls] = process.argv.slice(2)
if (!title || title.startsWith('-')) {
  console.error('사용법: pnpm playlist "제목" [유튜브 주소…]')
  process.exit(1)
}
// 주소로 보이지 않는 것은 곡으로 읽히지 않으므로, 만들기 전에 알린다.
const strange = urls.filter((url) => !/youtu\.?be|^[\w-]{11}$/.test(url))
if (strange.length > 0) {
  console.error(`유튜브 주소가 아닙니다: ${strange.join(', ')}`)
  process.exit(1)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(root, 'rootfs/usr/share/music/playlists')
const now = new Date()
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
// 파일 이름에 쓸 수 없는 글자만 바꾼다 (한글은 그대로 둔다).
const slug = title.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
const file = join(dir, `${date}-${slug}.md`)
if (existsSync(file)) {
  console.error(`이미 있습니다: ${relative(root, file)}`)
  process.exit(1)
}

const songs = urls.map((url) => `${url}\n(이 곡에 대한 글)\n`).join('\n')
mkdirSync(dir, { recursive: true })
writeFileSync(file, `# ${title.trim()}\n날짜: ${date}\n\n(소개글)\n\n${songs}`)
console.log(`만들었습니다: ${relative(root, file)}`)
console.log('글을 쓴 뒤 커밋해서 배포하면 누구나 볼 수 있습니다.')
