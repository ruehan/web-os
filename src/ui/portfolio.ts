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
  /** 이 OS 안에서 바로 해 볼 수 있는 것: 단추의 글, 열 앱, 터미널이면 실행할 명령 */
  tries?: { label: string; app: string; run?: string }[]
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

// 아래 내용은 GitHub 프로필(github.com/ruehan)에 공개된 것을 옮긴 초안이다.
// 프로젝트의 세부(맡은 일, 성과)는 프로필에 적힌 만큼만 있으므로, 직접 보태면 된다.
export const portfolio: Portfolio = {
  name: '한규',
  title: 'DX & AI Engineer @ MOISTEN',
  about: [
    '시스템을 만들고, 반복되는 업무를 줄이고, AI를 실무에 붙이는 일을 합니다. 지금은 MOISTEN에서 유통·제조·CS를 잇는 디지털 인프라와 LLM 업무 도구를 맡고 있습니다.',
    '지금 보고 계신 이 운영체제도 제가 만들었습니다. 터미널의 명령과 파일·메모 앱은 Rust로 짜서 WebAssembly로 컴파일한 프로그램이고, 각각 프로세스로 돌면서 직접 만든 커널에 시스템 콜을 보냅니다.',
  ],
  skills: [
    'TypeScript', 'React', 'Next.js', 'Vue.js', 'SolidJS', 'React Native',
    'Python', 'FastAPI', 'Flask', 'Node.js', 'Java',
    'Rust', 'WebAssembly',
    'PostgreSQL', 'MySQL', 'MongoDB',
    'Docker', 'Kubernetes', 'Linux',
  ],
  projects: [
    {
      name: 'Web OS',
      summary: '브라우저 탭 안에서 실제 컴파일된 프로그램이 프로세스로 돌아가는 운영체제. 지금 보고 계신 것입니다.',
      period: '2026.11 ~',
      points: [
        '커널(TypeScript)이 전용 Worker에서 돌고, 프로세스마다 Worker를 하나씩 씁니다. 시스템 콜은 SharedArrayBuffer와 Atomics로 실제로 멈춰 기다립니다.',
        'WASI를 구현해서, Rust로 짠 셸과 명령어 20여 개가 수정 없이 돕니다. 파이프, 리다이렉션, 작업 제어(Ctrl+Z, fg, bg), /proc이 됩니다.',
        '파일·메모·그림판은 화면까지 직접 그리는 프로세스입니다. 프로그램은 픽셀이 아니라 그리기 명령을 보내고, 화면은 그것을 칠합니다.',
        '터미널 에뮬레이터, 정규식 엔진, 마크다운 해석과 배치를 라이브러리 없이 만들었습니다.',
      ],
      tries: [
        { label: '프로세스 보기', app: 'terminal', run: 'ps' },
        { label: '파이프 잇기', app: 'terminal', run: 'yes | head -n 3' },
        { label: '메모 열기', app: 'notes' },
        { label: '시스템 콜 지켜보기', app: 'trace' },
      ],
    },
    {
      name: 'Calmiary',
      summary: '고민을 기록하는 다이어리.',
      link: 'https://calmiary.org',
    },
    {
      name: 'DDang',
      summary: '프로그래머스 데브코스에서 만든 프로젝트. 전공자반 인기 프로젝트상을 받았습니다.',
      link: 'https://github.com/ruehan/WEB1_1_DDang_FE',
    },
  ],
  careers: [
    {
      place: 'MOISTEN',
      role: 'DX & AI Engineer',
      period: '2026.11 ~',
      points: ['유통·제조·CS를 잇는 통합 디지털 인프라 설계', '반복 업무 자동화와 데이터 기반 의사결정 체계', 'LLM 업무 어시스턴트 등 현장에 쓰이는 AI 도입'],
    },
    {
      place: '제로원',
      role: 'S/W Lead Developer',
      period: '2025.04 ~ 2026.10',
      points: [
        '쓸모 (SSEULMO): TMS 기반 음식물 폐기물 수거 서비스. 사진으로 용량을 재고, AI로 폐기물을 분석하고, 수거 경로를 최적화합니다.',
        '담비 (DAMBI): IoT 음식물 폐기물 감량기. 감량기의 상태를 실시간으로 지켜보고, 에너지 효율을 맞춥니다.',
        'FastAPI, React, React Native',
      ],
    },
    { place: 'KETI', role: 'Software Researcher', period: '2021.10 ~ 2023.03', points: ['Python, Flask, Vue.js'] },
  ],
  contacts: [
    { label: 'GitHub', href: 'https://github.com/ruehan' },
    { label: '블로그', href: 'https://hangyu.blog' },
    { label: '이메일', href: 'mailto:gyu@moisten.co.kr' },
  ],
}

/** 아직 아무것도 적지 않았는가 */
export const isEmpty = (p: Portfolio) =>
  !p.name && !p.title && [p.about, p.skills, p.projects, p.careers, p.contacts].every((list) => list.length === 0)
