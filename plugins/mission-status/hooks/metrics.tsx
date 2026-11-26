import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Fresh, Live, MetricsSession, Summary, Task, PrRecord } from '../types'
import { AUTO_PROJECT, STALE_STEPS } from './model'
import { FRESH0, PANE } from './store'

// Anonymous metrics, sent only after consent. What is sent, field by field, is in docs/telemetry.md; keep the two in step.
// Nothing here reads a session id, an account, a path or any text the person or the agent wrote:
// prompts are sorted on the device into yes or no, and only the word leaves.

// PostHog Cloud US. The key is PostHog's public, write-only project token, so anyone may read it; it can only add
// events.
export const ENDPOINT = 'https://us.i.posthog.com/i/v0/e/'
export const KEY = 'phc_BGLN5bXDwYbwdzkzci7L2tNbyWXtUfwokDRhP6TG5w2Q'
export const PRODUCT = 'mission-status'
export const SCHEMA_VERSION = 2

export const REAL_WORK_CALLS = 5 // a real-work session has 5 or more tool calls
export const FLUSH_MS = 60_000 // at most one request a minute
export const MAX_QUEUE = 200 // a full queue drops new events, never blocks

const UPDATE_TOOL = 'mcp__mission-status__update'

// The fixed, published word list that sorts a prompt as a progress question. Each entry matches whole words, on the
// prompt in lower case with punctuation removed. Only yes or no leaves the device.
export const PROGRESS_WORDS: readonly string[] = [
  'status',
  'progress',
  'eta',
  'where are we',
  'where are you',
  'where do we stand',
  'how far',
  'how far along',
  'how long',
  'how much longer',
  'how is it going',
  'hows it going',
  'how are we doing',
  'whats left',
  'what is left',
  'whats remaining',
  'what remains',
  'whats the state',
  'what stage',
  'which stage',
  'what are you doing',
  'what are you working on',
  'whats happening',
  'what is happening',
  'any update',
  'any updates',
  'give me an update',
  'update me',
  'are you done',
  'are we done',
  'is it done',
  'done yet',
  'finished yet',
  'still working',
  'still running',
  'still going',
]

// Every event and the only properties it may carry, each a word from a fixed list or a whole number. The common
// properties ride on every event. Anything else is dropped before it is queued.
const YES_NO = ['yes', 'no'] as const
export const RENDER_ERROR_CODES = ['type', 'range', 'reference', 'syntax', 'error', 'other'] as const
export const UPDATE_FAILED_CODES = ['install', 'reload', 'other'] as const
export const STALE_TRIGGERS = ['time', 'steps', 'no_state'] as const
// 'hash': 16 hex characters, a name scrambled on the device with that install's own secret (hashOf).
type Field = readonly string[] | 'count' | 'hash'
export const EVENTS: Readonly<Record<string, Readonly<Record<string, Field>>>> = {
  session_real_work: {},
  pane_shown: {},
  progress_ask: { progress: YES_NO },
  project_tracked: { project_id: 'hash' },
  pr_tracked: { pr_id: 'hash' },
  update_accuracy: { accurate: YES_NO },
  stale_reminder: { trigger: STALE_TRIGGERS },
  update_after_reminder: { followed: YES_NO, steps: 'count' },
  render: { count: 'count' },
  render_error: { code: RENDER_ERROR_CODES },
  update_ok: {},
  update_failed: { code: UPDATE_FAILED_CODES },
}
export const COMMON: Readonly<Record<string, unknown>> = {
  product: PRODUCT,
  schema_version: SCHEMA_VERSION,
  $process_person_profile: false,
  $geoip_disable: true,
}

export type Props = Record<string, string | number>
export type Queued = { event: string; timestamp: string; properties: Props }

// Keeps only the listed properties with listed values; an unknown event is dropped whole.
export function clean(event: string, props: Record<string, unknown>): Props | null {
  const spec = EVENTS[event]
  if (spec === undefined) return null
  const out: Props = {}
  for (const [name, field] of Object.entries(spec)) {
    const v = props[name]
    if (field === 'count') {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000) out[name] = v
    } else if (field === 'hash') {
      if (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)) out[name] = v
    } else if (typeof v === 'string' && field.includes(v)) out[name] = v
  }
  return out
}

