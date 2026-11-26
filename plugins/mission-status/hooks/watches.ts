import type { AgentWatch, Helper, Item, Job, Wakeup, WatchShape } from '../types'

// Watches: background work that waits for something, kept apart from the progress cards. Three shapes:
// until (ends at its first hit), stream (reports every hit) and trend (tracks a number). Hits reach the pane three
// ways: lines a job prints to its output (A), the agent's own report through the update tool (B), and task
// notifications that name a running job (C, how a Monitor reports).

// A watch that ends stays in the strip, marked complete or failed with its end time; the newest this many ended
// watches are kept, so a long session's strip stays short.
export const ENDED_KEEP = 8

// ---- A: the output-line protocol ----
// A job may print, one per line, with an optional "[time] " prefix:
//   WATCH: until|stream|trend [name]   its shape, and a name for the strip
//   HIT: <text>                         one hit; an until watch ends at its first
//   VALUE: <number> [text]              one reading of a trend
//   PROGRESS: <text>                    how far it is ("4 of 6 checks")
//   DONE: <text>                        the watch found what it waited for and ends
const LINE = /^\s*(?:\[[^\]]*\]\s*)?(WATCH|HIT|VALUE|PROGRESS|DONE):\s*(.*)$/

export const SHAPES: readonly WatchShape[] = ['until', 'stream', 'trend']

// One chunk of a job's output applied to it. Only whole lines count: a chunk that ends mid-line keeps that part for
// the next read, so the returned `used` is how many characters of `text` were read.
export function applyOutput(job: Job, text: string, at: number): { job: Job; used: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { job, used: 0 }
  let j: Job = { ...job, values: [...(job.values ?? [])] }
  for (const raw of text.slice(0, end).split('\n')) {
    const m = LINE.exec(raw)
    if (m === null) continue
    const kind = m[1]
    const rest = (m[2] ?? '').trim()
    if (kind === 'WATCH') {
      const [shape, ...name] = rest.split(/\s+/)
      if (SHAPES.includes(shape as WatchShape)) j.shape = shape as WatchShape
      if (name.length > 0) j.description = name.join(' ').slice(0, 120)
    } else if (kind === 'HIT') {
      j = hit(j, rest, at)
    } else if (kind === 'VALUE') {
      const n = Number.parseFloat(rest)
      if (Number.isFinite(n)) j.values = [...(j.values ?? []), n].slice(-24)
      if (j.shape == null) j.shape = 'trend'
      j.lastAt = at
    } else if (kind === 'PROGRESS') {
      j.progress = rest.slice(0, 120)
    } else if (kind === 'DONE') {
      j = { ...hit(j, rest, at), endedAt: at, outcome: 'hit' }
    }
  }
  return { job: j, used: end + 1 }
}

function hit(j: Job, text: string, at: number): Job {
  const next: Job = { ...j, hits: (j.hits ?? 0) + 1, last: text.slice(0, 160) || j.last || null, lastAt: at }
  if (next.shape == null) next.shape = 'stream'
  // An until watch ends at its first hit.
  if (next.shape === 'until' && next.endedAt == null) return { ...next, endedAt: at, outcome: 'hit' }
  return next
}

