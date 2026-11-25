// 실행할 수 있는 앱 목록. 앱은 창 안에 그려지는 컴포넌트다.
import type { Accessor, Component, JSX } from 'solid-js'
import type { Size } from '../desktop/geometry.ts'
import { LogIcon, ProcessesIcon, TerminalIcon } from '../icons.tsx'
import type { System } from '../system.ts'
import { LogApp } from './LogApp.tsx'
import { ProcessesApp } from './ProcessesApp.tsx'
import { TerminalApp } from './TerminalApp.tsx'

export interface AppProps {
  system: System
  /** 이 창이 입력을 받고 있는가 */
  focused: Accessor<boolean>
  close(): void
  setTitle(title: string): void
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
  { id: 'processes', name: '프로세스', icon: ProcessesIcon, component: ProcessesApp, size: { w: 460, h: 380 }, single: true },
  { id: 'log', name: '시스템 로그', icon: LogIcon, component: LogApp, size: { w: 560, h: 320 }, single: true },
]

export const appById = (id: string) => APPS.find((a) => a.id === id)!