// Sorts a prompt with the fixed word list.
export function isProgressAsk(text: string): boolean {
  const words = ` ${text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `
  return PROGRESS_WORDS.some(w => words.includes(` ${w} `))
}

// A name scrambled with the install's own secret: the same name gives the same 16 hex characters on one install,
// and nothing links it to the name or to another install's value.
export async function hashOf(secret: string, name: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${secret}\n${name}`))
  return [...new Uint8Array(d)].slice(0, 8).map(n => n.toString(16).padStart(2, '0')).join('')
}

// The project an agent named, or null while the pane shows its own placeholder.
export function projectOf(s: Summary): string | null {
  if (s === null || s.waitingForAgent === true) return null
  const p = s.project.trim()
  return p === '' || p === AUTO_PROJECT ? null : p
}

// A random UUID v4, made on the device.
export function uuid4(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const x = [...b].map(n => n.toString(16).padStart(2, '0')).join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

export function renderErrorCode(err: unknown): (typeof RENDER_ERROR_CODES)[number] {
  if (err instanceof TypeError) return 'type'
  if (err instanceof RangeError) return 'range'
  if (err instanceof ReferenceError) return 'reference'
  if (err instanceof SyntaxError) return 'syntax'
  if (err instanceof Error) return 'error'
  return 'other'
}

// The step an update failed in, from the phase update.tsx left before the failure: updating runs the CLI install,
// reloading loads the new code.
export function updateFailedCode(phase: unknown): (typeof UPDATE_FAILED_CODES)[number] {
  return phase === 'updating' ? 'install' : phase === 'reloading' ? 'reload' : 'other'
}

// The event an auto-update state change means (update.tsx): the phase reaching 'updated' is an update that worked; a
// higher failure count is one that failed, its code from the phase it failed in.
export function updateEvent(previous: unknown, value: unknown): { event: 'update_ok' | 'update_failed'; props: Record<string, unknown> } | null {
  const v = (value ?? null) as { phase?: unknown; failures?: unknown } | null
  const p = (previous ?? null) as { phase?: unknown; failures?: unknown } | null
  if (v === null || typeof v !== 'object') return null
  const failures = typeof v.failures === 'number' ? v.failures : 0
  const before = typeof p?.failures === 'number' ? p.failures : 0
  if (failures > before) return { event: 'update_failed', props: { code: updateFailedCode(p?.phase) } }
  if (v.phase === 'updated' && p?.phase !== 'updated') return { event: 'update_ok', props: {} }
  return null
}

// The values this file reads, declared by plugin and key. Consent, the task list, the pane's state and the pull
// requests are written elsewhere.
const consentAtom = atom({ plugin: 'mission-status', key: 'consent' } as const, null as 'yes' | 'no' | null)
// Written by onboarding once the metrics notice has been on screen; metrics are on by default, but nothing is sent
// before the notice has shown once.
const noticeAtom = atom({ plugin: 'mission-status', key: 'metricsNoticeShown' } as const, false as boolean)
const tasksAtom = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
const summaryAtom = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const prRefsAtom = atom({ plugin: 'mission-status', key: 'prRefs' } as const, [] as string[])
const liveAtom = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })
// A headless run: the other parts read it to stay quiet (marker, readers, register, store, quiet).
const headlessAtom = atom({ plugin: 'mission-status', key: 'headless' } as const, false as boolean)
const sessionAtom = atom({ plugin: 'mission-status', key: 'metricsSession' } as const, null as Stored | null)

// $.store keys: the install id, and the consent choice kept across sessions by /pane-metrics.
export const ID_KEY = 'metricsId'
export const CONSENT_KEY = 'metricsConsent'
export const NOTICE_KEY = 'metricsNoticeShown'
// The install's own secret for hashOf; never sent, deleted with the install id.
export const SECRET_KEY = 'metricsSecret'

// What one session counts. The counts that must outlive a reload (an auto-update mid-session) sit in $.state, in
// metricsSession; the queue and the render count start over with the module.
// paneSent: pane_shown is sent once per session, also across a reload.
type Stored = MetricsSession
let session: Stored = { calls: 0, realWork: false }
// The value last written to metricsSession: past real work, a tool call writes only when the session changed.
let stored: Stored | null = null
let paneSeen = false
let asks: boolean[] = []
let renders = 0
let queue: Queued[] = []
let lastSend = -Infinity
let disabled = false
// The flush timer; a new session.start cancels it before it registers again.
let flushTimer: { cancel: () => void } | null = null

function reset(): void {
  session = { calls: 0, realWork: false }
  stored = null
  paneSeen = false
  asks = []
  renders = 0
  queue = []
  lastSend = -Infinity
}

async function save($: EngineInterface): Promise<void> {
  const kept = session
  await update($, sessionAtom, () => kept)
  stored = kept
}

// A stored "no" beats the session's own value: /pane-metrics off in one session stops every open session. Without a
// stored "no", the session value comes first, then a stored "yes".
async function consentOf($: EngineInterface): Promise<'yes' | 'no' | null> {
  const kept = await $.store.get(CONSENT_KEY)
  if (kept === 'no') return 'no'
  const v = await read($, consentAtom)
  if (v === 'yes' || v === 'no') return v
  return kept === 'yes' ? kept : null
}

async function noticeShown($: EngineInterface): Promise<boolean> {
  if ((await read($, noticeAtom)) === true) return true
  return (await $.store.get(NOTICE_KEY)) === true
}

// Sends only when the consent is yes AND the notice has shown at least once.
async function on_($: EngineInterface): Promise<boolean> {
  return !disabled && (await consentOf($)) === 'yes' && (await noticeShown($))
}

// Queues an event after consent; drops it otherwise, or when the queue is full.
async function track($: EngineInterface, event: string, props: Record<string, unknown> = {}): Promise<void> {
  if (!(await on_($))) return
  const properties = clean(event, props)
  if (properties === null || queue.length >= MAX_QUEUE) return
  queue.push({ event, timestamp: new Date(await $.clock.now()).toISOString(), properties })
}

async function secretOf($: EngineInterface): Promise<string> {
  const kept = await $.store.get(SECRET_KEY)
  if (typeof kept === 'string' && kept.length >= 32) return kept
  const made = `${uuid4()}${uuid4()}`
  await $.store.set(SECRET_KEY, made)
  return made
}

async function installId($: EngineInterface): Promise<string> {
  const kept = await $.store.get(ID_KEY)
  if (typeof kept === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(kept)) return kept
  const id = uuid4()
  await $.store.set(ID_KEY, id)
  return id
}

// Sends the queue as one batch, at most once a minute. A failure drops the batch; nothing waits on it.
export async function flush($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await quiet(() => checkPrs($))
  if (renders > 0) await track($, 'render', { count: renders })
  renders = 0
  if (queue.length === 0 || now - lastSend < FLUSH_MS) return
  if (!(await on_($))) {
    queue = []
    return
  }
  const id = await installId($)
  const batch = queue.map(q => ({ event: q.event, distinct_id: id, timestamp: q.timestamp, properties: { ...COMMON, ...q.properties } }))
  queue = []
  lastSend = now
  await $.http
    .fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: KEY, batch }) })
    .catch(() => undefined)
}

const yn = (b: boolean): 'yes' | 'no' => (b ? 'yes' : 'no')

// A reload (an auto-update mid-session) keeps the session's counts: they sit in metricsSession.
async function startSession($: EngineInterface): Promise<void> {
  const kept = await read($, sessionAtom)
  session = kept !== null ? { calls: kept.calls, realWork: kept.realWork, paneSent: kept.paneSent, project: kept.project ?? null, prs: kept.prs ?? [] } : { calls: 0, realWork: false }
  stored = kept !== null ? session : null
  if (kept === null) await save($)
}

// The pane's project changed to a name not counted yet in this session: one project_tracked.
async function checkProject($: EngineInterface): Promise<void> {
  if (!(await on_($))) return
  const name = projectOf(await read($, summaryAtom))
  if (name === null) return
  const id = await hashOf(await secretOf($), `project\n${name}`)
  if (session.project === id) return
  session = { ...session, project: id }
  await save($)
  await track($, 'project_tracked', { project_id: id })
}

// Each pull request the pane reads for the first time in this session: one pr_tracked. Runs at each send.
async function checkPrs($: EngineInterface): Promise<void> {
  if (!(await on_($))) return
  // The session's own pull requests: its refs, read from the one record each.
  const records = (await read($, liveAtom))?.prRecords ?? {}
  const prs = ((await read($, prRefsAtom).catch(() => [] as string[])) ?? []).map(r => records[r]).filter((x): x is PrRecord => x !== undefined)
  const seen = new Set(session.prs ?? [])
  const fresh = prs.filter(p => typeof p.url === 'string' && p.url !== '' && !seen.has(p.number))
  if (fresh.length === 0) return
  session = { ...session, prs: [...seen, ...fresh.map(p => p.number)] }
  await save($)
  const secret = await secretOf($)
  for (const p of fresh) await track($, 'pr_tracked', { pr_id: await hashOf(secret, `pr\n${p.url}`) })
}

// The session reaches real work: it is counted, with the prompts sorted before it and the pane if it showed.
async function reachRealWork($: EngineInterface): Promise<void> {
  session = { ...session, realWork: true }
  await track($, 'session_real_work')
  for (const a of asks) await track($, 'progress_ask', { progress: yn(a) })
  asks = []
  if (paneSeen && session.paneSent !== true) {
    session = { ...session, paneSent: true }
    await track($, 'pane_shown')
  }
}

async function countCall($: EngineInterface): Promise<void> {
  if (session.realWork && session === stored) return
  if (!session.realWork) session = { ...session, calls: session.calls + 1 }
  if (!session.realWork && session.calls >= REAL_WORK_CALLS) await reachRealWork($)
  await save($)
}

// An agent update that the pane accepted: does the stored stage hold every open task step?
async function checkAccuracy($: EngineInterface): Promise<void> {
  const s = await read($, summaryAtom)
  if (s === null) return
  const stages = new Set([s.phase, ...(s.active ?? [])])
  const open = (await read($, tasksAtom)).filter(t => t.status === 'now')
  if (open.length > 0) await track($, 'update_accuracy', { accurate: yn(open.every(t => stages.has(t.phase))) })
}

// The stale reminders come from the pane's one freshness record (store.ts), read as it changes.
export function freshEvents(previous: unknown, value: unknown): { event: string; props: Record<string, unknown> }[] {
  const p = { ...FRESH0, ...((previous ?? {}) as Partial<Fresh>) }
  const v = { ...FRESH0, ...((value ?? {}) as Partial<Fresh>) }
  const out: { event: string; props: Record<string, unknown> }[] = []
  if (p.outstanding >= 0 && v.lastAgentAt !== p.lastAgentAt && v.outstanding < 0)
    out.push({ event: 'update_after_reminder', props: { followed: 'yes', steps: p.outstanding } })
  if (v.ignored > p.ignored) out.push({ event: 'update_after_reminder', props: { followed: 'no', steps: Math.max(p.outstanding, 0) + 1 } })
  if (v.outstanding === 0 && p.outstanding !== 0) {
    const trigger = v.lastAgentAt === null ? 'no_state' : p.steps >= STALE_STEPS ? 'steps' : 'time'
    out.push({ event: 'stale_reminder', props: { trigger } })
  }
  return out
}

const ANY = /(?:)/

const quiet = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work()
  } catch {
    // Metrics are a nicety: a failure never holds up the session.
  }
}

export function registerMetrics(on: On): void {
  // Each hook carries a match-all matcher: the pane's own hooks on these events have none, and two without one are refused.
  on('session.start', { cwd: ANY }, async ($, e, next) => {
    reset()
    // Each step stands alone: the command and the flush timer exist even when the start fails.
    await quiet(async () => {
      disabled = Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
    })
    await quiet(() => startSession($))
    // A headless run (claude -p, an SDK host, a helper job) has no person to see a pane: it runs as if the pane were not installed, with
    // no pane, rule, reminders or marker, and sends no metrics, so it never counts as a session that hid the pane.
    if ((e as { isInteractive?: boolean }).isInteractive === false) {
      disabled = true
      await quiet(() => update($, headlessAtom, () => true).then(() => undefined))
    } else await quiet(() => update($, headlessAtom, () => false).then(() => undefined))
    await quiet(() => $.command.register({ name: 'pane-metrics', description: 'Anonymous metrics for the progress pane: on or off' }).then(() => undefined))
    await quiet(async () => {
      flushTimer?.cancel()
      flushTimer = $.clock.every(FLUSH_MS, () => void quiet(() => flush($)))
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Counted after the call: an update the pane refused is not an update.
  on('tool.call', { tool: ANY }, async ($, e, next) => {
    const result = await next(e)
    await quiet(async () => {
      await countCall($)
      if (String((e as unknown as { tool?: unknown }).tool ?? '') === UPDATE_TOOL && result.deny === undefined) await checkAccuracy($)
    })
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('prompt.submit', { text: ANY }, async ($, e, next) => {
    await quiet(async () => {
      if (e.command !== undefined) return
      const ask = isProgressAsk(String(e.text ?? ''))
      if (session.realWork) await track($, 'progress_ask', { progress: yn(ask) })
      else if ((await on_($)) && asks.length < MAX_QUEUE) asks.push(ask)
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Outermost on the pane's drawing (registered before the pane's own hook): counts each drawing, and an error's kind.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    renders += 1
    if (!paneSeen) {
      paneSeen = true
      if (session.realWork && session.paneSent !== true) {
        session = { ...session, paneSent: true }
        // Drawing is pure and cannot write state: the flag is stored with the next tool call's save.
        void quiet(() => track($, 'pane_shown'))
      }
    }
    try {
      return await next(e)
    } catch (err) {
      void quiet(() => track($, 'render_error', { code: renderErrorCode(err) }))
      throw err
    }
  })

  // The auto-update part keeps its state in updateState: a new version is an update that worked, a higher failure
  // count is one that failed. The freshness record (fresh) gives the stale reminders, and the pane's state the
  // project. The pull requests are read at each send (flush): the poll's writes to live reach no state.set hook here.
  on('state.set', async ($, e, next) => {
    const w = e as unknown as { plugin?: string; key?: string; value?: unknown; previous?: unknown }
    const result = await next(e)
    if (w.plugin === 'mission-status' && w.key === 'updateState') {
      await quiet(async () => {
        const ev = updateEvent(w.previous, w.value)
        if (ev !== null) await track($, ev.event, ev.props)
      })
    }
    // A write another write beat changed nothing.
    const landed = (result as { isSet?: boolean } | undefined)?.isSet !== false
    if (landed && w.plugin === 'mission-status' && w.key === 'fresh') {
      await quiet(async () => {
        for (const ev of freshEvents(w.previous, w.value)) await track($, ev.event, ev.props)
      })
    }
    if (landed && w.plugin === 'mission-status' && w.key === 'summary') await quiet(() => checkProject($))
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('session.end', async ($, e, next) => {
    await quiet(() => flush($))
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('command.run', { command: 'pane-metrics' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      await $.store.set(CONSENT_KEY, 'yes')
      await update($, consentAtom, () => 'yes')
      // The person typed the choice, with the field list named in the reply: that counts as the notice shown.
      await $.store.set(NOTICE_KEY, true)
      await update($, noticeAtom, () => true)
      await installId($)
      return { text: disabled ? 'Metrics are on, but CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stops all sends.' : 'Metrics are on. The field list is in docs/telemetry.md.' }
    }
    if (arg === 'off') {
      // The session turns off first, so a failed write never leaves it sending.
      queue = []
      asks = []
      await update($, consentAtom, () => 'no').catch(() => undefined)
      const isKept = await $.store.set(CONSENT_KEY, 'no').then(
        () => true,
        () => false,
      )
      await $.store.delete(ID_KEY).catch(() => undefined)
      await $.store.delete(SECRET_KEY).catch(() => undefined)
      if (!isKept) return { text: 'Metrics are off in this session, but the choice could not be saved. Type /pane-metrics off again later.' }
      return { text: 'Metrics are off. The install id is deleted, and nothing more is sent.' }
    }
    if (!(await on_($))) return { text: 'Metrics are off. Type /pane-metrics on to turn them on.' }
    const id = await $.store.get(ID_KEY)
    return { text: `Metrics are on. Your install id is ${typeof id === 'string' ? id : 'made at the next send'}. Type /pane-metrics off to turn them off.` }
  })
}
