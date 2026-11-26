import { openPane } from './surface'
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Fresh, Item, Live, Marks, Runs, Summary, Task, Wakeup } from '../types'
import { type Derived, type Facts, derive, itemKey, mergeItems, stageKey } from './machine'
import { MAX_FAILS } from './marker'
import { AUTO_OPEN_CALLS, CHECK_MS, checkLine, FIRST_REMINDER, TURN_TEXT, HOLD_TEXT, IGNORED_AFTER, IGNORED_LIMIT, REMINDER, REMIND_MS, STALE_STEPS, autoSummary, normalize } from './model'

export const PANE = 'progress'
// The pane's one accent, the purple of the stage bar; the app's own accent is orange.
export const ACCENT = '#8B7CF6'
export const TITLE = 'Mission status'
export const TICK_MS = 5_000 // the pane reads helpers every 5 s
export const CLOCK_MS = 1_000 // and redraws its timers every second


// Shape tags decline what an earlier version stored, which outlives a reload.
export const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
export const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })
// The pane clock: a write every tick redraws every age on the pane.
export const now = atom({ plugin: 'mission-status', key: 'now' } as const, 0)
// The stages the person opened; null means the current stage only.
export const open = atom({ plugin: 'mission-status', key: 'open' } as const, null as string[] | null)
// The session's task list, as the app shows it, each step slotted into a stage.
export const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
// One ScheduleWakeup call: a new wakeup replaces the one before it (the loop has one), and stop clears it.
export function applyWakeup(list: Wakeup[], args: Record<string, unknown>, at: number): Wakeup[] {
  if (args.stop === true) return []
  const secs = typeof args.delaySeconds === 'number' ? Math.min(3600, Math.max(60, args.delaySeconds)) : null
  if (secs === null) return list
  const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'Scheduled check'
  return [{ reason, due: at + secs * 1000, at }]
}


export async function tick($: EngineInterface): Promise<void> {
  try {
    await update($, now, () => Date.now())
  } catch {}
}

// ---- Live facts and the state machine (machine.ts) ----

// A main-loop turn runs now: set at its turn.start, cleared at its turn.complete (any reason) and at session start and
// end. Not saved, so a restore reads it closed.
export const turnOpen = atom({ plugin: 'mission-status', key: 'turnOpen' } as const, false as boolean)
// Background work still in flight at the last turn end (register.tsx writes it at each turn end).
const background = atom({ plugin: 'mission-status', key: 'background' } as const, false as boolean)
// The turn waits on the person: a question to them is open.
export const waiting = atom({ plugin: 'mission-status', key: 'waiting' } as const, false as boolean)
// The newest thing the session did that the pane saw: a main-loop tool call, a turn's start or end, a task-list change,
// wrap-up or the agent's update. The header's age reads this, not the agent's last write alone.
export const seenAt = atom({ plugin: 'mission-status', key: 'seenAt' } as const, 0)
export async function noteEvent($: EngineInterface): Promise<void> {
  const t = await nowOf($)
  await update($, seenAt, old => Math.max(old ?? 0, t)).catch(() => undefined)
}

// Running time per node: ms already counted, and when the node last became running (null while it is not running).
export const runs = atom({ plugin: 'mission-status', key: 'runs' } as const, {} as Runs)
// The marker's kept marks (marker.ts writes them).
// A headless run (claude -p, an SDK host, a helper job): no person sees a pane (metrics.tsx writes it at session start).
const headless = atom({ plugin: 'mission-status', key: 'headless' } as const, false as boolean)
const marks = atom({ plugin: 'mission-status', key: 'marks' } as const, null as Marks | null)

// The item that holds the running helpers: the last item in progress in the current stage, not one named as the stage.
export function hostOf(s: NonNullable<Summary>, items: Item[]): string | null {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const x = [...items].reverse().find(i => i.phase === s.phase && i.status === 'now' && !same(i.name, s.phases[s.phase] ?? ''))
  return x === undefined ? null : itemKey(x)
}

