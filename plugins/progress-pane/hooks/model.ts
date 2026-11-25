import type { Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'


// The stage bar of each kind of work: the stages it passes through, in order.
export const PHASES: Record<StageKey, string[]> = {
  plan: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  build: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  review: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  ship: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  fix: ['Reproduce', 'Find cause', 'Fix', 'Test', 'Deploy'],
  cause: ['Reproduce', 'Test causes', 'Confirm cause', 'Fix', 'Learn'],
}
export const STAGE_KEYS = Object.keys(PHASES) as StageKey[]

// Templates: quick choices of stage lists. The model picks one that fits the session, or writes its own stages
// when none fits, and changes them whenever the work changes.
export const TEMPLATES: Record<string, string[]> = {
  feature: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  'product-loop': ['Plan', 'Build', 'Review', 'Deploy', 'Monitor', 'Iterate'],
  'bug-fix': ['Reproduce', 'Find cause', 'Fix', 'Test', 'Deploy'],
  incident: ['Detect', 'Triage', 'Mitigate', 'Root cause', 'Fix', 'Review'],
  research: ['Question', 'Gather', 'Analyze', 'Synthesize', 'Report'],
  design: ['Brief', 'Explore', 'Pick', 'Refine', 'Hand off'],
  'board-batch': ['Intake', 'Plan', 'Build', 'Review', 'Merge'],
  writing: ['Outline', 'Draft', 'Review', 'Publish'],
  migration: ['Plan', 'Dry run', 'Migrate', 'Verify', 'Clean up'],
}
export const HYPOTHESIS_STATES: readonly HypothesisState[] = ['open', 'testing', 'ruled out', 'confirmed']


// One task-list call applied to the steps: a whole list, or advance / done / start on the list as it stands.
export function applyPlan(list: Task[], args: Record<string, unknown>, phase: number): Task[] {
  let next = [...list]
  if (Array.isArray(args.items)) {
    next = (args.items as unknown[])
      .map(raw => {
        const o = (raw ?? {}) as Record<string, unknown>
        const name = typeof o.content === 'string' ? o.content : ''
        const status: Task['status'] = o.status === 'completed' ? 'done' : o.status === 'in_progress' ? 'now' : 'next'
        const was = list.find(x => x.name === name)
        return { name, status, phase: was?.phase ?? phase }
      })
      .filter(x => x.name !== '')
  }
  const set = (i: number, status: Task['status']) => {
    const x = next[i]
    if (x !== undefined) next[i] = { ...x, status, phase: status === 'now' && x.status === 'next' ? phase : x.phase }
  }
  if (args.advance === true) {
    const k = next.findIndex(x => x.status === 'now')
    if (k >= 0) set(k, 'done')
    const n = next.findIndex(x => x.status === 'next')
    if (n >= 0) set(n, 'now')
  }
  if (Array.isArray(args.done)) for (const d of args.done) if (typeof d === 'number') set(d - 1, 'done')
  if (typeof args.start === 'number') set(args.start - 1, 'now')
  return next
}



export const base = (path: unknown) => (typeof path === 'string' ? (path.split('/').pop() ?? path) : '')
export const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// The chat's own status words for a tool call; null for the pane's own calls.
export function actionOf(e: Record<string, unknown>): string | null {
  const tool = String(e.tool ?? '')
  if (tool.startsWith('mcp__progress-pane__') || tool.startsWith('mcp__ccd_') || tool === 'ToolSearch') return null
  if (tool === 'Bash') return 'Running a command'
  if (tool === 'Read') return 'Reading a file'
  if (tool === 'Edit' || tool === 'MultiEdit') return 'Editing a file'
  if (tool === 'Write') return 'Writing a file'
  if (tool === 'Grep' || tool === 'Glob') return 'Searching'
  if (tool === 'Agent' || tool === 'Task') return 'Running a helper'
  if (tool === 'WebSearch') return 'Searching the web'
  if (tool === 'WebFetch') return 'Reading a web page'
  if (tool === 'AskUserQuestion') return 'Waiting for your answer'
  if (tool === 'Skill') return 'Loading a skill'
  if (tool === 'SendMessage') return 'Sending a message'
  return 'Using a tool'
}

// A new turn: the chat shows Thinking until the first tool call.
export function arrivalOf(_text: string): string {
  return 'Thinking'
}


export const ITEM_STATES: readonly ItemStatus[] = ['done', 'now', 'next', 'failed']

export function asItem(raw: unknown): Item | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const name = str(o.name)
  const phase = num(o.phase)
  if (name === null || phase === undefined) return undefined
  const after = str(o.after)
  const parent = str(o.parent)
  const text = str(o.text)
  return {
    phase: Math.round(phase),
    name: cap(name),
    status: ITEM_STATES.find(x => x === o.status) ?? 'next',
    after: after === null ? null : cap(after),
    parent: parent === null ? null : cap(parent),
    when: str(o.when),
    n: num(o.n),
    m: num(o.m),
    text: text === null ? undefined : cap(text),
  }
}

