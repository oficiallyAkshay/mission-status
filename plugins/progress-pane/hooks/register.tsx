import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, ProgressProps, Register, RenderChildren, SvgProps } from 'claude-code'

import { badgeSvg, exitSvg, slideSvg, stripSvg, trackSvg } from './bars'
import type { Activity, Count, Task, Git, Ticket, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, Summary } from '../types'

const PANE = 'vaani'
// The pane's one accent, the purple of the stage bar; the app's own accent is orange.
const ACCENT = '#8B7CF6'
const TITLE = 'Progress'
const TICK_MS = 5_000 // the pane reads helpers every 5 s
const CLOCK_MS = 1_000 // and redraws its timers every second
const PR_EVERY = 6 // and pull requests every sixth tick, every 30 s

// The stage bar of each kind of work: the stages it passes through, in order.
export const PHASES: Record<StageKey, string[]> = {
  plan: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  build: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  review: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  ship: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  fix: ['Reproduce', 'Find cause', 'Fix', 'Test', 'Deploy'],
  cause: ['Reproduce', 'Test causes', 'Confirm cause', 'Fix', 'Learn'],
}
const STAGE_KEYS = Object.keys(PHASES) as StageKey[]

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
const HYPOTHESIS_STATES: readonly HypothesisState[] = ['open', 'testing', 'ruled out', 'confirmed']

