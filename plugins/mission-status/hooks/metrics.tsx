import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Task } from '../types'
import { PANE } from './store'

// Anonymous metrics, sent only after consent. What is sent, field by field, is in docs/telemetry.md; a test holds this
// file to that list. Nothing here reads a session id, an account, a path or any text the person or the agent wrote:
// prompts are sorted on the device into yes or no, and only the word leaves.

// PostHog Cloud US, the Ensemble project. The key is PostHog's public, write-only project token (as Ensemble's
// docs/analytics.js), so anyone may read it; it can only add events.
export const ENDPOINT = 'https://us.i.posthog.com/i/v0/e/'
export const KEY = 'phc_BGLN5bXDwYbwdzkzci7L2tNbyWXtUfwokDRhP6TG5w2Q'
export const PRODUCT = 'mission-status'
export const SCHEMA_VERSION = 1

// The holdback runs for 30 days after the release date, on consenting installs only. Set the date at release.
export const RELEASE_AT = Date.UTC(2026, 11, 15)
export const HOLDBACK_DAYS = 30
export const HOLDBACK_RATE = 0.1

export const REAL_WORK_CALLS = 5 // a real-work session has 5 or more tool calls
export const FLUSH_MS = 60_000 // at most one request a minute
export const MAX_QUEUE = 200 // a full queue drops new events, never blocks
export const STALE_MS = 10 * 60_000 // stale: 10 minutes of tool calls with no agent update
export const STALE_STEPS = 3 // or 3 new task steps with no agent update
export const REMINDER_WINDOW = 3 // an update within 3 tool calls of a reminder follows it

const UPDATE_TOOL = 'mcp__mission-status__update'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'

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
export const UPDATE_FAILED_CODES = ['check', 'download', 'install', 'reload', 'other'] as const
export const STALE_TRIGGERS = ['time', 'steps', 'no_state'] as const
type Field = readonly string[] | 'count'
export const EVENTS: Readonly<Record<string, Readonly<Record<string, Field>>>> = {
  session_real_work: { holdback: YES_NO },
  pane_shown: { holdback: YES_NO },
  progress_ask: { progress: YES_NO, holdback: YES_NO },
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
    } else if (typeof v === 'string' && field.includes(v)) out[name] = v
  }
  return out
}

// Sorts a prompt with the fixed word list.
export function isProgressAsk(text: string): boolean {
  const words = ` ${text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `
  return PROGRESS_WORDS.some(w => words.includes(` ${w} `))
}

// A random 1 in 10 real-work sessions in the 30 days after release, on consenting installs only.
export function isHoldback(consent: unknown, now: number, rand: number): boolean {
  if (consent !== 'yes') return false
  if (now < RELEASE_AT || now >= RELEASE_AT + HOLDBACK_DAYS * 86_400_000) return false
  return rand < HOLDBACK_RATE
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

export function updateFailedCode(phase: unknown): (typeof UPDATE_FAILED_CODES)[number] {
  const p = typeof phase === 'string' ? phase.toLowerCase() : ''
  return UPDATE_FAILED_CODES.find(c => c !== 'other' && p.includes(c)) ?? 'other'
}

// The event an auto-update state change means: a higher failure count is a failed update (its phase gives the
// code), a new version after a known one is an update that worked.
export function updateEvent(previous: unknown, value: unknown): { event: 'update_ok' | 'update_failed'; props: Record<string, unknown> } | null {
  const v = (value ?? null) as { phase?: unknown; version?: unknown; failures?: unknown } | null
  const p = (previous ?? null) as { version?: unknown; failures?: unknown } | null
  if (v === null || typeof v !== 'object') return null
  const failures = typeof v.failures === 'number' ? v.failures : 0
  const before = typeof p?.failures === 'number' ? p.failures : 0
  if (failures > before) return { event: 'update_failed', props: { code: updateFailedCode(v.phase) } }
  if (p !== null && typeof p.version === 'string' && typeof v.version === 'string' && v.version !== p.version) return { event: 'update_ok', props: {} }
  return null
}

// The values this file reads, declared by plugin and key. Consent and the task list are written elsewhere; holdback
// is written here and read by the pane and the standing rule.
const consentAtom = atom({ plugin: 'mission-status', key: 'consent' } as const, null as 'yes' | 'no' | null)
const holdbackAtom = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)
const tasksAtom = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])

// $.store keys: the install id, and the consent choice kept across sessions by /pane-metrics.
export const ID_KEY = 'metricsId'
export const CONSENT_KEY = 'metricsConsent'

// What one session counts. Reset at each load; nothing here leaves the device but the words and counts above.
let calls = 0
let realWork = false
let holdback = false
let paneSeen = false
let paneSent = false
let asks: boolean[] = []
let renders = 0
let queue: Queued[] = []
let lastSend = -Infinity
let disabled = false
// Freshness: since the last agent update.
let lastUpdateAt: number | null = null
let staleStart: number | null = null
let newSteps = 0
let seenSteps = new Set<string>()
let reminded = false
let reminderOpen: number | null = null // tool calls since the open reminder

function reset(): void {
  calls = 0
  realWork = holdback = paneSeen = paneSent = reminded = false
  asks = []
  renders = 0
  queue = []
  lastSend = -Infinity
  lastUpdateAt = staleStart = reminderOpen = null
  newSteps = 0
  seenSteps = new Set()
}

async function consentOf($: EngineInterface): Promise<'yes' | 'no' | null> {
  const v = await read($, consentAtom)
  if (v === 'yes' || v === 'no') return v
  const kept = await $.store.get(CONSENT_KEY)
  return kept === 'yes' || kept === 'no' ? kept : null
}

async function on_($: EngineInterface): Promise<boolean> {
  return !disabled && (await consentOf($)) === 'yes'
}

