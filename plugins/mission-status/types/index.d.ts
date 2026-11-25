export type Count = { label: string; when?: string; n?: number; m?: number; text?: string; phase?: number; href?: string; hrefLabel?: string }
export type ItemStatus = 'done' | 'now' | 'next' | 'failed'
// id: the agent's stable id for its item (from the name when the agent sends none). The task-list steps are the
// pane's own items, kept apart in `tasks`: no agent write deletes them.
export type Item = { id?: string; phase: number; name: string; status: ItemStatus; after: string | null; parent: string | null; when: string | null; note?: string | null; n?: number; m?: number; text?: string; since?: number | null }
export type StepStatus = 'done' | 'now' | 'next'
export type StageKey = 'plan' | 'build' | 'fix' | 'cause' | 'review' | 'ship'
export type HypothesisState = 'open' | 'testing' | 'ruled out' | 'confirmed'
export type Hypothesis = { text: string; state: HypothesisState }
export type CardLink = { phase: number | null; item: string | null; label: string; href: string }
export type Ticket = { ref: string; title: string | null; url: string | null }
export type Git = { branch: string; ahead: number; behind?: number; files: number; added: number; removed: number; dirty: number } | null
export type Summary = {
  project: string
  ticket: Ticket | null
  links: CardLink[]
  goalLine: string | null
  stage: StageKey
  phases: string[]
  phase: number
  symptom: string | null
  hypotheses: Hypothesis[]
  waitingOn: string | null
  waitingSince: number
  counts: Count[]
  items: Item[]
  active: number[]
  template: string | null
  starts: (number | null)[]
  ends: (number | null)[]
  change: { label: string; from: string; at: number } | null
  at: number
  // The write counter: every write adds one; an older write never replaces a newer one.
  version?: number
  // Set by the pane: the pane opened by itself and waits for the agent's first state.
  waitingForAgent?: boolean
  // Set by the pane after 2 ignored reminders; the view shows "May be out of date".
  mayBeOutOfDate?: boolean
} | null
// The freshness triggers' own record (store.ts): tool calls, the stale window and the reminders.
export type Fresh = {
  calls: number
  lastAgentAt: number | null
  agentVersion: number
  windowFrom: number
  steps: number
  stale: boolean
  held: boolean
  outstanding: number
  ignored: number
  turnEndAt?: number | null
}
export type MetricsSession = { holdback: boolean; calls: number; realWork: boolean }
export type Task = { name: string; status: 'done' | 'now' | 'next'; phase: number; since?: number | null }
export type Activity = { text: string; prev: string | null; at: number } | null
export type Pr = { number: number; state: string; url: string; title: string; isDraft?: boolean; review?: string; merge?: string; ci?: 'passing' | 'failing' | 'running' | 'none' }
export type Helper = { id: string; description: string; status: string; model: string | null; startTime: number }
export type Live = { helpers: Helper[]; prs: Pr[]; prsUnread: boolean; at: number; reads: number; git: Git }

declare module 'claude-code' {
  interface PluginState {
    'mission-status': { summary: Shaped<Summary>; live: Shaped<Live | null>; now: number; open: string[] | null; activity: Activity; tasks: Task[]
      // Wave 1: consent and metrics (metrics.tsx, onboarding.tsx), auto-update (update.tsx)
      consent: 'yes' | 'no' | null; onboarded: boolean; updateState: { phase: string; version: string | null; failures: number; at: number } | null; holdback: boolean; metricsNoticeShown: boolean; metricsSession: MetricsSession | null; autoUpdate: boolean | null
      // Wave 1: freshness triggers (store.ts)
      fresh: Fresh; doc: { title: string; path: string } | null }
  }
}
