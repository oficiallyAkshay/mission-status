import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, SessionMessage } from 'claude-code'
import type { ItemStatus, Marks, Summary, Task } from '../types'
import { UPDATE_TOOL, cap, idOf, normalize } from './model'

// The marker: between agent updates, Haiku (through the session's own client) reads the newest main-loop tool calls
// and marks which open items are now done, in progress or failed, and places a parentless item under another. A mark
// or a place is kept only when two checks in a row agree; the agent's own update clears the marks for the items it
// sends. Only item names and one short line per tool call go to the model: never file contents.

// Event timing, not a clock: a check 5 s after the last main-loop tool call (a new call restarts the wait), one at every
// main-loop turn end, and a confirming check 5 s after a first answer that names a new mark. No tool calls, no check.
export const QUIET_MS = 5_000
export const CONFIRM_MS = 5_000
export const MODEL = 'haiku'
export const TIMEOUT_MS = 60_000
export const MAX_TOKENS = 600
// After this many failed or unreadable answers in a row, the marker stops until the next session start.
export const MAX_FAILS = 3
// How many of the newest transcript rows a check reads, and how many tool lines the prompt holds.
const ROWS = 60
const LINES = 30

const marksAtom = atom({ plugin: 'mission-status', key: 'marks' } as const, null as Marks | null)
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
const holdback = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)

export const EMPTY: Marks = { marks: {}, places: [], fails: 0 }

// ---------------------------------------------------------------- pure parts

// One short line per tool call: the tool, what it worked on, and how it ended. A Bash result gives its last line
// only (a test count, an exit message); any other result shows as ok or error, so no file text is ever kept.
export function toolCalls(rows: readonly SessionMessage[]): { lines: string[]; lastId: string } {
  const lines: string[] = []
  let lastId = ''
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    for (const use of row.toolUses ?? []) {
      const line = callLine(use.tool, use.input ?? {})
      if (line === null) continue
      lastId = use.tool_use_id
      const tail = use.text === undefined ? null : use.isError === true ? 'error' : use.tool === 'Bash' && lastLine(use.text) !== '' ? lastLine(use.text) : 'ok'
      lines.push(flat(tail === null ? line : `${line} -> ${tail}`))
    }
  }
  return { lines: lines.slice(-LINES), lastId }
}

