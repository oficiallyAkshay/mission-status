import { expect, mock, test } from 'claude-code/testing'
import { ciOf } from '../hooks/readers'

// ui.find ignores alt: a drawing is found by its description through findAll.
const svgAlt = async (ui: { findAll: (q: { type: string }) => Promise<{ props?: Record<string, unknown> }[]> }, alt: RegExp) =>
  (await ui.findAll({ type: 'Svg' })).find(x => alt.test(String(x.props?.alt ?? '')))

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type World = {
  git?: 'ok' | 'missing' | 'norepo'
  gh?: 'ok' | 'missing' | 'signedout' | 'fail'
  remote?: boolean
  prs?: Record<string, unknown>[]
  upstream?: string
}
const OPEN_PR = { number: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7', title: 'Add the card', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }

// A fake host: git and gh answer from the world; calls are counted by kind.
function host(on: any, w: World) {
  const calls = { gitStatus: 0, gh: 0, top: 0, ghArgs: [] as string[][] }
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_: unknown, e: { argv?: string[] }) => {
    const a = e.argv ?? []
    const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git') {
      if (w.git === 'missing') throw new Error('spawn git ENOENT')
      if (a[1] === 'rev-parse' && a[2] === '--show-toplevel') {
        calls.top++
        return w.git === 'norepo' ? ok('', 128, 'fatal: not a git repository') : ok('/repo\n')
      }
      if (a[1] === 'branch') return ok('feature/x\n')
      if (a[1] === 'rev-parse' && a[2] === '@{u}') return ok(`${w.upstream ?? 'u1'}\n`)
      if (a[1] === 'rev-parse') return ok('abc\n')
      if (a[1] === 'merge-base') return ok('abc\n')
      if (a[1] === 'rev-list') return ok(a[3]?.startsWith('HEAD..') ? '2\n' : '3\n')
      if (a[1] === 'diff') return ok(' 4 files changed, 120 insertions(+), 30 deletions(-)\n')
      if (a[1] === 'status') {
        calls.gitStatus++
        return ok('')
      }
      if (a[1] === 'remote') return ok(w.remote === false ? '' : 'origin\n')
      return ok('')
    }
    if (a[0] === 'gh') {
      calls.gh++
      calls.ghArgs.push(a)
      if (w.gh === 'missing') throw new Error('spawn gh ENOENT')
      if (w.gh === 'signedout') return ok('', 4, 'To get started with GitHub CLI, please run:  gh auth login')
      if (w.gh === 'fail') return ok('', 1, 'HTTP 502: Bad Gateway')
      return ok(JSON.stringify(w.prs ?? []))
    }
    return ok('')
  })
  return calls
}

const mountText = async ($: any, re: RegExp) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const found = (await ui.find({ type: 'Text', text: re }))?.text
  await ui.unmount()
  return found as string | undefined
}
// Starts a session on the fake host with a mocked clock and store: the plugin polls at start and every 5 s.
async function boot($: any, on: any, w: World, entries: Record<string, unknown> = {}, now = Date.now()) {
  const clock = mock.clock(on, { now })
  // The plugin's own store, in memory, shared by every session of the test.
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const calls = host(on, w)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The pane is open: git and GitHub are read only while it is.
  on('ui.panes', () => ({ value: [{ id: 'progress', title: 'Progress', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await clock.settle()
  return { clock, calls, store }
}
const send = async ($: any, clock: { settle: () => Promise<void> }, args: Record<string, unknown> = {}) => {
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1, phases: ['Plan', 'Build', 'Test'], ...args } as never)
  await clock.settle()
}


// The poll tick: the plugin polls every 5 s; git and GitHub keep their own, longer turns.
const TICK = 5_000

test('poll timing: git every 15 s while the pane is open', async ($, on) => {
  const { clock, calls } = await boot($, on, { gh: 'ok', prs: [OPEN_PR] })
  const git0 = calls.gitStatus
  for (let k = 0; k < 12; k++) await clock.advance(TICK)
  // 12 polls 5 s apart, 60 s in all: a git read every 15 s, 4 more.
  expect(git0).toBe(1)
  expect(calls.gitStatus).toBe(5)
})

test('state: stale after 15 minutes with no update shows the age in amber', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock)
  await clock.advance(23 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /^No update from the agent for 2[23] min\./ })
  expect(line?.props?.color).toBe('warning')
  await ui.unmount()
})

test('state: fresh within 15 minutes shows no stale line', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock)
  await clock.advance(14 * 60_000)
  expect(await mountText($, /^No update from the agent/)).toBeUndefined()
})

test('state: all done shows no done line and no stale line: the folded cards say it', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock, { phase: 0 })
  await send($, clock, { phase: 3 })
  await clock.advance(60 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /cards are done/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^No update from the agent/ })).toBeFalsy()
  await ui.unmount()
})

test('state: empty before any update offers the Update button', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^No progress yet\./ })).toBeTruthy()
  expect(await ui.find({ key: 'update-empty' })).toBeTruthy()
  await ui.unmount()
})

test('times: a running timer is the quiet caption grey, never accent text', async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Every time on the pane, running or done, is the quiet caption style: accent colour was too much emphasis.
  const timer = await ui.find({ type: 'Text', text: /^\d+s$/ })
  expect(timer?.props?.color).toBe('rgba(128, 128, 128, 0.75)')
  expect(timer?.props?.size).toBe('caption')
  await ui.unmount()
})

test('item CI: the checks of an item pull request give its state and run time', () => {
  const t0 = '2026-11-25T05:00:00Z'
  expect(ciOf([])).toEqual({ state: 'none', start: null, end: null })
  const done = ciOf([
    { status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: t0, completedAt: '2026-11-25T05:03:10Z' },
    { status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-25T05:00:30Z', completedAt: '2026-11-25T05:04:05Z' },
  ])
  expect(done.state).toBe('passing')
  expect((done.end ?? 0) - (done.start ?? 0)).toBe(245_000)
  const running = ciOf([{ status: 'IN_PROGRESS', conclusion: '', startedAt: t0, completedAt: '0001-01-01T00:00:00Z' }])
  expect(running.state).toBe('running')
  expect(running.end).toBe(null)
  expect(ciOf([{ status: 'COMPLETED', conclusion: 'FAILURE', startedAt: t0, completedAt: t0 }]).state).toBe('failing')
})

test('background cut: with the pane closed, git is not read, and GitHub only for the pull requests', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const calls = host(on, { gh: 'ok', prs: [OPEN_PR] })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  for (let k = 0; k < 12; k++) await clock.advance(TICK)
  expect(calls.gitStatus).toBe(0)
  // The PR list of the session's repository, once a minute, and no other gh read.
  expect(calls.ghArgs.every(a => a.slice(0, 3).join(' ') === 'gh pr list')).toBe(true)
  expect(calls.ghArgs.length).toBe(2)
})
