// 포트폴리오: 만든 사람의 소개, 프로젝트, 경력, 연락처. 내용은 src/ui/portfolio.ts에 적는다.
// 아직 적지 않은 구역은 "준비 중"으로 보인다.
import { For, Show, type JSX } from 'solid-js'
import { isEmpty, portfolio } from '../portfolio.ts'

/** 바깥으로 나가도 안전한 주소만 링크로 만든다. */
const safe = (href: string) => /^(https?:|mailto:)/i.test(href)

function Section(props: { title: string; empty: boolean; children: JSX.Element }) {
  return (
    <section class="portfolio-section" aria-label={props.title}>
      <h2>{props.title}</h2>
      <Show when={!props.empty} fallback={<p class="portfolio-empty">준비 중입니다.</p>}>
        {props.children}
      </Show>
    </section>
  )
}

export function PortfolioApp() {
  const p = portfolio
  return (
    <div class="app-pane portfolio">
      <header class="portfolio-head">
        <h1>{p.name || '포트폴리오'}</h1>
        <Show when={p.title}>
          <p class="portfolio-title">{p.title}</p>
        </Show>
        <Show when={isEmpty(p)}>
          <p class="portfolio-empty">아직 내용을 채우지 않았습니다. 곧 소개와 프로젝트가 올라옵니다.</p>
        </Show>
      </header>

      <Section title="소개" empty={p.about.length === 0}>
        <For each={p.about}>{(paragraph) => <p>{paragraph}</p>}</For>
      </Section>

      <Section title="기술" empty={p.skills.length === 0}>
        <ul class="portfolio-skills">
          <For each={p.skills}>{(skill) => <li>{skill}</li>}</For>
        </ul>
      </Section>

      <Section title="프로젝트" empty={p.projects.length === 0}>
        <For each={p.projects}>
          {(project) => (
            <article class="portfolio-item">
              <h3>
                <Show when={project.link && safe(project.link)} fallback={project.name}>
                  <a href={project.link} target="_blank" rel="noopener noreferrer">
                    {project.name}
                  </a>
                </Show>
                <Show when={project.period}>
                  <small>{project.period}</small>
                </Show>
              </h3>
              <p>{project.summary}</p>
              <Show when={project.points?.length}>
                <ul>
                  <For each={project.points}>{(point) => <li>{point}</li>}</For>
                </ul>
              </Show>
            </article>
          )}
        </For>
      </Section>

      <Section title="경력" empty={p.careers.length === 0}>
        <For each={p.careers}>
          {(career) => (
            <article class="portfolio-item">
              <h3>
                {career.place} · {career.role}
                <small>{career.period}</small>
              </h3>
              <Show when={career.points?.length}>
                <ul>
                  <For each={career.points}>{(point) => <li>{point}</li>}</For>
                </ul>
              </Show>
            </article>
          )}
        </For>
      </Section>

      <Section title="연락처" empty={p.contacts.length === 0}>
        <ul class="portfolio-contacts">
          <For each={p.contacts.filter((contact) => safe(contact.href))}>
            {(contact) => (
              <li>
                <span>{contact.label}</span>
                <a href={contact.href} target="_blank" rel="noopener noreferrer">
                  {contact.href.replace(/^(https?:\/\/|mailto:)/i, '')}
                </a>
              </li>
            )}
          </For>
        </ul>
      </Section>
    </div>
  )
}
