import { expect, mock, test } from 'claude-code/testing'
import { GIT_MS, ciNamed } from '../hooks/readers'
import { unionRefs } from '../hooks/register'

// The data layer: reads, the transcript scan, the hooks' registration and the background cut.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const OPEN_PR = { number: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7', title: 'Add the card', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }

type World = {
  branch?: string
  gh?: 'ok' | 'fail'
  prs?: Record<string, unknown>[]
  // gh pr view: the pull request the session made.
  view?: 'ok' | 'fail'
  // Whether a default branch can be found: origin/HEAD, else the first of main and master that exists.
  mainRefs?: boolean
  delay?: number
}

// A fake host: git and gh answer from the world; what the plugin asked is recorded.
function host(on: any, w: World) {
  const calls = { gitStatus: 0, gh: 0, mergeBase: [] as string[], top: 0, inFlight: 0, maxInFlight: 0 }
  on('agent.list', () => ({ value: [] }))
  on('process.run', async (_: unknown, e: { argv?: string[] }) => {
    const a = e.argv ?? []
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'HTTP 502', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git' && a[2] === '--show-toplevel') {
      calls.top++
      calls.inFlight++
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight)
      await new Promise(r => setTimeout(r, w.delay ?? 0))
      calls.inFlight--
      return ok('/repo\n')
    }
    if (a[0] === 'git') {
      if (a[1] === 'branch') return ok(`${w.branch ?? 'feature/x'}\n`)
      if (a[1] === 'symbolic-ref') return ok('', 1)
      if (a[1] === 'rev-parse' && a[2] === '@{u}') return ok('u1\n')
      if (a[1] === 'rev-parse' && a[2] === '--verify') return w.mainRefs === true ? ok('abc\n') : ok('', 1)
      if (a[1] === 'rev-parse') return ok('abc\n')
      if (a[1] === 'merge-base') {
        calls.mergeBase.push(String(a[3]))
        return ok('abc\n')
      }
      if (a[1] === 'rev-list') return ok('1\n')
      if (a[1] === 'diff') return ok(' 1 file changed, 2 insertions(+)\n')
      if (a[1] === 'status') {
        calls.gitStatus++
        return ok('')
      }
      if (a[1] === 'remote') return ok('origin\n')
      return ok('')
    }
    if (a[0] === 'gh' && a[2] === 'view') {
      if (w.view === 'fail') return ok('', 1)
      return ok(JSON.stringify({ number: 9, title: 'Add the tab', url: 'https://github.com/acme/app/pull/9', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], mergedAt: null, headRefName: 'tabs' }))
    }
    if (a[0] === 'gh') {
      calls.gh++
      if (w.gh === 'fail') return ok('', 1)
      return ok(JSON.stringify(w.prs ?? []))
    }
    return ok('')
  })
  return calls
}

// The last value the plugin wrote under each key, as the engine stores it, and how often each key was written.
const writes: Record<string, number> = {}
function watch(on: any) {
  const stored: Record<string, any> = {}
  for (const k of Object.keys(writes)) delete writes[k]
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    const v = e.value as any
    writes[e.key] = (writes[e.key] ?? 0) + 1
    if (e.plugin === 'mission-status') stored[e.key] = v !== null && typeof v === 'object' && 'shape' in v && 'value' in v ? v.value : v
    return next(e)
  })
  return stored
}

// A session on the fake host with a mocked clock and an in-memory store.
// What the downstream classic hooks answer; a test sets them.
const hooks = { start: (): unknown => ({}), stop: (): unknown => ({}) }

async function boot($: any, on: any, w: World, extra: (on: any) => void = () => {}, entries: Record<string, unknown> = {}) {
  hooks.start = () => ({})
  hooks.stop = () => ({})
  const clock = mock.clock(on, { now: 1_000_000 })
  const stored = watch(on)
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  const calls = host(on, w)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'https://github.com/acme/app/pull/9\n' }))
  on('classic.SessionStart', () => hooks.start())
  on('classic.Stop', () => hooks.stop())
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  extra(on)
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return { clock, calls, store, stored }
}
const send = ($: any, args: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1, phases: ['Plan', 'Build', 'Test'], ...args } as never)
const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
// Advances the clock in 5 s steps, as the plugin's own tick runs.
const run = async (clock: any, ms: number) => {
  for (let k = 0; k < ms / 5_000; k++) await clock.advance(5_000)
}

test('F9: a failed gh read keeps the pull request the PRs tab already shows', { timeoutMs: 20_000 }, async ($, on) => {
  const w: World = { view: 'ok' }
  const { clock } = await boot($, on, w)
  await send($)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  await ui.press({ key: 'tab-prs' })
  expect(await text(ui, /^Add the tab$/)).toBe('Add the tab')
  w.view = 'fail'
  await run(clock, 65_000)
  expect(await text(ui, /^Add the tab$/)).toBe('Add the tab')
  await ui.unmount()
})