// Everything the machine reads, from the stores, and its derive.
export async function deriveNow($: EngineInterface): Promise<{ s: NonNullable<Summary>; items: Item[]; d: Derived; facts: Facts } | null> {
  const s = normalize(await read($, summary))
  if (s === null) return null
  const steps = (await read($, tasks)) ?? []
  const l = await read($, live)
  const m = await read($, marks).catch(() => null)
  const base: Facts = {
    // A turn runs, or background work it started still runs: the work is live either way.
    turnOpen: (await read($, turnOpen)) === true || (await read($, background).catch(() => false)) === true,
    waiting: (await read($, waiting)) === true,
    helpersRunning: (l?.helpers ?? []).some(h => h.status === 'running'),
    hostKey: null,
    ci: (l as { ci?: Facts['ci'] } | null)?.ci ?? {},
    marks: m?.marks ?? {},
  }
  const items = mergeItems(s, steps, base)
  const facts = { ...base, hostKey: hostOf(s, items) }
  return { s, items, d: derive(s, items, facts), facts }
}

// The running time: a node that runs now has a start; a node that stopped adds its span. Idempotent: a second run at
// the same time changes nothing, so racing calls cannot count a span twice.
export function settleRuns(old: Runs, running: Set<string>, t: number): Runs {
  const next: Runs = {}
  let changed = false
  for (const [key, r] of Object.entries(old)) {
    if (r.from !== null && !running.has(key)) {
      next[key] = { ms: r.ms + Math.max(0, t - r.from), from: null }
      changed = true
    } else next[key] = r
  }
  for (const key of running) {
    const r = next[key]
    if (r === undefined || r.from === null) {
      next[key] = { ms: r?.ms ?? 0, from: t }
      changed = true
    }
  }
  return changed ? next : old
}

// The pane's state lives in $.state, which an app quit loses, so each change is also saved to $.store under the
// session's transcript file name (register.tsx takes it back). Saved only from settle, which runs after every change.
const prRefs = atom({ plugin: 'mission-status', key: 'prRefs' } as const, [] as string[])
const prBranches = atom({ plugin: 'mission-status', key: 'prBranches' } as const, [] as string[])
const SAVED_INDEX = 'savedPanes'
const SAVED_MAX = 20
export async function savedKey($: EngineInterface): Promise<string | null> {
  const path = (await $.session.info().catch(() => null))?.transcriptPath ?? ''
  const name = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? ''
  return /^[\w-]{8,80}$/.test(name) ? `pane-${name}` : null
}
// The last value saved, so a settle with nothing new writes nothing.
let lastSaved = ''
export async function savePane($: EngineInterface): Promise<void> {
  const value = { summary: await read($, summary), tasks: await read($, tasks), prRefs: await read($, prRefs), prBranches: await read($, prBranches), at: Date.now() }
  if (value.summary === null) return
  // Checked before the key, so a settle with nothing new does not even ask for the session's file name.
  const seen = JSON.stringify([value.summary, value.tasks, value.prRefs, value.prBranches])
  if (seen === lastSaved) return
  const key = await savedKey($)
  if (key === null) return
  lastSaved = seen
  await $.store.set(key, value)
  const index = ((await $.store.get(SAVED_INDEX).catch(() => undefined)) as string[] | undefined) ?? []
  if (index[index.length - 1] === key) return
  const next = [...index.filter(k => k !== key), key]
  for (const old of next.slice(0, Math.max(0, next.length - SAVED_MAX))) await $.store.delete(old).catch(() => undefined)
  await $.store.set(SAVED_INDEX, next.slice(-SAVED_MAX))
}
// After every fact that can change a status: settle the running times and save the pane. Answers whether anything runs or counts.
export async function settle($: EngineInterface): Promise<boolean> {
  try {
    const got = await deriveNow($)
    const t = await nowOf($)
    const running = new Set<string>()
    if (got !== null) {
      for (const x of got.items) if (got.d.item(x) === 'running') running.add(itemKey(x))
      got.s.phases.forEach((_, k) => {
        if (got.d.stage(k) === 'running') running.add(stageKey(k))
      })
    }
    const after = await update($, runs, old => settleRuns(old ?? {}, running, t))
    await savePane($).catch(() => undefined)
    return running.size > 0 || Object.values(after ?? {}).some(r => r.from !== null)
  } catch {
    return false
  }
}