// The path a job writes its output to, from the result of the call that started it.
export const outputPathOf = (resultText: string): string | null =>
  /Output is being written to:\s*([^\s"\\]+)/.exec(resultText)?.[1]?.replace(/[.,;]+$/, '') ?? null

// ---- C: task notifications ----
// A notification names a job: a terminal status ends it (a shell that exits ends its watch: completed is a hit for an
// until watch, failed or killed is a failure); any other notification on a running job is one hit, its summary the
// hit's text.
export function applyNotifications(list: Job[], text: string, at: number): Job[] {
  const blocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []
  if (blocks.length === 0) return list
  let out = list
  for (const b of blocks) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(b)?.[1]?.trim()
    if (id === undefined) continue
    const status = /<status>([^<]+)<\/status>/.exec(b)?.[1]?.trim() ?? ''
    const summary = (/<summary>([\s\S]*?)<\/summary>/.exec(b)?.[1] ?? '').trim()
    out = out.map(j => {
      if (j.id !== id || j.endedAt != null) return j
      if (/^(completed|stopped)$/.test(status)) return { ...j, endedAt: at, outcome: j.outcome ?? 'done' }
      if (/^(failed|killed)$/.test(status)) return { ...j, endedAt: at, outcome: 'failed' }
      return hit(j, summary, at)
    })
  }
  return out
}

// Every running job, and the newest ENDED_KEEP ended ones.
export function keepEnded(list: Job[]): Job[] {
  const ended = list.filter(j => j.endedAt != null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, ENDED_KEEP)
  return list.filter(j => j.endedAt == null || ended.includes(j))
}

// ---- Detection: which agent items are watches ----
// An item that names waiting or watching, not work: "Watch CI", "Wait for the deploy", "Monitor error rate", "Poll
// the queue", "Keep checking". It leaves the progress cards and shows in the Watching section; an item that holds
// children stays a card item, as it is work with parts.
const WATCH_NAME = /^\s*(watch(ing)?|monitor(ing)?|wait(ing)?\s+(for|on|until)|poll(ing)?|keep\s+(checking|watching|an eye)|track(ing)?\s+(the\s+)?(trend|rate|count|queue|price|value|level))\b/i
export const isWatchItem = (x: Item, all: readonly Item[]): boolean =>
  WATCH_NAME.test(x.name) && !all.some(y => y !== x && y.phase === x.phase && y.parent != null && (y.parent === x.id || y.parent === x.name))

// ---- What the strip draws ----
export type WatchRow = {
  id: string
  name: string
  source: 'job' | 'helper' | 'agent' | 'item' | 'wakeup'
  shape: WatchShape | null
  kind: string | null
  since: number
  hits: number
  last: string | null
  lastAt: number | null
  values: number[]
  progress: string | null
  endedAt: number | null
  outcome: 'hit' | 'done' | 'failed' | null
  due: number | null
}

// Every watch in one list: the running ones first, in the order each started, then the ended ones, newest first.
// Sources: jobs (A, C), subagents, agent reports (B), detected items and
// scheduled wakeups. An agent report that names a job (its `job`) names and shapes that job's row instead of adding one.
export function watchRows(p: { jobs: Job[]; helpers: Helper[]; agent: AgentWatch[]; items: Item[]; wakeups: Wakeup[]; at: number }): WatchRow[] {
  const { at } = p
  const byJob = new Map(p.agent.filter(w => w.job != null).map(w => [w.job as string, w]))
  const rows: WatchRow[] = []
  for (const j of keepEnded(p.jobs)) {
    const said = byJob.get(j.id)
    rows.push({
      id: `job-${j.id}`,
      name: said?.name ?? j.description,
      source: 'job',
      shape: said?.shape ?? j.shape ?? null,
      kind: j.kind,
      since: j.at,
      hits: Math.max(j.hits ?? 0, said?.hits ?? 0),
      last: said?.last ?? j.last ?? null,
      lastAt: j.lastAt ?? null,
      values: j.values ?? [],
      progress: said?.progress ?? j.progress ?? null,
      endedAt: j.endedAt ?? null,
      outcome: j.outcome ?? null,
      due: null,
    })
  }
  for (const h of p.helpers.filter(x => x.status === 'running'))
    rows.push({ id: `helper-${h.id}`, name: h.description, source: 'helper', shape: null, kind: h.model, since: h.startTime, hits: 0, last: null, lastAt: null, values: [], progress: null, endedAt: null, outcome: null, due: null })
  for (const w of p.agent.filter(x => x.job == null)) {
    const endedAt = w.status === 'hit' || w.status === 'ended' ? (w.endedAt ?? at) : null
    rows.push({ id: `agent-${w.id}`, name: w.name, source: 'agent', shape: w.shape ?? null, kind: null, since: w.at ?? at, hits: w.hits ?? 0, last: w.last ?? null, lastAt: w.lastAt ?? null, values: w.value != null ? [...(w.values ?? []), w.value].slice(-24) : (w.values ?? []), progress: w.progress ?? null, endedAt, outcome: w.status === 'hit' ? 'hit' : w.status === 'ended' ? 'done' : null, due: null })
  }
  for (const x of p.items) {
    const endedAt = x.status === 'done' ? (x.doneAt ?? at) : null
    rows.push({ id: `item-${x.id ?? x.name}`, name: x.name, source: 'item', shape: /^\s*wait/i.test(x.name) ? 'until' : null, kind: null, since: x.since ?? x.seenAt ?? at, hits: 0, last: null, lastAt: null, values: [], progress: x.note ?? null, endedAt, outcome: endedAt !== null ? 'hit' : x.status === 'failed' ? 'failed' : null, due: null })
  }
  // A wakeup that came due is complete.
  for (const w of p.wakeups)
    rows.push({ id: `wake-${w.at}`, name: w.reason, source: 'wakeup', shape: 'until', kind: 'wakeup', since: w.at, hits: 0, last: null, lastAt: null, values: [], progress: null, endedAt: w.due > at ? null : w.due, outcome: w.due > at ? null : 'done', due: w.due })
  const running = rows.filter(r => r.endedAt === null).sort((a, b) => a.since - b.since)
  const ended = rows.filter(r => r.endedAt !== null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, ENDED_KEEP)
  return [...running, ...ended]
}

// Any watch still running: the pane's clock keeps ticking for it.
export const anyRunning = (rows: readonly WatchRow[]): boolean => rows.some(r => r.endedAt === null)

// A sparkline of the last readings, eight steps from low to high.
export function spark(values: readonly number[]): string {
  const v = values.slice(-16)
  if (v.length < 2) return ''
  const lo = Math.min(...v)
  const hi = Math.max(...v)
  const bars = '▁▂▃▄▅▆▇█'
  return v.map(n => bars[hi === lo ? 3 : Math.round(((n - lo) / (hi - lo)) * 7)]).join('')
}

// The change over the window, as "up 30" or "down 4.5"; empty under two readings.
export function trendWord(values: readonly number[]): string {
  const v = values.slice(-16)
  if (v.length < 2) return ''
  const d = (v[v.length - 1] ?? 0) - (v[0] ?? 0)
  const n = Math.abs(d) >= 10 || Number.isInteger(d) ? Math.round(Math.abs(d)).toString() : Math.abs(d).toFixed(1)
  return d === 0 ? 'flat' : `${d > 0 ? 'up' : 'down'} ${n}`
}
