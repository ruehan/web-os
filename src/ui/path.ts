// 절대 경로를 다루는 작은 도우미들.

export const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const dirname = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

/** "/home/guest" → [{ name: "/", path: "/" }, { name: "home", path: "/home" }, ...] */
export function crumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: '/', path: '/' }]
  for (const part of path.split('/').filter(Boolean)) {
    out.push({ name: part, path: join(out.at(-1)!.path, part) })
  }
  return out
}

/** 사람이 읽기 쉬운 크기 표기 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
