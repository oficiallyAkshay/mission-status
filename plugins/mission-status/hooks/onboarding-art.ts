// The onboarding's words and pictures: the still backdrop, the 15 second demo frames, the nine session types, the
// consent words. Pure functions and constants, so the tests read them without an engine.
import { badgeSvg, lineSvg, stripSvg, trackSvg } from './bars'

export const WELCOME_PANE = 'mission-status-welcome'
export const WELCOME_TITLE = 'Welcome'
export const SCENE = 'mission-status-onboarding'

export const STEPS = ['Welcome', 'Demo', 'Session types', 'Metrics', 'Done'] as const
export type Step = 0 | 1 | 2 | 3 | 4
export const LAST_STEP: Step = 4

export const WELCOME_LINE = 'This pane shows the goal, the stages and what runs now in each session, beside the chat.'
export const DONE_LINE = 'Your next session fills this pane by itself.'

export const SHARE_LABEL = 'Share anonymous usage'
export const DONT_SHARE_LABEL = "Don't share"
// One sentence: what is sent and what is never sent (product plan, Metrics).
export const CONSENT_LINE =
  'The pane sends only counts, durations and words from fixed lists with one random install id, and never sends your goals, names, files, branches, commands, links, paths or session and account ids.'
export const CONSENT_CHANGE_LINE = 'You can change this choice at any time.'
export const FIELDS_URL = 'https://github.com/oficiallyAkshay/mission-status#metrics'

// The nine session types of v1 (product plan, scope item 2), each with its stage count for the tile drawing.
export const SESSION_TYPES: readonly { name: string; stages: number }[] = [
  { name: 'Feature', stages: 5 },
  { name: 'Bug fix', stages: 5 },
  { name: 'Incident', stages: 4 },
  { name: 'Research', stages: 4 },
  { name: 'Design', stages: 4 },
  { name: 'Board batch', stages: 4 },
  { name: 'Review', stages: 3 },
  { name: 'Migration', stages: 5 },
  { name: 'Writing', stages: 4 },
]

// The demo: one made-up session through five stages in 15 s, three seconds a stage, all stages done in the last
// second. Each frame is drawn by the pane's own drawings in bars.ts.
export const DEMO_MS = 15_000
export const DEMO_STAGES = ['Plan', 'Build', 'Test', 'Deploy', 'Learn'] as const
const DEMO_ACTIONS = ['Reading the plan', 'Writing the code', 'Running the tests', 'Opening the pull request', 'Writing the lessons']
const DEMO_TESTS = 12

export type DemoFrame = {
  track: { source: string; alt: string }
  stages: { name: string; state: 'done' | 'now' | 'next'; badge: string }[]
  helper: { source: string; alt: string }
  tests: { source: string; alt: string; n: number }
  action: string
  isDone: boolean
}

export function demoFrame(ms: number): DemoFrame {
  const t = ((ms % DEMO_MS) + DEMO_MS) % DEMO_MS
  const sec = t / 1000
  const isDone = sec >= 14
  const at = isDone ? DEMO_STAGES.length : Math.min(DEMO_STAGES.length - 1, Math.floor(sec / 3))
  const current = isDone ? null : (DEMO_STAGES[at] ?? null)
  const n = Math.max(0, Math.min(DEMO_TESTS, Math.round(((sec - 6) / 3) * DEMO_TESTS)))
  const helperState = at < 1 ? null : at === 1 ? 'running' : 'done'
  return {
    track: {
      source: trackSvg({ total: DEMO_STAGES.length, done: at, current, isDone, clock: t, names: [...DEMO_STAGES] }),
      alt: isDone ? 'All stages are done.' : `Stage ${at + 1} of ${DEMO_STAGES.length}: ${current ?? ''}`,
    },
    stages: DEMO_STAGES.map((name, k) => {
      const state = k < at ? 'done' : k === at ? 'now' : 'next'
      return { name, state, badge: badgeSvg(state, t, 16) }
    }),
    helper: {
      source: stripSvg({ title: 'Scan tests', detail: 'helper', state: helperState === 'running' ? 'running' : 'done', time: helperState === null ? '00:00' : `00:0${Math.min(9, Math.floor(Math.max(0, sec - 3)))}` }),
      alt: helperState === null ? 'Helper Scan tests: not started' : `Helper Scan tests: ${helperState}`,
    },
    tests: { source: lineSvg(n, DEMO_TESTS), alt: `Tests passing: ${n} of ${DEMO_TESTS}`, n },
    action: isDone ? 'All stages are done' : (DEMO_ACTIONS[at] ?? ''),
    isDone,
  }
}

// A small tile picture for a session type: a rounded track with one dot per stage, the first stage filled.
export function typeTileSvg(stages: number): string {
  const W = 96
  const H = 14
  const step = W / stages
  let dots = ''
  for (let k = 0; k < stages; k++) {
    const cx = (k + 0.5) * step
    dots += k === 0
      ? `<rect x="${(k * step + 2).toFixed(1)}" y="2" width="${(step - 4).toFixed(1)}" height="${H - 4}" rx="4" fill="#7462E8"/>`
      : `<circle cx="${cx.toFixed(1)}" cy="${H / 2}" r="2" fill="#8B7CF6" fill-opacity=".55"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="6" fill="#808080" fill-opacity=".16"/>${dots}</svg>`
}

// The still backdrop: the shader's settled frame, a soft purple bar of light on a dark ground. It shows alone under
// Reduce Motion, on an app that plays no shaders, and when the shader fails. Pure vector, no animation, no comments.
// The bar sits at 28% from the top, the same place the shader settles to (BAR_Y 0.72 with y up), away from the words
// in the middle and the message box at the foot.
export const STILL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">' +
  '<defs>' +
  '<radialGradient id="msHalo" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#7462E8" stop-opacity=".42"/><stop offset=".55" stop-color="#7462E8" stop-opacity=".12"/><stop offset="1" stop-color="#7462E8" stop-opacity="0"/></radialGradient>' +
  '<linearGradient id="msBar" x1="0" x2="1"><stop offset="0" stop-color="#7462E8" stop-opacity="0"/><stop offset=".25" stop-color="#7462E8" stop-opacity=".55"/><stop offset=".5" stop-color="#8B7CF6" stop-opacity=".9"/><stop offset=".75" stop-color="#7462E8" stop-opacity=".55"/><stop offset="1" stop-color="#7462E8" stop-opacity="0"/></linearGradient>' +
  '<radialGradient id="msMote" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#8B7CF6" stop-opacity=".18"/><stop offset="1" stop-color="#8B7CF6" stop-opacity="0"/></radialGradient>' +
  '</defs>' +
  '<rect width="1600" height="1000" fill="#0E0C17"/>' +
  '<ellipse cx="260" cy="720" rx="420" ry="300" fill="url(#msMote)"/>' +
  '<ellipse cx="1320" cy="640" rx="460" ry="320" fill="url(#msMote)"/>' +
  '<ellipse cx="800" cy="280" rx="980" ry="190" fill="url(#msHalo)"/>' +
  '<rect x="0" y="268" width="1600" height="24" rx="12" fill="url(#msBar)"/>' +
  '<rect x="200" y="277" width="1200" height="6" rx="3" fill="#B9AEFF" fill-opacity=".35"/>' +
  '</svg>'
export const STILL_ALT = 'A soft purple bar of light across a dark ground'
