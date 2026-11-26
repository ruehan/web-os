// 절대 경로를 다루는 작은 도우미들.

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** 사람이 읽기 쉬운 크기 표기 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
