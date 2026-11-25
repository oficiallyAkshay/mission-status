import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { InferState, Item, ItemStatus, Summary, Task } from '../types'
import { UPDATE_TOOL, cap, idOf, normalize } from './model'

// The state marker (optional): Sarvam Prism, a decision model, reads the newest tool calls and marks which pane items
// are now done, in progress or failed, and places a new item with no parent under an existing one. Off unless
// SARVAM_API_KEY is set. The agent's own update always wins: it clears every mark, and an agent parent wins over a
// placed one. Only item names and short tool-call lines go to Sarvam: never file contents.

export const SARVAM_URL = 'https://api.sarvam.ai/v2/systemone'
export const SARVAM_MODEL = 'sarvam-prism'
// One check at most every 30 s, and only after new tool calls (or a new item to place).
export const INFER_MS = 30_000
// The caps on one request: the newest tool calls, each line's length, the items asked about, the transcript tail read.
export const MAX_LINES = 40
export const LINE_CHARS = 160
export const MAX_ITEMS = 12
export const MAX_PLACE = 4
export const TAIL_BYTES = 256 * 1024
// A mark or a place shows only when Prism is this sure (its probabilities are calibrated).
export const SURE = 0.9
// After this many refusals in a row (a bad key, no access), the marker stops for the session.
export const MAX_FAILS = 3

const infer = atom({ plugin: 'mission-status', key: 'infer' } as const, null as InferState | null)
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
const holdback = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)

export const EMPTY: InferState = { marks: {}, parents: {}, seen: [], calls: 0, tokens: 0, fails: 0, off: false }

// ---------------------------------------------------------------- pure parts

// One short line per tool call, from the transcript's JSON lines: the tool, what it worked on, and how it ended.
// A Bash result gives its last line only (a test count, an exit message); no other result text is kept.
export function toolLines(jsonl: string): string[] {
  return toolCalls(jsonl).lines
}

// The tool lines and the id of the newest tool call (so a check runs only after new calls).
export function toolCalls(jsonl: string): { lines: string[]; lastId: string } {
  const calls: { id: string; line: string; bash: boolean }[] = []
  const ends = new Map<string, string>()
  for (const raw of jsonl.split('\n')) {
    if (!raw.includes('"tool_use"') && !raw.includes('"tool_result"')) continue
    let row: unknown
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    const content = (row as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Record<string, unknown>[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        const line = callLine(String(b.name ?? ''), (b.input ?? {}) as Record<string, unknown>)
        if (line !== null) calls.push({ id: b.id, line, bash: b.name === 'Bash' })
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ends.set(b.tool_use_id, b.is_error === true ? 'error' : lastLine(b.content) === '' ? '' : `\u0000${lastLine(b.content)}`)
      }
    }
  }
  const lines = calls
    .map(c => {
      const end = ends.get(c.id)
      // Only a Bash result keeps its last line; any other result (a file read, a page) shows as ok or error.
      const tail = end === undefined ? null : end === 'error' ? 'error' : c.bash && end !== '' ? end.slice(1) : 'ok'
      return clip(tail === null ? c.line : `${c.line} -> ${tail}`)
    })
    .slice(-MAX_LINES)
  return { lines, lastId: calls.at(-1)?.id ?? '' }
}