export function callLine(tool: string, input: Record<string, unknown>): string | null {
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

const lastLine = (text: string): string => flat(text.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '')
const flat = (t: string) => t.replace(/\s+/g, ' ').slice(0, 200)

// The items the pane shows: the agent's items, then the task-list steps the agent does not name (as the view merges them).
export type Open = { id: string; name: string; status: ItemStatus; parent: string | null }
export function openItems(s: Summary, steps: Task[]): { all: Open[]; open: Open[] } {
  const own = (s?.items ?? []).map(x => ({ id: x.id ?? idOf(x.name), name: x.name, phase: x.phase, status: x.status, parent: x.parent }))
  const fromTasks = steps
    .filter(t => !own.some(y => y.phase === t.phase))
    .filter(t => !own.some(y => y.name.toLowerCase() === t.name.toLowerCase()))
    .map(t => ({ id: `task:${idOf(cap(t.name))}`, name: cap(t.name), phase: t.phase, status: t.status as ItemStatus, parent: null }))
  const all = [...own, ...fromTasks].map(({ id, name, status, parent }) => ({ id, name, status, parent }))
  return { all, open: all.filter(x => x.status !== 'done') }
}

export const SYSTEM =
  'You keep a progress list current from what a coding session does. You get the open items and the newest tool ' +
  'calls, one line each, oldest first. Mark an item only when the tool calls clearly show it: done when its work is ' +
  'finished, now when its work is under way, failed when its work failed and nothing fixed it after. Place an item ' +
  'that has no parent under another item only when it is clearly a part of that item. When unsure, leave it out. ' +
  'Answer with JSON only, no other text: {"marks":[{"id":"...","status":"done|now|failed"}],"places":[{"name":"...","parent_id":"..."}]}'

export function buildPrompt(open: Open[], lines: string[]): string {
  return JSON.stringify({ openItems: open, recentToolCalls: lines })
}

// Reads the model's answer. A bad or cut reply gives null (no answer); marks and places that name no open item are dropped.
export type Answer = { marks: Record<string, Exclude<ItemStatus, 'next'>>; places: { name: string; parent: string }[] }
export function readAnswer(text: string, open: Open[], all: Open[]): Answer | null {
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  let json: unknown
  try {
    json = JSON.parse(text.slice(from, to + 1))
  } catch {
    return null
  }
  if (json === null || typeof json !== 'object') return null
  const { marks: rawMarks, places: rawPlaces } = json as { marks?: unknown; places?: unknown }
  if ((rawMarks !== undefined && !Array.isArray(rawMarks)) || (rawPlaces !== undefined && !Array.isArray(rawPlaces))) return null
  const marks: Answer['marks'] = {}
  for (const m of (rawMarks ?? []) as { id?: unknown; status?: unknown }[]) {
    const x = open.find(y => y.id === m?.id)
    const st = m?.status
    if (x !== undefined && (st === 'done' || st === 'now' || st === 'failed') && st !== x.status) marks[x.id] = st
  }
  const places: Answer['places'] = []
  for (const p of (rawPlaces ?? []) as { name?: unknown; parent_id?: unknown }[]) {
    const x = open.find(y => y.name === p?.name && y.parent === null)
    const parent = all.find(y => y.id === p?.parent_id)
    if (x !== undefined && parent !== undefined && parent.id !== x.id && !places.some(q => q.name === x.name)) places.push({ name: x.name, parent: parent.id })
  }
  return { marks, places }
}

// What two answers in a row agree on.
export function agreed(a: Answer, b: Answer | null): Answer {
  if (b === null) return { marks: {}, places: [] }
  const marks: Answer['marks'] = {}
  for (const [id, st] of Object.entries(a.marks)) if (b.marks[id] === st) marks[id] = st
  return { marks, places: a.places.filter(p => b.places.some(q => q.name === p.name && q.parent === p.parent)) }
}

// ---------------------------------------------------------------- the loop

let clock: { cancel: () => void } | null = null
let live = false
// A first answer that named a mark the last one did not: the next check may ask again on the same tool lines.
let pending = false
let busy = false
let stopped = false
let cleared = false
let lastId = ''
let previous: Answer | null = null

function reset(): void {
  pending = false
  busy = false
  stopped = false
  lastId = ''
  previous = null
}

const off = async ($: EngineInterface): Promise<boolean> =>
  Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC').catch(() => undefined)) || (await read($, holdback).catch(() => false))

// Schedule one check after a wait; a later schedule replaces an earlier one (the debounce).
export function schedule($: EngineInterface, ms: number): void {
  if (!live || stopped) return
  clock?.cancel()
  clock = $.clock.after(ms, () => void markTick($))
}

// One check: only after new main-loop tool calls (or to confirm a first answer), one at a time.
export async function markTick($: EngineInterface): Promise<void> {
  if (busy || stopped) return
  busy = true
  try {
    if (await off($)) return
    const s = normalize(await read($, summary))
    if (s === null) return
    const rows = await $.session.messages({ last: ROWS })
    if (!Array.isArray(rows)) return
    const calls = toolCalls(rows)
    if (calls.lastId === '' || (calls.lastId === lastId && !pending)) return
    const { all, open } = openItems(s, await read($, tasks))
    if (open.length === 0) return
    lastId = calls.lastId
    const r = await $.model.complete({ model: MODEL, prompt: buildPrompt(open, calls.lines), system: SYSTEM, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: TIMEOUT_MS }).catch(() => null)
    const got = r !== null && r.isAnswered ? readAnswer(r.text, open, all) : null
    const now = await $.clock.now()
    const both = got === null ? null : agreed(got, previous)
    // A first answer with a mark not yet agreed: confirm it on the same lines in 5 s, not at the next event.
    const fresh = got !== null && Object.entries(got.marks).some(([id, st]) => both?.marks[id] !== st)
    pending = fresh && !pending
    if (got !== null) previous = got
    const st = await update($, marksAtom, v => {
      const was = v ?? EMPTY
      if (both === null) return { ...was, fails: was.fails + 1 }
      const marks: Marks['marks'] = {}
      // A kept mark stays while its item is open and still shows another status.
      for (const [id, m] of Object.entries(was.marks)) if (open.some(x => x.id === id && x.status !== m.status)) marks[id] = m
      for (const [id, status] of Object.entries(both.marks)) marks[id] = { status, at: now }
      const places = [...was.places.filter(p => !both.places.some(q => q.name === p.name)), ...both.places]
      return { marks, places, fails: 0 }
    })
    if ((st?.fails ?? 0) >= MAX_FAILS) stopped = true
    if (pending) schedule($, CONFIRM_MS)
    await record($, {
      at: now,
      answered: got !== null,
      reason: r === null ? 'refused' : r.isAnswered ? (got === null ? 'bad-reply' : null) : r.reason,
      marks: got?.marks ?? null,
      places: got?.places ?? null,
      agreed: both !== null && (Object.keys(both.marks).length > 0 || both.places.length > 0),
      kept: both ?? null,
      usage: r?.usage ?? null,
    })
  } catch {
    // A check that fails changes nothing; the next tick tries again.
  } finally {
    busy = false
  }
}

// One JSON line per model call in ~/.claude/mission-status/marker/<session id>.jsonl; never a tool line.
async function record($: EngineInterface, line: Record<string, unknown>): Promise<void> {
  try {
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    if (home === '') return
    const path = `${home}/.claude/mission-status/marker/${await $.session.id()}.jsonl`
    const was = (await $.fs.exists(path).catch(() => false)) ? await $.fs.read(path).catch(() => '') : ''
    await $.fs.write(path, `${typeof was === 'string' ? was : ''}${JSON.stringify(line)}\n`)
  } catch {
    // A record that cannot be written leaves the marks as they are.
  }
}

async function start($: EngineInterface): Promise<void> {
  clock?.cancel()
  clock = null
  reset()
  live = true
  await update($, marksAtom, () => EMPTY).catch(() => undefined)
}

// The item ids an agent update sends: its items and its patch operations.
export function sentIds(args: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const list of [args.items, args.patch])
    if (Array.isArray(list))
      for (const x of list as { id?: unknown; name?: unknown }[]) {
        if (typeof x?.id === 'string') ids.push(x.id)
        else if (typeof x?.name === 'string') ids.push(idOf(x.name))
      }
  return ids
}

