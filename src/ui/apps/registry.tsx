// 실행할 수 있는 앱 목록. 앱은 창 안에 그려지는 컴포넌트다.
import type { Accessor, Component, JSX } from 'solid-js'
import type { Size } from '../desktop/geometry.ts'
import {
  EditorIcon,
  FolderIcon,
  GuideIcon,
  LogIcon,
  ProcessesIcon,
  SettingsIcon,
  TerminalIcon,
  TraceIcon,
} from '../icons.tsx'
import type { System } from '../system.ts'
import { EditorApp } from './EditorApp.tsx'
import { FilesApp } from './FilesApp.tsx'
import { LogApp } from './LogApp.tsx'
import { ProcessesApp } from './ProcessesApp.tsx'
import { SettingsApp } from './SettingsApp.tsx'
import { TerminalApp } from './TerminalApp.tsx'
import { TraceApp } from './TraceApp.tsx'
import { WelcomeApp } from './WelcomeApp.tsx'

export interface AppProps {
  system: System
  /** 창을 열 때 받은 인자 (예: 열 파일의 경로) */
  args: Record<string, string>
  /** 이 창이 입력을 받고 있는가 */
  focused: Accessor<boolean>
  /** 창을 바로 닫는다. */
  close(): void
  setTitle(title: string): void
  /** 다른 앱을 실행한다. */
  launch(app: string, args?: Record<string, string>): void
  /** 사용자가 창을 닫으려 할 때 불린다. false를 돌려주면 닫히지 않는다. */
  guardClose(guard: () => boolean): void
  /** 다른 앱이 이 창에 보낸 요청을 받는다 (예: 터미널에서 실행할 명령). */
  onMessage(receiver: (message: string) => void): void
}

export interface AppDef {
  id: string
  name: string
  icon: () => JSX.Element
  component: Component<AppProps>
  size: Size
  /** 창을 하나만 띄우는 앱. 다시 실행하면 기존 창을 앞으로 가져온다. */
  single?: boolean
}

export const APPS: AppDef[] = [
  { id: 'terminal', name: '터미널', icon: TerminalIcon, component: TerminalApp, size: { w: 760, h: 480 } },
  { id: 'files', name: '파일', icon: FolderIcon, component: FilesApp, size: { w: 600, h: 420 } },
  { id: 'editor', name: '편집기', icon: EditorIcon, component: EditorApp, size: { w: 640, h: 460 } },
  { id: 'processes', name: '프로세스', icon: ProcessesIcon, component: ProcessesApp, size: { w: 460, h: 380 }, single: true },
  { id: 'trace', name: '시스템 콜', icon: TraceIcon, component: TraceApp, size: { w: 700, h: 420 }, single: true },
  { id: 'log', name: '시스템 로그', icon: LogIcon, component: LogApp, size: { w: 560, h: 320 }, single: true },
  { id: 'settings', name: '설정', icon: SettingsIcon, component: SettingsApp, size: { w: 440, h: 520 }, single: true },
  { id: 'welcome', name: '시작하기', icon: GuideIcon, component: WelcomeApp, size: { w: 380, h: 580 }, single: true },
]

export const appById = (id: string) => APPS.find((a) => a.id === id)!
