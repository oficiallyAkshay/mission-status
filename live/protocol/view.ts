// How the service talks to the page: A2UI v1.0 messages, one surface per tab, and the data model each surface binds
// to. WS1 writes this data; WS4 and WS5 compose tabs from it; WS3 components bind to it. Version 1.

import type { Status, Template } from './catalog'

export const CATALOG_ID = 'mission-status/v1'
export const A2UI_VERSION = '1.0'

export type TabId = 'current' | 'timeline' | 'prs' | 'watches' | 'runbook'
export const TABS: readonly TabId[] = ['current', 'timeline', 'prs', 'watches', 'runbook']
// Surface id for a tab: `<session>:<tab>`.

// Timeline verbs (owner's sketch, 2026-11-26). An entry takes exactly one.
export const VERBS = [
  'Brief', 'Correction', 'Ruling', 'Research', 'Investigate', 'Reproduce', 'Measure', 'Plan', 'Review',
  'Build', 'Fix', 'File', 'Merge', 'Monitor', 'Learn', 'Detour', 'Result', 'Wrap up',
] as const
export type Verb = (typeof VERBS)[number]

// Outcome shapes for Current (owner's sketch). Each open outcome is drawn as one of these organisms, or as a saved
// Template composed from catalog parts.
export const OUTCOME_SHAPES = [
  'Checklist', 'CellGrid', 'LiveTable', 'Chart', 'Hypotheses', 'ReviewWaves', 'DecisionRows', 'SeriesStepper',
] as const
export type OutcomeShape = (typeof OUTCOME_SHAPES)[number]

// ── Data model, one root object per session. JSON Pointer paths below. ──

export interface SessionModel {
  app: string
  title: string | null
  goalLine: string | null
  startedAt: number
  turnOpen: boolean
  // Who or what the session waits on, when it waits; null while it works.
  waitingOn: string | null
  // Times are epoch ms; the page computes elapsed time itself, so nothing is sent each second.
  lastEventAt: number
}

// A row inside an outcome (a checklist item, a series step, a table row, a hypothesis, a decision...).
export interface OutcomeRow {
  id: string
  label: string
  status: Status
  // Start time while running, so a Timer can tick in the page.
  since: number | null
  note: string | null
  // "n of m" counts.
  n?: number
  m?: number
  // Free cells for LiveTable and CellGrid, keyed by column id.
  cells?: Record<string, string | number | null>
  children?: OutcomeRow[]
}

export interface Outcome {
  id: string
  // Named as a state of the person's world: "14 memory files hold the new rule".
  title: string
  status: Status
  shape: OutcomeShape | { template: string }
  // Columns for LiveTable or CellGrid, in order.
  columns?: { id: string; label: string }[]
  rows: OutcomeRow[]
  // Where the numbers come from ("CI history, read on every merge").
  source: string | null
  // "Gate": what must be true for the outcome to close.
  gate: string | null
  openedAt: number
  updatedAt: number
}

export interface ClosedOutcome { id: string; title: string; closedAt: number }

export interface TimelineEntry {
  id: string
  verb: Verb
  title: string
  at: number
  // Count line under the title: "9 reads", "4 helpers".
  tally: string | null
  // Lines shown when the entry is opened; may nest.
  items: { text: string; items?: TimelineEntry['items'] }[]
  // Entries are never rewritten; a later entry may refer to an earlier one.
  refs?: string[]
}

export interface PrRow {
  ref: string // "owner/repo#n"
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  summary: string | null
  checks: { done: number; all: number; failed: number; runningSince: number | null }
  added: number
  deleted: number
  files: number
  review: string | null
  head: string
  base: string
  updatedAt: number
}

export interface WatchRow {
  id: string
  name: string
  shape: 'until' | 'stream' | 'trend'
  status: 'running' | 'hit' | 'ended'
  since: number
  last: string | null
  value?: number
  series?: number[]
  endedAt: number | null
}

export interface RunbookRow {
  id: string
  title: string
  href: string | null
  steps: { name: string; status: Status; note: string | null; waitsOn: string | null }[]
}

export interface ViewModel {
  session: SessionModel
  outcomes: Record<string, Outcome>
  closed: ClosedOutcome[]
  timeline: TimelineEntry[]
  prs: Record<string, PrRow>
  watches: Record<string, WatchRow>
  runbooks: Record<string, RunbookRow>
  templates: Record<string, Template>
}

export const PATHS = {
  session: '/session',
  outcomes: '/outcomes',
  closed: '/closed',
  timeline: '/timeline',
  prs: '/prs',
  watches: '/watches',
  runbooks: '/runbooks',
  templates: '/templates',
} as const
