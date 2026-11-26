// 포트폴리오 페이지에 보일 내용. 화면(PortfolioApp)은 여기 적힌 것만 그대로 보여 준다.
// 지금은 비어 있다. 채우면 그 구역이 나타나고, 비워 두면 "준비 중"으로 보인다.

export interface Project {
  name: string
  /** 한두 줄 소개 */
  summary: string
  /** 맡은 일, 쓴 기술 등 (한 줄씩) */
  points?: string[]
  /** 저장소나 데모의 주소 */
  link?: string
  /** 기간 (예: "2026.03 ~ 2026.11") */
  period?: string
}

export interface Career {
  /** 회사나 단체 */
  place: string
  role: string
  period: string
  points?: string[]
}

export interface Portfolio {
  name: string
  /** 이름 아래의 한 줄 (예: "프런트엔드 개발자") */
  title: string
  /** 자기소개 (문단마다 한 항목) */
  about: string[]
  /** 다루는 기술 */
  skills: string[]
  projects: Project[]
  careers: Career[]
  /** 연락처: 이름표와 주소 (예: { label: 'GitHub', href: 'https://github.com/…' }) */
  contacts: { label: string; href: string }[]
}

export const portfolio: Portfolio = {
  name: '',
  title: '',
  about: [],
  skills: [],
  projects: [],
  careers: [],
  contacts: [],
}

/** 아직 아무것도 적지 않았는가 */
export const isEmpty = (p: Portfolio) =>
  !p.name && !p.title && [p.about, p.skills, p.projects, p.careers, p.contacts].every((list) => list.length === 0)
