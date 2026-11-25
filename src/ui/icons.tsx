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