// The marker runs: traffic allowed, and it has not stopped after failed calls. Where it does
// not run, the reminders and the held turn end stay, so the agent still keeps the pane current.
export async function markerRuns($: EngineInterface): Promise<boolean> {
  try {
    if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return false
    if (await read($, headless)) return false
    return ((await read($, marks))?.fails ?? 0) < MAX_FAILS
  } catch {
    return false
  }
}

// For the update tool's reply: each item the agent called done that shows open, and why. Empty when none.
export async function heldReasons($: EngineInterface): Promise<string> {
  try {
    const got = await deriveNow($)
    if (got === null) return ''
    const lines = got.items
      .filter(x => x.status === 'done' && got.d.item(x) === 'open')
      .map(x => got.d.reason(itemKey(x)))
      .filter((r): r is string => r !== null)
    return lines.length === 0 ? '' : ` Shown as open, not done: ${lines.slice(0, 5).join('; ')}.`
  } catch {
    return ''
  }
}

// The 1 s clock: it writes only while something runs (the state machine's word, not a stored "now"), so an idle
// session redraws nothing and costs nothing.
export async function tickIfTimer($: EngineInterface): Promise<void> {
  try {
    // A timer shows the counted time plus the span since its start, so the tick only redraws: it reads one value and
    // writes the clock. Statuses change on events (turns, tool calls, updates) and on the 5 s read, which settle.
    if (Object.values((await read($, runs)) ?? {}).some(r => r.from !== null)) await tick($)
  } catch {}
}


// ---- Freshness triggers (product plan, "How the state stays current") ----

export const FRESH0: Fresh = {
  calls: 0,
  lastAgentAt: null,
  windowFrom: 0,
  steps: 0,
  stale: false,
  held: false,
  outstanding: -1,
  ignored: 0,
}
// The triggers' record: tool calls, the stale window, the reminders sent and ignored. It outlives a reload.
export const fresh = atom({ plugin: 'mission-status', key: 'fresh' } as const, FRESH0)

// The engine's clock where it answers, else the wall clock.
export async function nowOf($: EngineInterface): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

// One ignored reminder more; at the limit the state is marked "May be out of date".
function ignore(f: Fresh): Fresh {
  return { ...f, outstanding: -1, ignored: f.ignored + 1 }
}

async function markOutOfDate($: EngineInterface, f: Fresh): Promise<void> {
  if (f.ignored < IGNORED_LIMIT) return
  await update($, summary, s => {
    const old = normalize(s)
    if (old === null || old.mayBeOutOfDate === true) return s
    return { ...old, mayBeOutOfDate: true, version: (old.version ?? 0) + 1 } as Summary
  })
  await settle($)
}

// After each main-loop tool call other than the pane's own: counts it, opens the pane at the 5th call with no agent
// state, and sends the stale reminder. Answers the one line to add to the agent's next step, or null.
export async function afterToolCall($: EngineInterface): Promise<string | null> {
  const at = await nowOf($)
  const stored = await read($, summary)
  // What the committed run of the updater decided (update may run it again on a write race).
  const out = { line: null as string | null, openAuto: false }
  const f = await update($, fresh, raw => {
    let x: Fresh = { ...FRESH0, ...raw, calls: (raw?.calls ?? 0) + 1, turnCalls: (raw?.turnCalls ?? 0) + 1 }
    out.line = null
    out.openAuto = false
    if (x.windowFrom === 0) x.windowFrom = at
    if (x.outstanding >= 0) {
      x.outstanding += 1
      if (x.outstanding >= IGNORED_AFTER) x = ignore(x)
    }
    if (x.calls === AUTO_OPEN_CALLS && x.lastAgentAt === null && stored === null) {
      out.openAuto = true
      out.line = FIRST_REMINDER
      return { ...x, windowFrom: at, steps: 0, outstanding: 0 }
    }
    if (stored !== null || x.lastAgentAt !== null) {
      if (at - x.windowFrom >= REMIND_MS || x.steps >= STALE_STEPS) {
        // A reminder still open when the next one falls due was ignored.
        if (x.outstanding >= 0) x = ignore(x)
        out.line = REMINDER
        return { ...x, stale: true, windowFrom: at, steps: 0, outstanding: 0 }
      }
    }
    // Every 2 minutes with no agent update, a short check names the items still in progress.
    const last = Math.max(x.lastAgentAt ?? 0, x.checkAt ?? 0)
    const nowItems = (normalize(stored)?.items ?? []).filter(i => i.status === 'now').map(i => i.name)
    if (out.line === null && nowItems.length > 0 && last > 0 && at - last >= CHECK_MS) {
      out.line = checkLine(nowItems.slice(0, 6))
      return { ...x, checkAt: at }
    }
    return x
  })
  if (out.openAuto) {
    const steps = await read($, tasks)
    const built = autoSummary(steps, at)
    const done = { wrote: false }
    await update($, summary, s => {
      done.wrote = s === null
      return s === null ? built.summary : s
    })
    if (done.wrote) {
      await update($, tasks, () => built.steps)
      await settle($)
      await openPane($, { id: PANE, title: TITLE })
    }
  }
  await markOutOfDate($, f)
  // A headless session gets no pane and no reminders.
  if (await read($, headless)) return null
  // Where the marker keeps the steps current, the pane asks the agent for nothing more than its first state.
  if (out.line !== null && out.line !== FIRST_REMINDER && (await markerRuns($))) return null
  return out.line
}