function callLine(tool: string, input: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
  if (tool === UPDATE_TOOL || tool.startsWith('mcp__ccd_') || tool === 'ToolSearch') return null
  if (tool === 'Bash') return `Bash: ${s('description') || s('command')}`
  if (tool === 'Read' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return `${tool}: ${base(s('file_path') || s('notebook_path'))}`
  if (tool === 'Grep' || tool === 'Glob') return `${tool}: ${s('pattern')}`
  if (tool === 'Agent' || tool === 'Task') return `${tool}: ${s('description')}`
  if (tool === 'WebSearch') return `WebSearch: ${s('query')}`
  if (tool === 'WebFetch') return `WebFetch: ${s('url')}`
  if (tool === 'Skill') return `Skill: ${s('skill')}`
  return tool
}

function lastLine(content: unknown): string {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('\n') : ''
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return clip(lines.at(-1) ?? '', 100)
}

const clip = (t: string, n = LINE_CHARS) => (t.length > n ? `${t.slice(0, n - 1)}…` : t).replace(/\s+/g, ' ')

// The items the pane shows: the agent's items, then the task list's steps the agent does not name (as the view merges them).
export type Shown = { key: string; name: string; phase: number; status: ItemStatus; parent: string | null }
export function shownItems(s: Summary, steps: Task[]): Shown[] {
  const own = (s?.items ?? []).map(x => ({ key: x.id ?? idOf(x.name), name: x.name, phase: x.phase, status: x.status, parent: x.parent }))
  const fromTasks = steps
    .filter(t => !own.some(y => y.phase === t.phase))
    .filter(t => !own.some(y => y.name.toLowerCase() === t.name.toLowerCase()))
    .map(t => ({ key: `task:${idOf(cap(t.name))}`, name: cap(t.name), phase: t.phase, status: t.status as ItemStatus, parent: null }))
  return [...own, ...fromTasks]
}

const STATES: Record<'done' | 'now' | 'next' | 'failed', string> = {
  done: 'The recent tool calls show that this work is finished.',
  now: 'The recent tool calls show that this work is under way now.',
  next: 'No recent tool call works on this item yet.',
  failed: 'The recent tool calls show that this work failed and nothing fixed it after.',
}

// One request: the tool lines and the items once, as the state; one question per open item, one per new item to place.
export type Plan = { body: string; ask: Shown[]; place: { item: Shown; options: Shown[] }[] }
export function buildRequest(items: Shown[], lines: string[], place: Shown[]): Plan | null {
  const ask = items.filter(x => x.status !== 'done').slice(0, MAX_ITEMS)
  const placing = place
    .map(item => ({ item, options: items.filter(y => y.key !== item.key && y.phase === item.phase && y.parent === null && !isPlaced(y, place)) }))
    .filter(p => p.options.length > 0)
    .slice(0, MAX_PLACE)
  if (ask.length === 0 && placing.length === 0) return null
  const questions: Record<string, unknown> = {}
  ask.forEach((x, k) => {
    questions[`s${k}`] = { type: 'choice', instructions: `What is the state of the work item "${x.name}"?`, criteria: STATES }
  })
  placing.forEach((p, k) => {
    const criteria: Record<string, string> = { none: 'It is a separate piece of work, not a part of any item below.' }
    p.options.slice(0, 40).forEach((o, j) => (criteria[`o${j}`] = `It is a part of the item "${o.name}".`))
    questions[`p${k}`] = { type: 'choice', instructions: `Where does the new work item "${p.item.name}" belong?`, criteria }
  })
  const state = { recentToolCalls: lines, items: items.slice(0, 40).map(x => ({ name: x.name, stage: x.phase, status: x.status })) }
  return { body: JSON.stringify({ model: SARVAM_MODEL, state, questions }), ask, place: placing }
}
const isPlaced = (y: Shown, place: Shown[]) => place.some(p => p.key === y.key)

// Reads Prism's answer. A bad answer gives null: nothing changes. A mark or a place needs SURE probability.
export type Read = { marks: Record<string, ItemStatus>; parents: Record<string, string>; tokens: number }
export function readAnswer(text: string, plan: Plan): Read | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const answers = (json as { answers?: unknown })?.answers
  if (answers === null || typeof answers !== 'object') return null
  const top = (id: string, allowed: string[]): string | null => {
    const a = (answers as Record<string, unknown>)[id] as { choice?: unknown; probabilities?: Record<string, unknown> } | undefined
    if (a === undefined || typeof a.choice !== 'string' || !allowed.includes(a.choice)) return null
    const p = a.probabilities?.[a.choice]
    return typeof p === 'number' && p >= SURE && p <= 1 ? a.choice : null
  }
  const marks: Record<string, ItemStatus> = {}
  plan.ask.forEach((x, k) => {
    const c = top(`s${k}`, ['done', 'now', 'next', 'failed']) as ItemStatus | null
    if (c !== null && c !== x.status && c !== 'next') marks[x.key] = c
  })
  const parents: Record<string, string> = {}
  plan.place.forEach((p, k) => {
    const options = p.options.slice(0, 40)
    const c = top(`p${k}`, ['none', ...options.map((_, j) => `o${j}`)])
    const o = c === null || c === 'none' ? undefined : options[Number(c.slice(1))]
    if (o !== undefined) parents[p.item.key] = o.name
  })
  const usage = (json as { usage?: { input_tokens?: unknown } }).usage?.input_tokens
  return { marks, parents, tokens: typeof usage === 'number' && usage >= 0 ? usage : 0 }
}

// For the view: the items with each mark and place laid on. A mark shows only while the item keeps the status it had
// when Prism marked it; the agent's parent wins; a place that would make a loop is dropped.
export function withInferred(items: Item[], st: InferState | null): Item[] {
  if (st === null) return items
  // The view's own key: an agent item's id; a task-list step (no id) by its name, as shownItems keys it.
  const keyOf = (x: Item) => x.id ?? `task:${idOf(x.name)}`
  const out = items.map(x => {
    const k = keyOf(x)
    const m = st.marks[k]
    const placed = x.parent === null ? st.parents[k] : undefined
    const y = placed !== undefined && placed !== x.name ? { ...x, parent: placed } : x
    return m !== undefined && m.from === x.status && m.status !== x.status ? { ...y, status: m.status, inferred: true } : y
  })
  // A loop check: walk each placed parent upward; a walk that comes back drops that place.
  return out.map((x, i) => {
    if (x.parent === items[i]?.parent) return x
    let at: string | null = x.parent
    for (let n = 0; at !== null && n < 50; n++) {
      // A parent names its item by name or by id (as the view nests them).
      if (at === x.name || at === x.id) return { ...x, parent: items[i]?.parent ?? null }
      const up: Item | undefined = out.find(y => (y.name === at || y.id === at) && y.phase === x.phase)
      at = up?.parent ?? null
    }
    return x
  })
}

