import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'

export const PANE = 'progress'
// The pane's one accent, the purple of the stage bar; the app's own accent is orange.
export const ACCENT = '#8B7CF6'
export const TITLE = 'Progress'
export const TICK_MS = 5_000 // the pane reads helpers every 5 s
export const CLOCK_MS = 1_000 // and redraws its timers every second
export const PR_EVERY = 6 // and pull requests every sixth tick, every 30 s


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
