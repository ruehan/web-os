// 사용자 설정: 화면 모드와 강조색. 브라우저에 저장하고 문서 전체의 CSS 변수로 반영한다.
import { createEffect, createRoot } from 'solid-js'
import { createStore } from 'solid-js/store'

export type Theme = 'system' | 'light' | 'dark'

export const THEMES: { id: Theme; name: string }[] = [
  { id: 'system', name: '시스템' },
  { id: 'light', name: '밝게' },
  { id: 'dark', name: '어둡게' },
]

/** 밝은 배경과 어두운 배경에서 각각 읽히는 색을 짝지어 둔다. */
export const ACCENTS = [
  { id: 'indigo', name: '남색', light: '#4553d6', dark: '#8e9bff' },
  { id: 'teal', name: '청록', light: '#0f7f85', dark: '#5fd3d8' },
  { id: 'rose', name: '장미', light: '#c2356b', dark: '#ff8fb5' },
  { id: 'amber', name: '호박', light: '#a15c00', dark: '#f0b561' },
] as const

export type AccentId = (typeof ACCENTS)[number]['id']

interface Settings {
  theme: Theme
  accent: AccentId
}

const KEY = 'webos.settings'
const DEFAULTS: Settings = { theme: 'system', accent: 'indigo' }

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      theme: THEMES.some((t) => t.id === saved.theme) ? saved.theme : DEFAULTS.theme,
      accent: ACCENTS.some((a) => a.id === saved.accent) ? saved.accent : DEFAULTS.accent,
    }
  } catch {
    return DEFAULTS
  }
}

const [settings, setSettings] = createStore<Settings>(load())
export { settings, setSettings }

createRoot(() => {
  createEffect(() => {
    const root = document.documentElement.style
    const accent = ACCENTS.find((a) => a.id === settings.accent)!
    // light-dark()는 color-scheme을 따르므로, 이 값 하나로 모든 색이 함께 바뀐다.
    root.colorScheme = settings.theme === 'system' ? 'light dark' : settings.theme
    root.setProperty('--accent', `light-dark(${accent.light}, ${accent.dark})`)
    root.setProperty(
      '--accent-soft',
      `light-dark(color-mix(in srgb, ${accent.light} 12%, transparent), color-mix(in srgb, ${accent.dark} 16%, transparent))`,
    )
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 이번 방문 동안만 유지된다.
    }
  })
})