export const figureOf = (c: Count) => (c.text !== undefined ? c.text : c.m === undefined ? `${c.n ?? ''}` : `${c.n ?? 0} of ${c.m}`)

// A stored state from any earlier version: every field this version reads gets a value, so a reload keeps the pane.
export function normalize(raw: Summary): Summary {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const phases = Array.isArray(r.phases) && r.phases.length > 0 ? (r.phases as string[]) : ['Plan', 'Build', 'Test', 'Deploy', 'Learn']
  return {
    project: typeof r.project === 'string' ? r.project : 'Project',
    ticket: (r.ticket as Summary extends infer T ? T extends { ticket: infer K } ? K : never : never) ?? null,
    goalLine: typeof r.goalLine === 'string' ? r.goalLine : null,
    stage: (typeof r.stage === 'string' ? r.stage : 'build') as StageKey,
    phases,
    phase: typeof r.phase === 'number' ? r.phase : 0,
    active: Array.isArray(r.active) ? (r.active as number[]) : [],
    template: typeof r.template === 'string' ? r.template : null,
    symptom: typeof r.symptom === 'string' ? r.symptom : null,
    hypotheses: Array.isArray(r.hypotheses) ? (r.hypotheses as Hypothesis[]) : [],
    waitingOn: typeof r.waitingOn === 'string' ? r.waitingOn : null,
    waitingSince: typeof r.waitingSince === 'number' ? r.waitingSince : 0,
    counts: Array.isArray(r.counts) ? (r.counts as Count[]) : [],
    items: Array.isArray(r.items) ? (r.items as Item[]).map(x => ({ ...x, after: x.after ?? null, parent: x.parent ?? null, when: x.when ?? null })) : [],
    starts: Array.isArray(r.starts) ? (r.starts as (number | null)[]) : phases.map(() => null),
    ends: Array.isArray(r.ends) ? (r.ends as (number | null)[]) : phases.map(() => null),
    change: (r.change as { label: string; from: string; at: number } | null) ?? null,
    at: typeof r.at === 'number' ? r.at : 0,
  }
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// Sentence case: the first letter up, the rest as written, so proper names keep their capitals.
export const cap = (text: string): string => (text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1))

export function asCount(raw: unknown): Count | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const label = str(o.label)
  const n = num(o.n)
  const text = str(o.text)
  const when = str(o.when)
  if (label === null && when === null) return undefined
  const phase = num(o.phase)
  return {
    label: cap(label ?? when ?? ''),
    when: when ?? undefined,
    n,
    m: num(o.m),
    text: text === null ? undefined : cap(text),
    phase: phase === undefined ? undefined : Math.round(phase),
    href: str(o.href) ?? undefined,
    hrefLabel: str(o.hrefLabel) ?? undefined,
  }
}

export function asHypothesis(raw: unknown): Hypothesis | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const text = str(o.text)
  if (text === null) return undefined
  return { text: cap(text), state: HYPOTHESIS_STATES.find(x => x === o.state) ?? 'open' }
}

// The chat's own elapsed form: 12s, then 1m 5s.
export function secondsOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

// A stage timer: MM:SS, or H:MM:SS past an hour.
export function clockOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

export function since(from: number, to: number): string {
  const sec = Math.floor(Math.max(0, to - from) / 1000)
  return sec < 60 ? `${sec} s ago` : `${age(from, to)} ago`
}

export function age(from: number, to: number): string {
  const min = Math.floor(Math.max(0, to - from) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
}

// The pane reads helpers and this branch's pull requests itself.