test('F11: polls do not overlap; the card never goes back to an older read', async ($, on) => {
  const { clock, calls, stored } = await boot($, on, { gh: 'ok', prs: [OPEN_PR], delay: 20 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  const before = stored.live?.reads ?? 0
  // Three agent updates at once: each asks for a forced poll while one runs.
  await Promise.all([send($), send($), send($)])
  await clock.settle()
  await new Promise(r => setTimeout(r, 200))
  expect(calls.maxInFlight).toBe(1)
  expect(stored.live.reads).toBeGreaterThan(before)
  await ui.unmount()
})

test('F12: two updates with the same version at once: only one is accepted', async ($, on) => {
  await boot($, on, {})
  const results = (await Promise.all([send($, { version: 2 }), send($, { version: 2 })])) as { deny?: string }[]
  expect(results.filter(r => r.deny !== undefined).length).toBe(1)
})

// A transcript the test grows; ASCII only, so a byte offset is a character offset.
const CREATE = (n: number) => `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_P${n}","name":"Bash","input":{"command":"gh pr create --fill"}}]}}`
const RESULT = (n: number, pr: number) => `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_P${n}","content":"https://github.com/acme/app/pull/${pr}"}]}}`
const transcript = (on: any, t: { path: string; text: string; reads?: number }) => {
  on('session.info', () => ((t.reads = (t.reads ?? 0) + 1), { value: { transcriptPath: t.path } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: t.text.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_: unknown, e: { offset?: number; length?: number }) => ({ value: t.text.slice(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? t.text.length)) }))
}

test('F13: a tail with no newline that is shorter than a whole part waits for the next tick', async ($, on) => {
  const t = { path: '/t.jsonl', text: CREATE(1) }
  const { clock } = await boot($, on, { view: 'ok' }, o => transcript(o, t))
  await send($)
  t.text = `${CREATE(1)}\n${RESULT(1, 9)}\n`
  await run(clock, 10_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  await ui.press({ key: 'tab-prs' })
  expect(await text(ui, /^Add the tab$/)).toBe('Add the tab')
  await ui.unmount()
})

test('F14: another transcript path is scanned from its start', async ($, on) => {
  const t = { path: '/a.jsonl', text: `${CREATE(1)}\n${RESULT(1, 8)}\n` }
  const { clock } = await boot($, on, { view: 'ok' }, o => transcript(o, t))
  await send($)
  await clock.settle()
  // The next transcript is longer, so the old scan position lies inside it.
  t.path = '/b.jsonl'
  t.text = `${CREATE(2)}\n${RESULT(2, 9)}\n${'{"type":"x"}\n'.repeat(50)}`
  await run(clock, 10_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  await ui.press({ key: 'tab-prs' })
  expect(await text(ui, /^Add the tab$/)).toBe('Add the tab')
  await ui.unmount()
})

test('F22: a failure after the next hook ran does not run it again', async ($, on) => {
  const seen = { start: 0, stop: 0 }
  await boot($, on, {})
  hooks.start = () => {
    seen.start++
    throw new Error('downstream broke')
  }
  hooks.stop = () => {
    seen.stop++
    throw new Error('downstream broke')
  }
  await $.classic.SessionStart({ source: 'startup' } as never).catch(() => undefined)
  await $.classic.Stop({ stop_hook_active: false } as never).catch(() => undefined)
  expect(seen).toEqual({ start: 1, stop: 1 })
})

test('F27: a second session.start cancels the clocks of the first', async ($, on) => {
  const t = { path: '/t.jsonl', text: '', reads: 0 }
  const { clock } = await boot($, on, {}, o => transcript(o, t))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  t.reads = 0
  await clock.advance(5_000)
  await clock.settle()
  expect(t.reads).toBe(1)
})

test('F30: a default branch that was not verified is looked for again', async ($, on) => {
  const w: World = { mainRefs: false }
  const { clock, calls } = await boot($, on, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  expect(calls.mergeBase.at(-1)).toBe('main')
  w.mainRefs = true
  await run(clock, GIT_MS + 5_000)
  expect(calls.mergeBase.at(-1)).toBe('origin/main')
  await ui.unmount()
})

test('F30: the CI of a pull request no item names is dropped', () => {
  const ci = { 'a/b#1': { state: 'passing' as const, start: null, end: null }, 'a/b#2': { state: 'running' as const, start: null, end: null } }
  expect(Object.keys(ciNamed(ci, ['a/b#2']))).toEqual(['a/b#2'])
})

test('F30: the pull request list keeps the newest 30, the earlier first', () => {
  const list = Array.from({ length: 30 }, (_, k) => `a/b#${k + 1}`)
  const out = unionRefs(list, ['a/b#5', 'a/b#31', 'a/b#32'])
  expect(out.length).toBe(30)
  expect(out.slice(-3)).toEqual(['a/b#30', 'a/b#31', 'a/b#32'])
  expect(out[0]).toBe('a/b#3')
})

test('cut: with the pane closed git is not read; open, git is read every 15 s', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, calls } = await boot($, on, { gh: 'ok', prs: [] })
  await run(clock, 60_000)
  expect(calls.gitStatus).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  const first = calls.gitStatus
  expect(first).toBe(1)
  await run(clock, 60_000)
  expect(calls.gitStatus - first).toBe(4)
  expect(GIT_MS).toBe(15_000)
  await ui.unmount()
})

test('cut: the 1 s clock writes only while a stage, item or helper is in progress', async ($, on) => {
  const { clock, stored } = await boot($, on, {})
  // Every stage passed and no item runs: no timer shows.
  await send($, { phase: 3, items: [{ id: 'a', phase: 2, name: 'Done thing', status: 'done' }] })
  expect(stored.summary.phase).toBe(3)
  // The welcome demo of a new session writes the clock by itself, so the idle count is the base the busy one is held to.
  writes.now = 0
  await clock.advance(3_000)
  const idle = writes.now ?? 0
  // The agent's update is a main-loop tool call, so a turn runs: the item runs and its timer ticks every second.
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await send($, { phase: 1, items: [{ id: 'a', phase: 1, name: 'Work', status: 'now' }] })
  writes.now = 0
  await clock.advance(3_000)
  expect((writes.now ?? 0) - idle).toBeGreaterThanOrEqual(3)
  // The turn ends with the item still "now": it is open, not running, and no timer runs (the 12-hour clock).
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  writes.now = 0
  await clock.advance(3_000)
  expect((writes.now ?? 0) - idle).toBeLessThanOrEqual(0)
})
