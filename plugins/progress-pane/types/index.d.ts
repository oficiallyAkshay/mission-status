export type Count = { label: string; when?: string; n?: number; m?: number; text?: string; phase?: number; href?: string; hrefLabel?: string }
export type ItemStatus = 'done' | 'now' | 'next' | 'failed'
export type Item = { phase: number; name: string; status: ItemStatus; after: string | null; parent: string | null; when: string | null; n?: number; m?: number; text?: string }
export type StageKey = 'plan' | 'build' | 'fix' | 'cause' | 'review' | 'ship'
export type HypothesisState = 'open' | 'testing' | 'ruled out' | 'confirmed'
export type Hypothesis = { text: string; state: HypothesisState }
export type Ticket = { ref: string; title: string | null; url: string | null }
export type Git = { branch: string; ahead: number; behind?: number; files: number; added: number; removed: number; dirty: number } | null
export type Summary = {
  project: string
  ticket: Ticket | null
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
} | null
export type Task = { name: string; status: 'done' | 'now' | 'next'; phase: number }
export type Activity = { text: string; prev: string | null; at: number } | null
export type Pr = { number: number; state: string; url: string; title: string; isDraft?: boolean; review?: string; merge?: string; ci?: 'passing' | 'failing' | 'running' | 'none' }
export type Helper = { id: string; description: string; status: string; model: string | null; startTime: number }
export type Live = { helpers: Helper[]; prs: Pr[]; prsUnread: boolean; at: number; reads: number; git: Git }

declare module 'claude-code' {
  interface PluginState {
    'progress-pane': { summary: Shaped<Summary>; live: Shaped<Live | null>; now: number; open: string[] | null; activity: Activity; tasks: Task[] }
  }
}
