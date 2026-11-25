// 선으로만 그린 아이콘. 색은 글자색을 따른다.
import type { JSX } from 'solid-js'

const Icon = (props: { children: JSX.Element; size?: number }) => (
  <svg
    width={props.size ?? 20}
    height={props.size ?? 20}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
)

export const TerminalIcon = () => (
  <Icon>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
    <path d="M6 8l2.5 2L6 12M10.5 12.5H14" />
  </Icon>
)

export const ProcessesIcon = () => (
  <Icon>
    <path d="M2.5 10h3l2-5 3.5 10 2-5h4.5" />
  </Icon>
)

export const LogIcon = () => (
  <Icon>
    <path d="M5 5.5h10M5 10h10M5 14.5h6" />
  </Icon>
)

export const MinimizeIcon = () => (
  <Icon size={14}>
    <path d="M5 14h10" />
  </Icon>
)

export const MaximizeIcon = () => (
  <Icon size={14}>
    <rect x="4.5" y="4.5" width="11" height="11" rx="2" />
  </Icon>
)

export const RestoreIcon = () => (
  <Icon size={14}>
    <rect x="4" y="7" width="9" height="9" rx="2" />
    <path d="M7.5 4.5H14a2 2 0 0 1 2 2V13" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon size={14}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </Icon>
)

export const FolderIcon = () => (
  <Icon>
    <path d="M2.5 6a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
  </Icon>
)

export const FileIcon = () => (
  <Icon>
    <path d="M5 4.5a2 2 0 0 1 2-2h4l4 4v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
    <path d="M11 2.5v4h4" />
  </Icon>
)

export const EditorIcon = () => (
  <Icon>
    <path d="M3.5 16.5l.8-3.6 8.9-8.9a1.6 1.6 0 0 1 2.3 0l.5.5a1.6 1.6 0 0 1 0 2.3l-8.9 8.9z" />
    <path d="M11.5 5.7l2.8 2.8" />
  </Icon>
)

export const SettingsIcon = () => (
  <Icon>
    <path d="M3 6h7M14 6h3M3 14h3M10 14h7" />
    <circle cx="12" cy="6" r="2" />
    <circle cx="8" cy="14" r="2" />
  </Icon>
)

export const UpIcon = () => (
  <Icon size={16}>
    <path d="M10 15.5v-11M5.5 9L10 4.5 14.5 9" />
  </Icon>
)
