import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, SessionMessage } from 'claude-code'
import type { Item, ItemStatus, Marks, Summary } from '../types'
import { UPDATE_TOOL, idOf } from './model'
import { deriveNow } from './store'

// The marker: between agent updates, Haiku (through the session's own client) reads the newest main-loop tool calls
// and marks which open items are now done, in progress or failed. A mark is kept only when two checks in a row agree; the agent's own update clears the marks for the items it
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
// How many of the newest record lines the record file keeps.
export const RECORD_LINES = 500

const marksAtom = atom({ plugin: 'mission-status', key: 'marks' } as const, null as Marks | null)
// A headless run (claude -p, an SDK host, a helper job): no person sees a pane (metrics.tsx writes it at session start).
const headless = atom({ plugin: 'mission-status', key: 'headless' } as const, false as boolean)

export const EMPTY: Marks = { marks: {}, fails: 0 }

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

// The agent's items the machine shows open: the only items a mark can change. The machine's merge keeps the agent's
// items first and in order, with their status after bound steps, merged pull requests and kept marks.
export type Open = { id: string; name: string; status: ItemStatus }
export function openItems(s: NonNullable<Summary>, items: Item[]): Open[] {
  return items
    .slice(0, s.items.length)
    .filter(x => x.status !== 'done')
    .map(x => ({ id: x.id ?? idOf(x.name), name: x.name, status: x.status }))
}

export const SYSTEM =
  'You keep a progress list current from what a coding session does. You get the open items and the newest tool ' +
  'calls, one line each, oldest first. Mark an item only when the tool calls clearly show it: done when its work is ' +
  'finished, now when its work is under way, failed when its work failed and nothing fixed it after. ' +
  'When unsure, leave it out. Answer with JSON only, no other text: {"marks":[{"id":"...","status":"done|now|failed"}]}'

export function buildPrompt(open: Open[], lines: string[]): string {
  return JSON.stringify({ openItems: open, recentToolCalls: lines })
}

// Reads the model's answer. A bad or cut reply gives null (no answer); marks that name no open item are dropped.
export type Answer = { marks: Record<string, Exclude<ItemStatus, 'next'>> }
export function readAnswer(text: string, open: Open[]): Answer | null {
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
  const rawMarks = (json as { marks?: unknown }).marks
  if (rawMarks !== undefined && !Array.isArray(rawMarks)) return null
  const marks: Answer['marks'] = {}
  for (const m of (rawMarks ?? []) as { id?: unknown; status?: unknown }[]) {
    const x = open.find(y => y.id === m?.id)
    const st = m?.status
    if (x !== undefined && (st === 'done' || st === 'now' || st === 'failed') && st !== x.status) marks[x.id] = st
  }
  return { marks }
}

// What two answers in a row agree on.
export function agreed(a: Answer, b: Answer | null): Answer {
  const marks: Answer['marks'] = {}
  if (b !== null) for (const [id, st] of Object.entries(a.marks)) if (b.marks[id] === st) marks[id] = st
  return { marks }
}

// ---------------------------------------------------------------- the loop

let clock: { cancel: () => void } | null = null
let live = false
// A first answer that named a mark the last one did not: the next check may ask again on the same tool lines.
let pending = false
let busy = false
// A check asked for while one runs (a turn end, say): it runs once the running check ends, never dropped.
let again = false
let stopped = false
let cleared = false
let lastId = ''
let previous: Answer | null = null

function reset(): void {
  pending = false
  busy = false
  again = false
  stopped = false
  lastId = ''
  previous = null
}

const off = async ($: EngineInterface): Promise<boolean> =>
  Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC').catch(() => undefined)) || (await read($, headless).catch(() => false))

// Schedule one check after a wait; a later schedule replaces an earlier one (the debounce).
export function schedule($: EngineInterface, ms: number): void {
  if (!live || stopped) return
  clock?.cancel()
  clock = $.clock.after(ms, () => void markTick($))
}

// One check: only after new main-loop tool calls (or to confirm a first answer), one at a time.
export async function markTick($: EngineInterface): Promise<void> {
  if (stopped) return
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    if (await off($)) return
    const machine = await deriveNow($)
    if (machine === null) return
    const rows = await $.session.messages({ last: ROWS })
    if (!Array.isArray(rows)) return
    const calls = toolCalls(rows)
    if (calls.lastId === '' || (calls.lastId === lastId && !pending)) return
    const open = openItems(machine.s, machine.items)
    if (open.length === 0) return
    lastId = calls.lastId
    const r = await $.model.complete({ model: MODEL, prompt: buildPrompt(open, calls.lines), system: SYSTEM, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: TIMEOUT_MS }).catch(() => null)
    const got = r !== null && r.isAnswered ? readAnswer(r.text, open) : null
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
      // A kept mark stays while the agent's item is open and the agent still gives it another status.
      for (const [id, m] of Object.entries(was.marks))
        if (machine.s.items.some(x => (x.id ?? idOf(x.name)) === id && x.status !== 'done' && x.status !== m.status)) marks[id] = m
      for (const [id, status] of Object.entries(both.marks)) marks[id] = { status, at: now }
      return { marks, fails: 0 }
    })
    if ((st?.fails ?? 0) >= MAX_FAILS) stopped = true
    if (pending) schedule($, CONFIRM_MS)
    await record($, {
      at: now,
      answered: got !== null,
      reason: r === null ? 'refused' : r.isAnswered ? (got === null ? 'bad-reply' : null) : r.reason,
      session: await $.session.id(),
      marks: got?.marks ?? null,
      agreed: both !== null && Object.keys(both.marks).length > 0,
      kept: both ?? null,
      usage: r?.usage ?? null,
    })
  } catch {
    // A check that fails changes nothing; the next tick tries again.
  } finally {
    busy = false
    if (again && !stopped) {
      again = false
      schedule($, 0)
    }
  }
}

// One JSON line per model call in ~/.claude/mission-status/marker.jsonl, for all sessions, the newest RECORD_LINES
// only (the engine has no append, so each line rewrites a file of bounded size); never a tool line.
async function record($: EngineInterface, line: Record<string, unknown>): Promise<void> {
  try {
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    if (home === '') return
    const path = `${home}/.claude/mission-status/marker.jsonl`
    const was = (await $.fs.exists(path).catch(() => false)) ? await $.fs.read(path).catch(() => '') : ''
    const lines = [...(typeof was === 'string' ? was : '').split('\n').filter(Boolean), JSON.stringify(line)]
    await $.fs.write(path, `${lines.slice(-RECORD_LINES).join('\n')}\n`)
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