export function registerMarker(on: On): void {
  // The matchers keep these hooks apart from the other parts' hooks on the same events.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    cleared = false
    await start($)
    return next(e)
  })

  // No session.start fires after /clear: the first prompt after it starts the clock again.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    clock?.cancel()
    clock = null
    live = false
    cleared = true
    return next(e)
  })
  on('prompt.submit', { wait: [false, true] }, async ($, e, next) => {
    if (cleared) {
      cleared = false
      await start($)
    }
    return next(e)
  })

  // Every main-loop tool call other than the pane's own restarts the 5 s wait; a turn's end checks at once.
  on('tool.call', { tool: /^(?!mcp__mission-status__)/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) schedule($, QUIET_MS)
    return result
  })
  on('turn.complete', { turnId: /(?:)/ }, async ($, e, next) => {
    if (e.agentId === undefined) schedule($, 0)
    return next(e)
  })

  // The agent's own update wins: the marks for the items it sends go.
  on('tool.call', { tool: [UPDATE_TOOL] }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !('deny' in (result as object)) && (result as { isError?: boolean }).isError !== true) {
      const ids = sentIds(e as unknown as Record<string, unknown>)
      if (ids.length > 0)
        await update($, marksAtom, v => {
          if (v === null || !ids.some(id => id in v.marks)) return v
          const marks = { ...v.marks }
          for (const id of ids) delete marks[id]
          return { ...v, marks }
        }).catch(() => undefined)
    }
    return result
  })
}

// Test seam: module variables start over with each load; tests reset them.
export function resetMarker(): void {
  clock?.cancel()
  clock = null
  cleared = false
  reset()
}
