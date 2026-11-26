// The onboarding's words and pictures: the still backdrop, the 15 second demo frames and the consent words. Pure functions and constants, so the tests read them without an engine.
import { stripSvg, trackSvg } from './bars'

export const WELCOME_PANE = 'mission-status-welcome'
export const WELCOME_TITLE = 'Welcome'
export const SCENE = 'mission-status-onboarding'

export const STEPS = ['Welcome', 'Choices'] as const
export type Step = 0 | 1

export const WELCOME_LINE = 'This pane shows the goal, the stages and what runs now in each session, beside the chat.'

export const SHARE_LABEL = 'Share anonymous usage'
export const AUTO_LABEL = 'Update automatically'
export const AUTO_LINE = 'New releases install between turns, never while the agent works.'
// The switch: a rounded track with a knob, accent when on, grey when off.
export function switchSvg(isOn: boolean): string {
  const track = isOn ? '#7462E8' : '#808080'
  const opacity = isOn ? '1' : '.45'
  const x = isOn ? 24 : 10
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="20">' +
    `<rect x="1" y="1" width="32" height="18" rx="9" fill="${track}" fill-opacity="${opacity}"/>` +
    `<circle cx="${x}" cy="10" r="7" fill="#fff"/></svg>`
  )
}
// One sentence: what is sent and what is never sent (product plan, Metrics).
export const CONSENT_LINE =
  'The pane sends only counts, durations and words from fixed lists with one random install id, and never sends your goals, names, files, branches, commands, links, paths or session and account ids.'
export const CONSENT_CHANGE_LINE = 'You can change this choice at any time.'
export const FIELDS_URL = 'https://github.com/oficiallyAkshay/mission-status#metrics'

// The demo: one made-up session through five stages in 15 s, three seconds a stage, all stages done in the last
// second, then round again. Each frame is drawn by the pane's own drawings in bars.ts: the stage bar, one status line
// and one helper strip.
export const DEMO_MS = 15_000
export const DEMO_STAGES = ['Plan', 'Build', 'Test', 'Deploy', 'Learn'] as const
const DEMO_ACTIONS = ['Reading the plan', 'Editing a file', 'Running a command', 'Opening the pull request', 'Writing the lessons']

export type DemoFrame = {
  track: { source: string; alt: string }
  helper: { source: string; alt: string }
  action: string
  isDone: boolean
}

const mmss = (sec: number) => `00:${String(Math.max(0, Math.min(59, Math.floor(sec)))).padStart(2, '0')}`

export function demoFrame(ms: number): DemoFrame {
  const t = ((ms % DEMO_MS) + DEMO_MS) % DEMO_MS
  const sec = t / 1000
  const isDone = sec >= 14
  const at = isDone ? DEMO_STAGES.length : Math.min(DEMO_STAGES.length - 1, Math.floor(sec / 3))
  const current = isDone ? null : (DEMO_STAGES[at] ?? null)
  // The helper runs through Build and Test, from 3 s to 9 s.
  const helper = sec < 3 ? 'waiting' : sec < 9 ? 'running' : 'done'
  return {
    track: {
      source: trackSvg({ total: DEMO_STAGES.length, done: at, current, isDone, clock: t, names: [...DEMO_STAGES] }),
      alt: isDone ? 'All cards are done.' : `Stage ${at + 1} of ${DEMO_STAGES.length}: ${current ?? ''}`,
    },
    helper: {
      source: stripSvg({ title: 'Scan tests', detail: 'helper', state: helper === 'done' ? 'done' : 'running', time: mmss(helper === 'waiting' ? 0 : Math.min(sec, 9) - 3) }),
      alt: `Helper Scan tests: ${helper === 'waiting' ? 'starting' : helper}`,
    },
    action: isDone ? 'All cards are done' : (DEMO_ACTIONS[at] ?? ''),
    isDone,
  }
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
