export type Count = { label: string; when?: string; n?: number; m?: number; text?: string; phase?: number; href?: string; hrefLabel?: string }
export type ItemStatus = 'done' | 'now' | 'next' | 'failed' | 'needs'
// id: the agent's stable id for its item (from the name when the agent sends none). The task-list steps are the
// pane's own items, kept apart in `tasks`: no agent write deletes them.
export type Item = { id?: string; phase: number; name: string; status: ItemStatus; after: string | null; parent: string | null; when: string | null; note?: string | null; n?: number; m?: number; text?: string; since?: number | null; pr?: string | null; doneAt?: number | null; steps?: string[] | null; step?: number | null; stepsParallel?: boolean; stepsSent?: StepEntry[] | null; stepSent?: number | null; promoted?: boolean; taskStep?: string | null; touchedAt?: number | null; parallel?: boolean | null }
// A sub-step as sent: a name, or { name, steps } for one that has its own sub-steps (it becomes its own nested item).
// stepsParallel: the sub-steps run at the same time. stepsSent/stepSent: an item's steps and step as sent, kept when an
// entry was promoted to a child item. promoted: the item was made from its parent's steps, not sent by the agent.
export type StepEntry = string | { name: string; steps?: StepEntry[]; status?: ItemStatus; note?: string }
export type StepStatus = 'done' | 'now' | 'next'
export type StageKey = 'plan' | 'build' | 'fix' | 'cause' | 'review' | 'ship'
export type HypothesisState = 'open' | 'testing' | 'ruled out' | 'confirmed'
export type Hypothesis = { text: string; state: HypothesisState }
export type CardLink = { phase: number | null; item: string | null; label: string; href: string }
export type Ticket = { ref: string; title: string | null; url: string | null }
export type RunbookStatus = 'done' | 'now' | 'next' | 'failed' | 'blocked'
export type RunbookStep = { name: string; status: RunbookStatus; note: string | null; waitsOn: string | null }
// A runbook the session follows: a numbered procedure, drawn on its own tab beside Progress.
export type Runbook = { id: string; title: string; href: string | null; steps: RunbookStep[] }
export type Summary = {
  project: string
  // The repository the work is in, when it is not the session's folder; the PR reads run there.
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
  // The newest version the agent sent, kept inside the state so the check and the write read the same value.
  agentVersion?: number
} | null
// The freshness triggers' own record (store.ts): tool calls, the stale window and the reminders.
export type Fresh = {
  calls: number
  lastAgentAt: number | null
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
// The marker's kept marks (marker.ts): a mark per item id, and the failed calls in a row.
export type Marks = { marks: Record<string, { status: 'done' | 'now' | 'failed' | 'needs'; at: number }>; fails: number }
// prs: the pull requests this session counted, by number, kept on the device; never sent.
export type MetricsSession = { calls: number; realWork: boolean; paneSent?: boolean; project?: string | null; prs?: number[] }
export type Task = { name: string; status: 'done' | 'now' | 'next'; phase: number; since?: number | null; doneAt?: number | null }
// Running time per node (machine.ts): ms counted, and the time it last became running, or null.
export type Runs = Record<string, { ms: number; from: number | null }>
export type Helper = { id: string; description: string; status: string; model: string | null; startTime: number }
// One pull request's record, keyed owner/name#number: the one read the item chip, the PRs tab and the Deploy count use.
export type PrRecord = { ref: string; number: number; title: string; url: string; state: 'open' | 'draft' | 'merged' | 'closed' | 'conflict'; ci: 'running' | 'passing' | 'failing' | 'none'; ciStart?: number | null; ciEnd?: number | null; branch: string | null; mergedAt: number | null; at: number; summary?: string; summaryBy?: 'model' | 'text'; summaryKey?: string; v?: number; commits?: { sha: string; title: string }[]; checks?: { name: string; state: 'running' | 'passing' | 'failing' | 'none' }[] }
// CI of a pull request an item names: its state and when its checks started and finished.
export type ItemCi = { state: 'running' | 'passing' | 'failing' | 'none'; start: number | null; end: number | null; mergedAt?: number | null; pr?: 'open' | 'draft' | 'merged' | 'closed' | 'conflict'; url?: string | null }
export type Live = { helpers: Helper[]; prsUnread: boolean; prsReadAt?: number | null; ci?: Record<string, ItemCi>; prRecords?: Record<string, PrRecord> }

declare module 'claude-code' {
  interface PluginState {
    'mission-status': { summary: Shaped<Summary>; live: Shaped<Live | null>; now: number; open: string[] | null; tasks: Task[]
      // Wave 1: consent and metrics (metrics.tsx, onboarding.tsx), auto-update (update.tsx)
      consent: 'yes' | 'no' | null; onboarded: boolean; updateState: { phase: string; version: string | null; failures: number; at: number } | null; headless: boolean; background: boolean; metricsNoticeShown: boolean; metricsSession: MetricsSession | null; autoUpdate: boolean | null; tab: string | null; prTab: Record<string, string>; prRefs: string[]; prBranches: string[]; turnOpen: boolean; waiting: boolean; runs: Runs; seenAt: number
      // Wave 1: freshness triggers (store.ts)
      fresh: Fresh; doc: { title: string; path: string } | null
      // The quiet chat's hidden and shown blocks (quiet.tsx), kept across a reload.
      quietKept: { hidden: string[]; shown: string[] }
      // The marker's kept marks (marker.ts); the state machine reads them.
      marks: Marks | null }

  }
}
