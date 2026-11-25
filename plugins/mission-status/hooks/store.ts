import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Activity, Count, Fresh, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'
import { AUTO_OPEN_CALLS, CHECK_MS, checkLine, FIRST_REMINDER, TURN_TEXT, HOLD_TEXT, IGNORED_AFTER, IGNORED_LIMIT, REMINDER, STALE_MS, STALE_STEPS, autoSummary, normalize } from './model'

// The holdback (metrics.tsx decides it): a measurement session with no pane and no standing rule.
const holdback = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)

export const PANE = 'progress'
// The pane's one accent, the purple of the stage bar; the app's own accent is orange.
export const ACCENT = '#8B7CF6'
export const TITLE = 'Progress'
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

// The latest action of the session, as the chat shows it: the current card's live line.
export const activity = atom({ plugin: 'mission-status', key: 'activity' } as const, null as Activity)

export async function say($: EngineInterface, text: string): Promise<void> {
  await update($, activity, old => (old !== null && old.text === text ? old : { text, prev: old?.text ?? null, at: Date.now() }))
}


export async function tick($: EngineInterface): Promise<void> {
  try {
    await update($, now, () => Date.now())
  } catch {}
}

// The 1 s clock: it writes only while a timer shows, that is while a stage, an item, a task step or a helper is in
// progress in the stored state. Otherwise it returns at once.
export async function tickIfTimer($: EngineInterface): Promise<void> {
  try {
    const s = normalize(await read($, summary))
    let shows = s !== null && (s.phase < s.phases.length || s.active.length > 0 || s.items.some(i => i.status === 'now'))
    if (!shows) shows = (await read($, tasks)).some(t => t.status === 'now')
    if (!shows) shows = ((await read($, live))?.helpers ?? []).some(h => h.status === 'running')
    if (shows) await tick($)
  } catch {}
}


// ---- Freshness triggers (product plan, "How the state stays current") ----

export const FRESH0: Fresh = {
  calls: 0,
  lastAgentAt: null,
  agentVersion: 0,
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
    // normalize leaves the agent's version out, so it is carried over from the stored value.
    return { ...old, agentVersion: (s as { agentVersion?: number } | null)?.agentVersion, mayBeOutOfDate: true, version: (old.version ?? 0) + 1 } as Summary
  })
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
      if (at - x.windowFrom >= STALE_MS || x.steps >= STALE_STEPS) {
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
  // A holdback session gets no pane and no reminders.
  if (await read($, holdback)) return null
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
      await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    }
  }
  await markOutOfDate($, f)
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
    const due = shown && (at - x.windowFrom >= STALE_MS || x.steps >= STALE_STEPS)
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
export async function agentUpdated($: EngineInterface, version: number | undefined): Promise<void> {
  const at = await nowOf($)
  await update($, fresh, raw => ({
    ...FRESH0,
    ...raw,
    lastAgentAt: at,
    // Two updates in flight: the stored version never falls.
    agentVersion: Math.max(version ?? 0, raw?.agentVersion ?? 0),
    windowFrom: at,
    steps: 0,
    stale: false,
    held: false,
    outstanding: -1,
    ignored: 0,
    turnUpdated: true,
  }))
}

export async function agentVersionOf($: EngineInterface): Promise<number> {
  return (await read($, fresh)).agentVersion ?? 0
}