// A task-list call started this many steps: they count toward the stale window.
export async function noteSteps($: EngineInterface, started: number): Promise<void> {
  if (started <= 0) return
  await update($, fresh, raw => ({ ...FRESH0, ...raw, steps: (raw?.steps ?? 0) + started }))
}

// A turn ends. While stale it holds the end once and asks the agent for an update; answers that request, or null.
export async function atTurnEnd($: EngineInterface, isHeldAlready: boolean): Promise<string | null> {
  const at = await nowOf($)
  const shown = (await read($, summary)) !== null
  const out = { hold: null as string | null }
  const f = await update($, fresh, raw => {
    let x: Fresh = { ...FRESH0, ...raw }
    out.hold = null
    // An end with a reminder still open: the agent ignored it.
    if (x.outstanding >= 0) x = ignore(x)
    const due = shown && (at - x.windowFrom >= REMIND_MS || x.steps >= STALE_STEPS)
    if ((x.stale || due) && !x.held && !isHeldAlready) {
      out.hold = HOLD_TEXT
      return { ...x, stale: true, held: true, outstanding: 0, windowFrom: at, steps: 0, turnCalls: 0, turnUpdated: false }
    }
    // A turn that ran tool calls and sent no update is held once, so the pane moves at every turn.
    if (shown && !isHeldAlready && (x.turnCalls ?? 0) > 0 && x.turnUpdated !== true) {
      out.hold = TURN_TEXT
      return { ...x, turnCalls: 0, turnUpdated: false }
    }
    return { ...x, turnCalls: 0, turnUpdated: false }
  })
  await markOutOfDate($, f)
  // Where the marker keeps the steps current, a turn's end is never held for an update.
  if (out.hold !== null && (await markerRuns($))) return null
  return out.hold
}

// The stale window counts time at work, not the person's time between turns: a turn end marks the time, and the
// next prompt moves the window on by the gap.
export async function noteTurnEnd($: EngineInterface): Promise<void> {
  const at = await nowOf($)
  await update($, fresh, raw => ({ ...FRESH0, ...raw, turnEndAt: at }))
}

export async function noteTurnStart($: EngineInterface): Promise<void> {
  const at = await nowOf($)
  await update($, fresh, raw => {
    const x = { ...FRESH0, ...raw }
    if (typeof x.turnEndAt !== 'number') return x
    return { ...x, windowFrom: x.windowFrom === 0 ? 0 : x.windowFrom + Math.max(0, at - x.turnEndAt), turnEndAt: null }
  })
}

// A valid agent update: the state is fresh again and the flags clear.
export async function agentUpdated($: EngineInterface): Promise<void> {
  const at = await nowOf($)
  await update($, fresh, raw => ({
    ...FRESH0,
    ...raw,
    lastAgentAt: at,
    windowFrom: at,
    steps: 0,
    stale: false,
    held: false,
    outstanding: -1,
    ignored: 0,
    turnUpdated: true,
  }))
}
