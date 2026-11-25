export type Count = { label: string; when?: string; n?: number; m?: number; text?: string; phase?: number; href?: string; hrefLabel?: string }
export type ItemStatus = 'done' | 'now' | 'next' | 'failed'
// id: the agent's stable id for its item (from the name when the agent sends none). The task-list steps are the
// pane's own items, kept apart in `tasks`: no agent write deletes them.
export type Item = { id?: string; phase: number; name: string; status: ItemStatus; after: string | null; parent: string | null; when: string | null; note?: string | null; n?: number; m?: number; text?: string; since?: number | null; pr?: string | null; doneAt?: number | null }
export type StepStatus = 'done' | 'now' | 'next'
export type StageKey = 'plan' | 'build' | 'fix' | 'cause' | 'review' | 'ship'
export type HypothesisState = 'open' | 'testing' | 'ruled out' | 'confirmed'
export type Hypothesis = { text: string; state: HypothesisState }
export type CardLink = { phase: number | null; item: string | null; label: string; href: string }
export type Ticket = { ref: string; title: string | null; url: string | null }
export type Git = { branch: string; ahead: number; behind?: number; files: number; added: number; removed: number; dirty: number } | null
export type RunbookStatus = 'done' | 'now' | 'next' | 'failed' | 'blocked'
export type RunbookStep = { name: string; status: RunbookStatus; note: string | null; waitsOn: string | null }
// A runbook the session follows: a numbered procedure, drawn on its own tab beside Progress.
export type Runbook = { id: string; title: string; href: string | null; steps: RunbookStep[] }
export type Summary = {
  project: string
  // The repository the work is in, when it is not the session's folder; the Merge card reads git there.
  repo?: string | null
  runbooks?: Runbook[]
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
  checkAt?: number
  // Tool calls in the current turn, and whether an agent update came in it.
  turnCalls?: number
  turnUpdated?: boolean
}
export type MetricsSession = { holdback: boolean; calls: number; realWork: boolean }
export type Task = { name: string; status: 'done' | 'now' | 'next'; phase: number; since?: number | null; doneAt?: number | null }
export type Activity = { text: string; prev: string | null; at: number } | null
export type Pr = { number: number; state: string; url: string; title: string; isDraft?: boolean; review?: string; merge?: string; ci?: 'passing' | 'failing' | 'running' | 'none' }
export type Helper = { id: string; description: string; status: string; model: string | null; startTime: number }
// CI of a pull request an item names: its state and when its checks started and finished.
// A pull request this session made, as the PRs tab shows it.
export type SessionPr = { ref: string; number: number; title: string; url: string; state: 'open' | 'draft' | 'merged' | 'closed' | 'conflict'; ci: 'running' | 'passing' | 'failing' | 'none'; ciStart?: number | null; ciEnd?: number | null; branch: string | null; mergedAt: number | null; at: number }
export type ItemCi = { state: 'running' | 'passing' | 'failing' | 'none'; start: number | null; end: number | null; mergedAt?: number | null }
export type Live = { helpers: Helper[]; prs: Pr[]; prsUnread: boolean; at: number; reads: number; git: Git; ci?: Record<string, ItemCi>; sessionPrs?: SessionPr[] }

declare module 'claude-code' {
  interface PluginState {
    'mission-status': { summary: Shaped<Summary>; live: Shaped<Live | null>; now: number; open: string[] | null; activity: Activity; tasks: Task[]
      // Wave 1: consent and metrics (metrics.tsx, onboarding.tsx), auto-update (update.tsx)
      consent: 'yes' | 'no' | null; onboarded: boolean; updateState: { phase: string; version: string | null; failures: number; at: number } | null; holdback: boolean; metricsNoticeShown: boolean; metricsSession: MetricsSession | null; autoUpdate: boolean | null; barStart: number | null; tab: string | null; prRefs: string[]
      // Wave 1: freshness triggers (store.ts)
      fresh: Fresh; doc: { title: string; path: string } | null }
  }
}