// ---------------------------------------------------------------- the loop

let started = false
let busy = false
let lastAsked = ''
let lastAt = 0

export async function inferTick($: EngineInterface, now: number): Promise<void> {
  if (busy || now - lastAt < INFER_MS - 1000) return
  const key = await $.env.get('SARVAM_API_KEY').catch(() => undefined)
  if (key === undefined || key === '' || (await read($, holdback))) return
  const st = (await read($, infer)) ?? EMPTY
  if (st.off) return
  const s = normalize(await read($, summary))
  if (s === null) return
  const items = shownItems(s, await read($, tasks))
  const seen = new Set(st.seen)
  const fresh = items.filter(x => !seen.has(x.key))
  // The first look at a pane records its items as seen; only items that appear later are placed.
  const place = st.seen.length === 0 ? [] : fresh.filter(x => x.parent === null)
  busy = true
  try {
    const { lines, lastId } = await recentCalls($)
    const plan = lastId === lastAsked && place.length === 0 ? null : buildRequest(items, lines, place)
    let got: Read | null = null
    let refused = false
    if (plan !== null && lines.length > 0) {
      lastAt = now
      lastAsked = lastId
      const r = await $.http.fetch(SARVAM_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
        body: plan.body,
      })
      if (r.ok) got = readAnswer(r.text, plan)
      else refused = r.status >= 400 && r.status < 500 && r.status !== 429
    }
    const sent = plan !== null && lines.length > 0
    if (!sent && fresh.length === 0) return
    await update($, infer, v => {
      const was = v ?? EMPTY
      const marks = { ...was.marks }
      if (got !== null) for (const [k, status] of Object.entries(got.marks)) marks[k] = { status, from: items.find(x => x.key === k)?.status ?? 'next', at: now }
      const fails = refused ? was.fails + 1 : got !== null ? 0 : was.fails
      return {
        ...was,
        marks,
        parents: { ...(got?.parents ?? {}), ...was.parents },
        // A new item is asked about once: seen once a request went out, or when it needs no request.
        seen: [...new Set([...was.seen, ...fresh.filter(x => sent || x.parent !== null || st.seen.length === 0).map(x => x.key)])].slice(-300),
        calls: was.calls + (sent ? 1 : 0),
        tokens: was.tokens + (got?.tokens ?? 0),
        fails,
        off: fails >= MAX_FAILS,
      }
    })
  } catch {
    // A failed call changes nothing; the next tick tries again.
  } finally {
    busy = false
  }
}

// The newest tool calls: the transcript's last 256 KiB, whole lines only.
async function recentCalls($: EngineInterface): Promise<{ lines: string[]; lastId: string }> {
  const path = (await $.session.info()).transcriptPath
  const size = (await $.fs.stat(path)).size
  const from = Math.max(0, size - TAIL_BYTES)
  const text = (await $.fs.read(path, { offset: from, length: size - from })) as string
  return toolCalls(from === 0 ? text : text.slice(text.indexOf('\n') + 1))
}

// Test seam: module variables start over with each load; tests reset them.
export function resetInfer(): void {
  busy = false
  lastAsked = ''
  lastAt = 0
}

async function afterAgentWrite($: EngineInterface, result: { deny?: unknown }): Promise<void> {
  if (!started) {
    started = true
    resetInfer()
    $.clock.every(INFER_MS, () => void $.clock.now().then(t => inferTick($, t)).catch(() => undefined))
  }
  if (result.deny === undefined) await update($, infer, v => (v === null || Object.keys(v.marks).length === 0 ? v : { ...v, marks: {} })).catch(() => undefined)
}

export function registerInfer(on: On): void {
  // The agent's own update, or a new task list, wins: every mark goes. The first such call starts the 30 s check (another
  // module owns session.start); a reload starts it again.
  on('tool.call', { tool: UPDATE_TOOL }, async ($, e, next) => {
    const result = await next(e)
    await afterAgentWrite($, result)
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const result = await next(e)
    await afterAgentWrite($, result)
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)
}

// For the view: the items with the stored marks and places laid on (one read).
export async function inferredItems($: EngineInterface, items: Item[]): Promise<Item[]> {
  return withInferred(items, await read($, infer).catch(() => null))
}