// Shape tags decline what an earlier version stored, which outlives a reload.
const summary = atom({ plugin: 'progress-pane', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const live = atom({ plugin: 'progress-pane', key: 'live' } as const, null as Live | null, { shape: 'live' })
// The pane clock: a write every tick redraws every age on the pane.
const now = atom({ plugin: 'progress-pane', key: 'now' } as const, 0)
// The stages the person opened; null means the current stage only.
const open = atom({ plugin: 'progress-pane', key: 'open' } as const, null as string[] | null)
// The session's task list, as the app shows it, each step slotted into a stage.
const tasks = atom({ plugin: 'progress-pane', key: 'tasks' } as const, [] as Task[])

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

// The latest action of the session, as the chat shows it: the current card's live line.
const activity = atom({ plugin: 'progress-pane', key: 'activity' } as const, null as Activity)

const base = (path: unknown) => (typeof path === 'string' ? (path.split('/').pop() ?? path) : '')
const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

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

const say = async ($: EngineInterface, text: string) =>
  update($, activity, old => (old !== null && old.text === text ? old : { text, prev: old?.text ?? null, at: Date.now() }))

const ITEM_STATES: readonly ItemStatus[] = ['done', 'now', 'next', 'failed']

function asItem(raw: unknown): Item | undefined {
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

const figureOf = (c: Count) => (c.text !== undefined ? c.text : c.m === undefined ? `${c.n ?? ''}` : `${c.n ?? 0} of ${c.m}`)

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

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// Sentence case: the first letter up, the rest as written, so names like Vaani keep theirs.
export const cap = (text: string): string => (text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1))

function asCount(raw: unknown): Count | undefined {
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

function asHypothesis(raw: unknown): Hypothesis | undefined {
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
let ticks = 0
async function poll($: EngineInterface, withPrs = true): Promise<void> {
  let helpers: Helper[] = []
  try {
    helpers = (await $.agent.list()).map(a => ({
      id: a.id,
      description: a.description,
      status: String(a.taskStatus ?? a.status),
      model: a.model ?? null,
      startTime: a.startTime,
    }))
  } catch {}
  const before = await read($, live).catch(() => null)
  let prs: Pr[] = before?.prs ?? []
  let prsUnread = before?.prsUnread ?? false
  if (withPrs) try {
    prs = []
    prsUnread = false
    const branch = await $.process.run(['git', 'branch', '--show-current'])
    const head = branch.stdout.trim()
    if (branch.exitCode === 0 && head !== '') {
      const out = await $.process.run(
        ['gh', 'pr', 'list', '--head', head, '--state', 'all', '--json', 'number,state,url,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup'],
        { timeoutMs: 20_000 },
      )
      if (out.exitCode === 0) prs = (JSON.parse(out.stdout) as Record<string, unknown>[]).map(asPr)
      else prsUnread = true
    }
  } catch {
    prsUnread = true
  }
  let git: Git = before?.git ?? null
  if (withPrs) git = await readGit($).catch(() => null)
  try {
    await update($, live, () => ({ helpers, prs, prsUnread, at: Date.now(), reads: (before?.reads ?? 0) + 1, git }))
  } catch {
    // The session or the reload ended while the read ran: the next tick writes again.
  }
}

// The branch against main: commits ahead, files and lines changed, and files not yet committed.
async function readGit($: EngineInterface): Promise<Git> {
  const run = async (argv: string[]) => {
    const r = await $.process.run(argv, { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  }
  const branch = await run(['git', 'branch', '--show-current'])
  if (branch === null || branch === '') return null
  const base = (await run(['git', 'merge-base', 'HEAD', 'origin/main'])) ?? (await run(['git', 'merge-base', 'HEAD', 'main']))
  const ahead = base === null ? 0 : Number((await run(['git', 'rev-list', '--count', `${base}..HEAD`])) ?? 0)
  const behind = Number((await run(['git', 'rev-list', '--count', 'HEAD..origin/main'])) ?? 0)
  const stat = base === null ? '' : ((await run(['git', 'diff', '--shortstat', base])) ?? '')
  const pick = (re: RegExp) => Number(stat.match(re)?.[1] ?? 0)
  const dirty = ((await run(['git', 'status', '--porcelain'])) ?? '').split('\n').filter(Boolean).length
  return { branch, ahead, behind, files: pick(/(\d+) files? changed/), added: pick(/(\d+) insertions?/), removed: pick(/(\d+) deletions?/), dirty }
}

// One pull request with its CI state folded to one word: passing, failing, running, or none.
export function asPr(o: Record<string, unknown>): Pr {
  const checks = Array.isArray(o.statusCheckRollup) ? (o.statusCheckRollup as Record<string, unknown>[]) : []
  const word = (c: Record<string, unknown>) => String(c.conclusion ?? c.state ?? c.status ?? '').toUpperCase()
  const ci =
    checks.length === 0
      ? 'none'
      : checks.some(c => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(word(c)))
        ? 'failing'
        : checks.some(c => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(word(c)))
          ? 'running'
          : 'passing'
  return {
    number: Number(o.number ?? 0),
    state: String(o.state ?? ''),
    url: String(o.url ?? ''),
    title: String(o.title ?? ''),
    isDraft: o.isDraft === true,
    review: String(o.reviewDecision ?? ''),
    merge: String(o.mergeStateStatus ?? ''),
    ci,
  }
}

// The facts of a pull request and its branch, as short words with the colour of their state.
export function prFacts(pr: Pr | undefined, g: Git): { text: string; tone: 'success' | 'error' | 'warning' | 'dim' }[] {
  const out: { text: string; tone: 'success' | 'error' | 'warning' | 'dim' }[] = []
  if (pr !== undefined) {
    out.push(
      pr.state === 'MERGED'
        ? { text: 'Merged', tone: 'success' }
        : pr.state === 'CLOSED'
          ? { text: 'Closed', tone: 'error' }
          : pr.isDraft === true
            ? { text: 'Draft', tone: 'dim' }
            : { text: 'Open', tone: 'dim' },
    )
    if (pr.state === 'OPEN') {
      if (pr.ci === 'passing') out.push({ text: 'CI passing', tone: 'success' })
      if (pr.ci === 'failing') out.push({ text: 'CI failing', tone: 'error' })
      if (pr.ci === 'running') out.push({ text: 'CI running', tone: 'warning' })
      if (pr.review === 'APPROVED') out.push({ text: 'Approved', tone: 'success' })
      if (pr.review === 'CHANGES_REQUESTED') out.push({ text: 'Changes requested', tone: 'error' })
      if (pr.review === 'REVIEW_REQUIRED') out.push({ text: 'Review needed', tone: 'warning' })
      if (pr.merge === 'DIRTY') out.push({ text: 'Conflicts', tone: 'error' })
    }
  }
  if (g !== null) {
    if ((g.behind ?? 0) > 0) out.push({ text: `${g.behind} behind main`, tone: 'warning' })
    if (g.added + g.removed > 0) out.push({ text: `+${g.added} −${g.removed}`, tone: 'dim' })
    if (g.dirty > 0) out.push({ text: `${g.dirty} not committed`, tone: 'warning' })
  }
  return out
}

async function tick($: EngineInterface): Promise<void> {
  try {
    await update($, now, () => Date.now())
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'update',
      description:
        'Progress pane: send the whole state; the pane redraws it in place. Call it at every meaningful change, in ' +
        'place of a count line in the chat. Write all text in ASD-STE100 Simplified Technical English: each sentence has a ' +
        'subject and a verb, in the active voice and the present tense, about 20 words at most. Labels are one to four words. ' +
        'Every count has a denominator m where one exists. The pane itself reads the task list, git, pull requests and helpers. ' +
        'At every update, look again at the stages: keep a template only while it fits, and change the stages when the work changes.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'The project name, for example: Vaani Claude mod' },
          ticket: {
            type: ['object', 'null'],
            description: 'The ticket this work answers, when there is one: its reference, its title and its link.',
            properties: { ref: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } },
            required: ['ref'],
          },
          template: {
            type: 'string',
            enum: Object.keys(TEMPLATES),
            description: `A quick choice of stages: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.join(', ')})`).join('; ')}. Pick one only when it fits; otherwise send phases.`,
          },
          active: {
            type: 'array',
            items: { type: 'number' },
            description: 'Indexes of stages that are in progress at the same time as phase, when stages run in parallel.',
          },
          phases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Your own stage names, 2 to 8, in order, when the stage kind does not fit: for example Plan, Build, Review, Deploy, Monitor, Iterate.',
          },
          goalLine: {
            type: ['string', 'null'],
            description:
              'One or two full sentences on the goal, for example: The pane shows the live counts beside the chat. The chat shows only the items that need you.',
          },
          stage: {
            type: 'string',
            enum: STAGE_KEYS,
            description: 'plan or build or review or ship: stages Plan, Build, Test, Deploy, Learn. fix: Reproduce, Find cause, Fix, Test, Deploy. cause: Reproduce, Test causes, Confirm cause, Fix, Learn.',
          },
          phase: { type: 'number', description: 'Index of the current stage, from 0. The count of stages means all are done.' },
          symptom: { type: ['string', 'null'], description: 'For fix and cause: one sentence on what goes wrong.' },
          hypotheses: {
            type: 'array',
            description: 'For cause: each suspected cause and its state.',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, state: { type: 'string', enum: HYPOTHESIS_STATES } },
              required: ['text', 'state'],
            },
          },
          waitingOn: { type: ['string', 'null'], description: 'A wait on something other than the owner, for example: the CI gate check' },
          items: {
            type: 'array',
            description:
              'The work inside each stage, drawn as nested cards. parent names the item that holds this one (cards nest to any depth). after names the sibling this one waits for. Siblings with no after run in parallel. when is the item\'s own exit clause, with n and m, n, or text as for counts.',
            items: {
              type: 'object',
              properties: {
                phase: { type: 'number' },
                name: { type: 'string', description: 'One to four words' },
                status: { type: 'string', enum: ITEM_STATES },
                after: { type: 'string' },
                parent: { type: 'string' },
                when: { type: 'string', description: 'The end of the sentence: Done when ...' },
                n: { type: 'number' },
                m: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['phase', 'name', 'status'],
            },
          },
          counts: {
            type: 'array',
            description:
              'The exit clause of each stage: when the stage is done, and how far it is. when is the end of the sentence "Done when ...", for example: all pane tests pass; you approve the look; the pull request merges. Give n and m for x of y (only when a fixed total exists), n alone for a plain count, text for a status word (Waiting, Met), or none of them.',
            items: {
              type: 'object',
              properties: {
                phase: { type: 'number', description: 'Index of the stage this exit clause belongs to' },
                when: { type: 'string', description: 'The end of the sentence: Done when ...' },
                label: { type: 'string', description: 'A short name for the figure, for example: Tests' },
                n: { type: 'number' },
                text: { type: 'string', description: 'A word in place of a number, for example: Waiting, Yes, No' },
                m: { type: 'number' },
                href: { type: 'string' },
                hrefLabel: { type: 'string' },
              },
              required: ['when'],
            },
          },
        },
        required: ['project', 'stage', 'phase'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'progress-pane', description: 'Open the Vaani progress pane' })
    $.clock.every(CLOCK_MS, () => void tick($))
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void poll($, ticks % PR_EVERY === 0)
    })
    void poll($)
    if ((await read($, summary)) !== null) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const words = (() => {
      try {
        return actionOf(e as unknown as Record<string, unknown>)
      } catch {
        return null
      }
    })()
    // The action line is a nicety: a failed write never holds up the call.
    if (words !== null) await say($, words).catch(() => undefined)
    const result = await next(e)
    // Between tool calls the model thinks, as the chat shows.
    if (words !== null) await say($, 'Thinking').catch(() => undefined)
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Slotting: the pane reads the session's task list itself. A step goes into the stage that is in progress when the
  // step first appears; it stays there.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    try {
      const args = e as unknown as Record<string, unknown>
      const sum = await read($, summary)
      const at = sum === null ? 0 : Math.min(sum.phase, Math.max(0, sum.phases.length - 1))
      await update($, tasks, list => applyPlan(list, args, at))
    } catch {
      // The task list is a nicety: a failed read never holds up the call.
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('turn.complete', async ($, e, next) => {
    await say($, 'Waiting for you').catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await say($, arrivalOf(String((e as unknown as { text?: unknown }).text ?? ''))).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A standing rule for the model: keep the pane current and look again at its stages.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    return {
      sections: [
        ...result.sections,
        {
          id: 'progress-pane:progress',
          scope: 'session' as const,
          text:
            '# Progress pane\nKeep the progress pane current with mcp__progress-pane__update at every meaningful change. ' +
            'At each update, look again at the stages: keep a template only while it fits the work, and send new stages when the work changes. ' +
            'Stages may run in parallel (active). The pane reads the task list, git, pull requests and helpers itself: do not send those.',
        },
      ],
    }
  })

  on('command.run', { command: 'progress-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void poll($)
    return { text: 'The Vaani progress pane is open.' }
  })

  on('tool.call', { tool: 'mcp__progress-pane__update' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const at = Date.now()
    await update($, summary, stored => {
      const old = normalize(stored)
      const stage = STAGE_KEYS.find(k => k === args.stage) ?? old?.stage ?? 'build'
      const custom = (Array.isArray(args.phases) ? args.phases : []).map(str).filter((x): x is string => x !== null).map(cap)
      const picked = typeof args.template === 'string' ? TEMPLATES[args.template] : undefined
      const phases =
        custom.length >= 2 && custom.length <= 8
          ? custom
          : picked !== undefined
            ? picked
            : args.phases === undefined && old !== null
              ? old.phases
              : PHASES[stage]
      const template = custom.length >= 2 ? null : typeof args.template === 'string' && picked !== undefined ? args.template : (old?.template ?? null)
      const active = (Array.isArray(args.active) ? args.active : old?.active ?? [])
        .map(num)
        .filter((k): k is number => k !== undefined && k >= 0 && k < phases.length)
        .map(k => Math.round(k))
      const phase = Math.max(0, Math.min(phases.length, Math.round(num(args.phase) ?? old?.phase ?? 0)))
      const counts =
        args.counts === undefined
          ? (old?.counts ?? [])
          : (Array.isArray(args.counts) ? args.counts : []).map(asCount).filter((c): c is Count => c !== undefined)
      const movedPair = counts
        .map(c => ({ c, was: old?.counts.find(x => x.label === c.label) }))
        .find(({ c, was }) => was !== undefined && figureOf(was) !== figureOf(c))
      const items =
        args.items === undefined
          ? (old?.items ?? [])
          : (Array.isArray(args.items) ? args.items : []).map(asItem).filter((x): x is Item => x !== undefined)
      const waitingRaw = str(args.waitingOn)
      // Stage times: a stage starts when the phase first reaches it and ends when the phase passes it. Stages passed
      // before the pane first saw the work have no times.
      const starts = phases.map((_, k) => old?.starts?.[k] ?? null)
      const ends = phases.map((_, k) => old?.ends?.[k] ?? null)
      if (old === null || old.phases.join('|') !== phases.join('|')) {
        starts.fill(null)
        ends.fill(null)
      }
      for (let k = 0; k < phases.length; k++) {
        if ((k === phase || active.includes(k)) && starts[k] === null) starts[k] = at
        if (k < phase && ends[k] === null && starts[k] !== null) ends[k] = at
        if (k >= phase || active.includes(k)) ends[k] = null
        if (k > phase && !active.includes(k)) starts[k] = null
      }
      const ticketRaw = args.ticket as Record<string, unknown> | null | undefined
      const ticket: Ticket | null =
        ticketRaw === undefined
          ? (old?.ticket ?? null)
          : ticketRaw === null || str(ticketRaw.ref) === null
            ? null
            : { ref: str(ticketRaw.ref) ?? '', title: str(ticketRaw.title), url: str(ticketRaw.url) }
      return {
        active,
        template,
        ticket,
        starts,
        ends,
        project: str(args.project) ?? old?.project ?? 'Project',
        goalLine: args.goalLine === undefined ? (old?.goalLine ?? null) : str(args.goalLine),
        stage,
        phases,
        phase,
        symptom: args.symptom === undefined ? (old?.symptom ?? null) : str(args.symptom),
        hypotheses:
          args.hypotheses === undefined
            ? (old?.hypotheses ?? [])
            : (Array.isArray(args.hypotheses) ? args.hypotheses : []).map(asHypothesis).filter((x): x is Hypothesis => x !== undefined),
        waitingOn: waitingRaw,
        waitingSince: waitingRaw !== null && waitingRaw === old?.waitingOn ? old.waitingSince : at,
        counts,
        items,
        change: movedPair !== undefined && movedPair.was !== undefined ? { label: movedPair.c.label, from: figureOf(movedPair.was), at } : (old?.change ?? null),
        at,
      }
    })
    await tick($)
    // With no surface attached there is nowhere to open the pane; the state is kept for the next surface.
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    void poll($)
    return { result: 'The pane shows the new state.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Link, Button } = ui
    // Svg draws the bars; Progress stands in where Svg is missing, and a surface with neither shows the figures only.
    const extra = ui as unknown as { Progress?: ElementConstructor<ProgressProps>; Svg?: ElementConstructor<SvgProps> }
    const { Progress, Svg } = extra
    const s = normalize(await read($, summary))
    const l = await read($, live)
    const t = Math.max(await read($, now), s?.at ?? 0, l?.at ?? 0)

    // The Update button asks the model for a fresh state: it starts a turn, as a message from the person would.
    const askUpdate = () =>
      void $.prompt
        .submit({ text: 'Update the progress pane: look again at the stages and the work, then send the whole state.' })
        .catch(() => undefined)
    const { Button: UpdateButton } = $.ui.resolve(e)
    if (s === null)
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>The pane has no progress data yet.</Text>
          <UpdateButton key="update-empty" label="Update" variant="primary" onPress={askUpdate} />
        </Box>
      )
    const steps = await read($, tasks)
    // The model's items plus the task list's steps, each in its stage. A step the model also names shows once.
    const allItems: Item[] = [
      ...s.items,
      ...steps
        .filter(x => !s.items.some(y => y.name.toLowerCase() === x.name.toLowerCase()))
        .map(x => ({ phase: x.phase, name: cap(x.name), status: x.status, after: null, parent: null, when: null }) as Item),
    ]

    // isInteractive draws the picture in a sandboxed frame, where its <title> tooltips show on hover.
    const svg = (source: string, alt: string, height: number, key?: string, isInteractive?: boolean) =>
      Svg === undefined ? null : <Svg key={key} source={source} alt={alt} height={height} isInteractive={isInteractive === true ? true : undefined} />
    const row = (left: RenderChildren, right: RenderChildren, key?: string) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2} key={key}>
        {left}
        {right}
      </Box>
    )
    const small = (text: string, color?: string) => (
      <Text size="caption" dimColor={color === undefined} color={color}>
        {text}
      </Text>
    )

    const total = s.phases.length
    const isDone = s.phase >= total
    const current = isDone ? null : (s.phases[s.phase] ?? null)

    // What the pane reads itself.
    const helpersAll = l?.helpers ?? []
    const running = helpersAll.filter(x => x.status === 'running')
    const prs = l?.prs ?? []
    const merged = prs.filter(p => p.state === 'MERGED').length

    // One measure per stage. The pane supplies pull requests for a Deploy stage that has none.
    const deploy = s.phases.indexOf('Deploy')
    const measures: Count[] = [...s.counts]
    if (deploy >= 0 && prs.length > 0 && !measures.some(c => c.phase === deploy))
      measures.push({ label: 'Pull requests merged', when: 'every pull request merges', n: merged, m: prs.length, phase: deploy })

    // Columns: open control, mark, stage, measure label, figure. The figure column has one width, right-aligned.
    const CHEV = 3
    // The badge column and the gap beside it: names start this far in, and a child indents by the same amount.
    const BADGE = 2
    const INDENT = BADGE + 1
    const MARK = 2
    const FIG = 12
    // What is open, by key: a stage by its index, an item by its name. By default every stage and item in progress.
    const defaultOpen = [
      `stage-${s.phase}`,
      ...allItems.filter(x => x.status === 'now').map(x => `item-${x.name}`),
    ]
    const openList = (await read($, open)) ?? defaultOpen
    const opened = s.phases.map((_, k) => k).filter(k => openList.includes(`stage-${k}`))
    const isOpenKey = (key: string) => openList.includes(key)
    const toggleKey = (key: string) =>
      update($, open, list => {
        const now = list ?? defaultOpen
        return now.includes(key) ? now.filter(x => x !== key) : [...now, key]
      })
    const toggle = (k: number) => toggleKey(`stage-${k}`)

    // The figure on a card follows the kind of exit clause: a status word, x of y, a plain x, or nothing.
    const isMet = (c: Count) =>
      c.text !== undefined ? /^(met|yes|done|approved|merged|passed)$/i.test(c.text) : c.m !== undefined && c.n !== undefined && c.n >= c.m
    const figureCell = (c: Count, isDim: boolean) => {
      if (c.text === undefined && c.n === undefined) return null
      const figure = figureOf(c)
      const change = s.change !== null && s.change.label === c.label ? s.change : null
      const isRecent = change !== null && t - change.at < 10 * 60_000
      if (c.href !== undefined)
        return (
          <Text>
            {`${figure} `}
            <Link href={c.href}>{c.hrefLabel ?? 'Open'}</Link>
          </Text>
        )
      // In the first seconds after a change, the new figure slides in over the old one.
      if (change !== null && Date.now() - change.at < 8_000 && Svg !== undefined)
        return svg(slideSvg(change.from, figure, Date.now() - change.at, true), `${c.label}: ${figure}`, 22)
      if (c.text !== undefined)
        // A status word reads as a word, in the colour of its state, not as a large number.
        return (
          <Text weight="semibold" color={isMet(c) ? 'success' : isDim ? undefined : 'warning'} dimColor={isDim && !isMet(c)}>
            {c.text}
          </Text>
        )
      return (
        <Text size="heading" weight="semibold" dimColor={isDim && !isRecent} color={isRecent ? ACCENT : isMet(c) ? 'success' : undefined}>
          {figure}
        </Text>
      )
    }

    const itemMark: Record<ItemStatus, string> = { done: '✓', now: '●', next: '○', failed: '✕' }
    const itemColor: Record<ItemStatus, string> = { done: 'success', now: ACCENT, next: 'subtle', failed: 'error' }
    // The items of a stage as a tree: an item that waits for another sits indented under it; items side by side run in parallel.
    // Items are cards, nested to any depth by parent. Siblings in order: an item that waits for another follows it
    // after the other's gate; siblings with no wait between them run in parallel.
    const itemState = (x: Item): 'done' | 'now' | 'next' => (x.status === 'done' ? 'done' : x.status === 'now' ? 'now' : 'next')
    const orderSiblings = (list: Item[]) => {
      const out: Item[] = []
      const left = [...list]
      let guard = 0
      while (left.length > 0 && guard++ < 64) {
        const k = left.findIndex(x => x.after === null || !left.some(y => y.name === x.after))
        out.push(...left.splice(k < 0 ? 0 : k, 1))
      }
      return out
    }
    const itemCards = (list: Item[], depth: number): RenderChildren => {
      const ordered = orderSiblings(list)
      const parallel = ordered.filter(x => x.after === null && x.status !== 'done').length
      return (
        <Box flexDirection="column" gap={0} marginTop={depth === 0 ? 1 : 0}>
          {parallel > 1 && small(`${parallel} items run in parallel.`)}
          {ordered.map((x, j) => {
            const kids = allItems.filter(y => y.parent === x.name && y.phase === x.phase)
            const key = `item-${x.name}`
            const isOpen = kids.length > 0 && isOpenKey(key)
            const state = itemState(x)
            const exit: Count | null = x.when === null ? null : { label: x.name, when: x.when, n: x.n, m: x.m, text: x.text }
            const nextWaits = ordered[j + 1]?.after === x.name
            // One row: badge, name, figure, open control. Only an item with children gets a card around it.
            const head = (
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Box width={BADGE} flexShrink={0}>
                  {Svg !== undefined
                    ? svg(badgeSvg(state, 0, 16), `${x.name}: ${state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'not started'}`, 16)
                    : <Text color={itemColor[x.status]}>{itemMark[x.status]}</Text>}
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text weight={state === 'now' ? 'semibold' : 'regular'} dimColor={state === 'next'} wrap="truncate">
                    {x.name}
                  </Text>
                </Box>
                {kids.length > 0 && (
                  <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
                    <Button key={`open-${key}`} label={isOpen ? '−' : '+'} plain dimColor onPress={() => toggleKey(key)} />
                  </Box>
                )}
              </Box>
            )
            return (
              <Box flexDirection="column" gap={0} key={key}>
                {head}
                {isOpen && depth < 5 && <Box paddingLeft={INDENT}>{itemCards(kids, depth + 1)}</Box>}
                {exit !== null && Svg !== undefined && svg(exitSvg(exit.when ?? '', !nextWaits), `Done when ${exit.when}.`, 28)}
              </Box>
            )
          })}
        </Box>
      )
    }
    const itemTree = (k: number) => (
      // A stage's items are its children: they start where the stage name starts, as nested items start under theirs.
      <Box flexDirection="column" gap={0} paddingLeft={INDENT}>
        {itemCards(allItems.filter(x => x.phase === k && (x.parent === null || !allItems.some(y => y.name === x.parent && y.phase === k))), 0)}
      </Box>
    )

    // Each stage is a card: a status badge, the stage name over its measure, the figure large on the right, and an
    // open control when the stage has items. The current stage's card carries the accent border.
    const stageRow = (name: string, k: number) => {
      // One stage is in progress at a time: the current one.
      const state = k < s.phase && !s.active.includes(k) ? 'done' : k === s.phase || s.active.includes(k) ? 'now' : 'next'
      const mine = measures.filter(c => c.phase === k && c.m !== 0)
      const hasItems = allItems.some(x => x.phase === k)
      const isOpen = hasItems && opened.includes(k)
      const isDim = state === 'next'
        return (
        <Box
          flexDirection="column"
          gap={0}
          key={`stage-${k}`}
          borderStyle="single"
          borderColor={state === 'now' ? ACCENT : 'subtle'}
          borderDimColor={state !== 'now'}
          paddingX={1}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={BADGE} flexShrink={0}>
              {Svg !== undefined ? svg(badgeSvg(state, 0), `${name}: ${state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'not started'}`, 20) : <Text>{state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text weight="semibold" dimColor={isDim}>{name}</Text>
              </Box>
            </Box>
            <Box flexShrink={0} width={FIG} flexDirection="row" justifyContent="flex-end">
              {(() => {
                // The time on the stage: live on the current one, the time taken on a done one, nothing ahead.
                const from = s.starts?.[k] ?? null
                const to = state === 'done' ? (s.ends?.[k] ?? null) : state === 'now' ? Date.now() : null
                if (from === null || to === null) return <Text>{''}</Text>
                return (
                  <Text weight="semibold" color={state === 'now' ? ACCENT : undefined} dimColor={state === 'done'}>
                    {clockOf(to - from)}
                  </Text>
                )
              })()}
            </Box>
            <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {hasItems ? (
                <Button key={`open-${k}`} label={isOpen ? '−' : '+'} plain dimColor onPress={() => toggle(k)} />
              ) : (
                <Text>{''}</Text>
              )}
            </Box>
          </Box>
          {state === 'now' && act !== null && Date.now() - act.at < 30 * 60_000 && (
            // The live line has the card's full width and ends in an ellipsis when it is too long.
            <Box paddingLeft={INDENT} paddingRight={1}>
              {/* Always text, at one size: a drawn slide used a smaller font than the text after it. */}
              <Text dimColor wrap="truncate-end">{`${act.text}  ${secondsOf(Date.now() - act.at)}`}</Text>
            </Box>
          )}
          {isOpen && itemTree(k)}
          {state === 'now' &&
            s.waitingOn !== null && (
              <Box paddingLeft={INDENT} marginTop={1}>
                {row(
                  <Text color="warning">{`The work waits on ${s.waitingOn.charAt(0).toLowerCase()}${s.waitingOn.slice(1)}.`}</Text>,
                  small(age(s.waitingSince, t)),
                )}
              </Box>
            )}
          {state === 'now' && Svg !== undefined && running.length > 0 && (
            <Box flexDirection="column" gap={0} paddingLeft={INDENT} marginTop={1}>
              {running.slice(0, 4).map(x =>
                svg(
                  stripSvg({ title: cap(x.description), detail: x.model, state: 'running', time: age(x.startTime, t) }),
                  `Helper ${x.description}: running`,
                  22,
                  `strip-${x.id}`,
                ),
              )}
              {running.length > 4 && small(`${running.length - 4} more helpers run.`)}
            </Box>
          )}
        </Box>
      )
    }

    const hypoMark: Record<HypothesisState, string> = { open: '○', testing: '●', 'ruled out': '✕', confirmed: '✓' }
    const hypoColor: Record<HypothesisState, string> = { open: 'subtle', testing: ACCENT, 'ruled out': 'subtle', confirmed: 'success' }
    const confirmed = s.hypotheses.find(x => x.state === 'confirmed')
    const act = await read($, activity)
    // The characters a full-width line holds in this pane, at about 7 px for each 12 px character.
    const room = Math.max(20, Math.floor(((e.props.bodyColumns || 50) * 8 - 64) / 7))
    const fit = (text: string) => (text.length > room ? `${text.slice(0, room - 1)}…` : text)

    // Tooltips on the stage bar: for each stage, its state, its time and its exit clause.
    // Tooltips on the stage bar: state, the time a done stage took, and the clause. Nothing in them changes each
    // second, so the drawing stays the same between redraws and does not flicker.
    const tips = s.phases.map((name, k) => {
      const isNow = k === s.phase || s.active.includes(k)
      const from = s.starts?.[k] ?? null
      const to = !isNow && k < s.phase ? (s.ends?.[k] ?? null) : null
      const exit = measures.find(c => c.phase === k && c.when !== undefined)
      const state = isNow ? 'In progress' : k < s.phase ? 'Done' : 'Not started'
      return [
        `${name}: ${state}${from !== null && to !== null ? `, took ${clockOf(to - from)}` : ''}.`,
        exit !== undefined ? `Done when ${exit.when}.` : '',
      ].filter(Boolean).join(' ')
    })
    // The git bar: one line, closed by default; open, it lists the facts behind the line.
    const g = l?.git ?? null
    const isGitOpen = isOpenKey('git')
    // Merge state: done once the pull request merges, in progress while one is open or work is committed, else ahead.
    const mergeState: 'done' | 'now' | 'next' =
      prs[0]?.state === 'MERGED' ? 'done' : prs[0]?.state === 'OPEN' || (g !== null && g.ahead > 0) ? 'now' : 'next'
    const gitBar =
      g === null && prs.length === 0 ? null : (
        // Merge is a stage card like the others: a badge for its state, its name, its facts as the subline.
        <Box
          flexDirection="column"
          gap={0}
          borderStyle="single"
          borderColor={mergeState === 'now' ? ACCENT : 'subtle'}
          borderDimColor={mergeState !== 'now'}
          paddingX={1}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={BADGE} flexShrink={0}>
              {Svg !== undefined
                ? svg(badgeSvg(mergeState, 0), `Merge: ${mergeState === 'done' ? 'done' : mergeState === 'now' ? 'in progress' : 'not started'}`, 20)
                : <Text>{mergeState === 'done' ? '✓' : mergeState === 'now' ? '●' : '○'}</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text weight="semibold" dimColor={mergeState === 'next'}>Merge</Text>
              <Box flexDirection="row" gap={2}>
                {prFacts(prs[0], g).map((f, k) => (
                  <Text key={`gf-${k}`} size="caption" color={f.tone === 'dim' ? undefined : f.tone} dimColor={f.tone === 'dim'}>
                    {f.text}
                  </Text>
                ))}
              </Box>
            </Box>
            <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              <Button key="open-git" label={isGitOpen ? '−' : '+'} plain dimColor onPress={() => toggleKey('git')} />
            </Box>
          </Box>
          {isGitOpen && (
            <Box flexDirection="column" gap={0} marginTop={1} paddingLeft={INDENT}>
              {g !== null && (
                <Box flexDirection="row" gap={2}>
                  <Box flexShrink={0}>{small('Branch')}</Box>
                  <Box flexGrow={1} flexShrink={1} flexDirection="row" justifyContent="flex-end">
                    <Text size="caption" dimColor wrap="truncate-middle">{g.branch}</Text>
                  </Box>
                </Box>
              )}
              {g !== null && row(small('Commits ahead of main'), small(`${g.ahead}`))}
              {g !== null && row(small('Commits behind main'), small(`${g.behind ?? 0}`, (g.behind ?? 0) > 0 ? 'warning' : undefined))}
              {g !== null && g.files > 0 && row(small('Files changed'), small(`${g.files}`))}
              {g !== null && g.added + g.removed > 0 && row(small('Lines'), small(`+${g.added} −${g.removed}`))}
              {g !== null && g.dirty > 0 && row(small('Files not committed'), small(`${g.dirty}`, 'warning'))}
              {prs.map(p =>
                row(
                  <Text size="caption">
                    <Link href={`${p.url}/files`}>{`#${p.number}`}</Link>
                    {`  ${p.title}`}
                  </Text>,
                  small(p.state === 'MERGED' ? 'Merged' : p.state === 'CLOSED' ? 'Closed' : 'Open'),
                  `git-pr-${p.number}`,
                ),
              )}
            </Box>
          )}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={2}>
        // The header: the title and the Update button share one centred row; the goal sits one line below it.
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text size="heading" weight="semibold" wrap="truncate-end">{`Project: ${s.project}`}</Text>
            </Box>
            <Box flexShrink={0}>
              <UpdateButton key="update" label="Update" variant="secondary" onPress={askUpdate} />
            </Box>
          </Box>
          {s.ticket !== null && (
            <Text>
              {s.ticket.url !== null ? <Link href={s.ticket.url}>{s.ticket.ref}</Link> : s.ticket.ref}
              {s.ticket.title !== null ? <Text dimColor>{`  ${s.ticket.title}`}</Text> : null}
            </Text>
          )}
          {s.goalLine !== null && <Text dimColor>{s.goalLine}</Text>}
        </Box>

        {Svg !== undefined
          ? svg(
              trackSvg({ total, done: Math.min(s.phase, total), current, isDone, clock: 0, names: s.phases, tips }),
              isDone ? 'All stages are done.' : `Stage ${s.phase + 1} of ${total}: ${current}`,
              30,
              'stage-bar',
              true,
            )
          : Progress !== undefined
            ? <Progress label="Stages" value={Math.min(s.phase, total)} max={total} valueText={`${Math.min(s.phase, total)} of ${total}`} color="success" />
            : null}

        {(s.stage === 'fix' || s.stage === 'cause') && s.symptom !== null && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {small('Symptom')}
              <Text>{s.symptom}</Text>
            </Box>
            {confirmed !== undefined && (
              <Box flexDirection="column">
                {small('Cause', 'success')}
                <Text color="success">{confirmed.text}</Text>
              </Box>
            )}
            {s.stage === 'cause' &&
              s.hypotheses.map((x, k) => (
                <Box flexDirection="row" key={`hypo-${k}`}>
                  <Box width={MARK} flexShrink={0}>
                    <Text color={hypoColor[x.state]}>{hypoMark[x.state]}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    {row(
                      <Text dimColor={x.state === 'ruled out' || x.state === 'open'}>{x.text}</Text>,
                      small(cap(x.state), x.state === 'confirmed' ? 'success' : undefined),
                    )}
                  </Box>
                </Box>
              ))}
          </Box>
        )}

        <Box flexDirection="column" gap={0}>
          {s.phases.map((name, k) => {
            const exit = measures.find(c => c.phase === k && c.when !== undefined) ?? null
            const isLast = k === s.phases.length - 1 && gitBar === null
            return (
              <Box flexDirection="column" gap={0} key={`flow-${k}`}>
                {stageRow(name, k)}
                {exit !== null &&
                  (Svg !== undefined
                    ? svg(
                        exitSvg(exit.when ?? '', isLast),
                        `Done when ${exit.when}.`,
                        28,
                      )
                    : small(`Done when ${exit.when}.`))}
                {exit === null && !isLast && <Box height={1}><Text>{''}</Text></Box>}
              </Box>
            )
          })}
          {gitBar}
          {gitBar !== null && Svg !== undefined && svg(exitSvg('the pull request merges', true), 'Done when the pull request merges.', 28)}
        </Box>
      </Box>
    )
  })
}
