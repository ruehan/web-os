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

export const GuideIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M12.8 7.2l-1.4 4.2-4.2 1.4 1.4-4.2z" />
  </Icon>
)

export const TraceIcon = () => (
  <Icon>
    <path d="M3 5.5h8M3 10h5M3 14.5h8" />
    <path d="M13.5 7.5L16 10l-2.5 2.5" />
  </Icon>
)

export const NoteIcon = () => (
  <Icon>
    <path d="M4.5 3.5h11a1 1 0 0 1 1 1v7.5l-4.5 4.5h-7.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" />
    <path d="M16.5 12H13a1 1 0 0 0-1 1v3.5M6.5 7h7M6.5 10h4" />
  </Icon>
)

export const AppsIcon = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="5" height="5" rx="1.2" />
    <rect x="11.5" y="3.5" width="5" height="5" rx="1.2" />
    <rect x="3.5" y="11.5" width="5" height="5" rx="1.2" />
    <rect x="11.5" y="11.5" width="5" height="5" rx="1.2" />
  </Icon>
)

export const PinIcon = () => (
  <Icon size={14}>
    <path d="M7 3.5h6l-1 5 2.5 2.5h-9L8 8.5zM10 11v5.5" />
  </Icon>
)

export const PaintIcon = () => (
  <Icon>
    <path d="M13.2 3.8l3 3-7.4 7.4-3.6.6.6-3.6z" />
    <path d="M3.5 16.5c1.6 0 2.2-.7 2.3-1.7" />
  </Icon>
)

/** 프로세스가 직접 연 창 */
export const ProgramIcon = () => (
  <Icon>
    <rect x="3" y="4" width="14" height="12" rx="1.6" />
    <path d="M3 7.5h14M7.5 12.5l2-1.7-2-1.7M11 12.5h2" />
  </Icon>
)

export const NotepadIcon = () => (
  <Icon>
    <rect x="4" y="3.5" width="12" height="13" rx="1.6" />
    <path d="M7 2.5v2M10 2.5v2M13 2.5v2M7 8.5h6M7 11.5h6M7 14h3" />
  </Icon>
)