// Queues an event after consent; drops it otherwise, or when the queue is full.
async function track($: EngineInterface, event: string, props: Record<string, unknown> = {}): Promise<void> {
  if (!(await on_($))) return
  const properties = clean(event, props)
  if (properties === null || queue.length >= MAX_QUEUE) return
  queue.push({ event, timestamp: new Date(await $.clock.now()).toISOString(), properties })
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

async function decideHoldback($: EngineInterface): Promise<void> {
  holdback = !disabled && isHoldback(await consentOf($), await $.clock.now(), Math.random())
  await update($, holdbackAtom, () => holdback)
  await track($, 'session_real_work', { holdback: holdback ? 'yes' : 'no' })
  for (const a of asks) await track($, 'progress_ask', { progress: a ? 'yes' : 'no', holdback: holdback ? 'yes' : 'no' })
  asks = []
  if (paneSeen && !paneSent) {
    paneSent = true
    await track($, 'pane_shown', { holdback: holdback ? 'yes' : 'no' })
  }
}

async function remind($: EngineInterface, trigger: (typeof STALE_TRIGGERS)[number]): Promise<void> {
  reminded = true
  reminderOpen = 0
  await track($, 'stale_reminder', { trigger })
}

async function onToolCall($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<void> {
  const now = await $.clock.now()
  calls += 1
  if (tool === UPDATE_TOOL) {
    if (reminderOpen !== null) await track($, 'update_after_reminder', { followed: reminderOpen <= REMINDER_WINDOW ? 'yes' : 'no', steps: reminderOpen })
    reminderOpen = null
    reminded = false
    lastUpdateAt = now
    staleStart = null
    newSteps = 0
    const phase = typeof args.phase === 'number' ? Math.round(args.phase) : null
    if (phase !== null) {
      const stages = new Set([phase, ...(Array.isArray(args.active) ? args.active : []).filter((k): k is number => typeof k === 'number').map(Math.round)])
      const open = (await read($, tasksAtom)).filter(t => t.status === 'now')
      if (open.length > 0) await track($, 'update_accuracy', { accurate: open.every(t => stages.has(t.phase)) ? 'yes' : 'no' })
    }
  } else {
    if (reminderOpen !== null) {
      reminderOpen += 1
      if (reminderOpen > REMINDER_WINDOW) {
        await track($, 'update_after_reminder', { followed: 'no', steps: reminderOpen })
        reminderOpen = null
      }
    }
    if (tool === PLAN_TOOL && Array.isArray(args.items)) {
      for (const it of args.items) {
        const name = typeof it === 'object' && it !== null ? (it as { content?: unknown }).content : undefined
        if (typeof name === 'string' && !seenSteps.has(name)) {
          seenSteps.add(name)
          if (lastUpdateAt !== null) newSteps += 1
        }
      }
    }
    if (lastUpdateAt !== null && staleStart === null) staleStart = now
    if (!reminded && lastUpdateAt !== null) {
      if (newSteps >= STALE_STEPS) await remind($, 'steps')
      else if (staleStart !== null && now - staleStart >= STALE_MS) await remind($, 'time')
    }
  }
  if (!realWork && calls >= REAL_WORK_CALLS) {
    realWork = true
    await decideHoldback($)
    // The 5th tool call with no agent state: the pane opens and sends the reminder at once.
    if (lastUpdateAt === null && !reminded) await remind($, 'no_state')
  }
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
    await quiet(async () => {
      disabled = Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
      await $.command.register({ name: 'pane-metrics', description: 'Anonymous metrics for the progress pane: on or off' })
      $.clock.every(FLUSH_MS, () => void quiet(() => flush($)))
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('tool.call', { tool: ANY }, async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    await quiet(() => onToolCall($, String(args.tool ?? ''), args))
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('prompt.submit', { text: ANY }, async ($, e, next) => {
    await quiet(async () => {
      if (e.command !== undefined) return
      const ask = isProgressAsk(String(e.text ?? ''))
      if (realWork) await track($, 'progress_ask', { progress: ask ? 'yes' : 'no', holdback: holdback ? 'yes' : 'no' })
      else if ((await on_($)) && asks.length < MAX_QUEUE) asks.push(ask)
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Outermost on the pane's drawing (registered before the pane's own hook): counts each drawing, and an error's kind.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    renders += 1
    if (!paneSeen) {
      paneSeen = true
      if (realWork && !paneSent) {
        paneSent = true
        void quiet(() => track($, 'pane_shown', { holdback: holdback ? 'yes' : 'no' }))
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
  // count is one that failed.
  on('state.set', async ($, e, next) => {
    const w = e as unknown as { plugin?: string; key?: string; value?: unknown; previous?: unknown }
    const result = await next(e)
    if (w.plugin === 'mission-status' && w.key === 'updateState') {
      await quiet(async () => {
        const ev = updateEvent(w.previous, w.value)
        if (ev !== null) await track($, ev.event, ev.props)
      })
    }
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
      await installId($)
      return { text: disabled ? 'Metrics are on, but CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stops all sends.' : 'Metrics are on. The field list is in docs/telemetry.md.' }
    }
    if (arg === 'off') {
      await $.store.set(CONSENT_KEY, 'no')
      await update($, consentAtom, () => 'no')
      await $.store.delete(ID_KEY)
      queue = []
      asks = []
      return { text: 'Metrics are off. The install id is deleted, and nothing more is sent.' }
    }
    if ((await consentOf($)) !== 'yes') return { text: 'Metrics are off. Type /pane-metrics on to turn them on.' }
    const id = await $.store.get(ID_KEY)
    return { text: `Metrics are on. Your install id is ${typeof id === 'string' ? id : 'made at the next send'}. Type /pane-metrics off to turn them off.` }
  })
}
