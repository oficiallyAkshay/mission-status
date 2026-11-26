import { expect, mock, test } from 'claude-code/testing'
import { CONFIRM_MS, QUIET_MS, resetMarker } from '../hooks/marker'
import { branchesIn, prRefsInTranscript } from '../hooks/model'
import { ciNamed, ciOf, GIT_MS, prRecordOf, summaryOf } from '../hooks/readers'
import { unionRefs } from '../hooks/register'

// Each block below was one test file. The blocks keep their own helpers and state; one file runs in one child.

// ---- was merge.test.tsx
{
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
}

// ---- was prs.test.tsx
{
// Track C: one record per pull request feeds the item chip, the PRs tab and the Deploy count.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type World = {
  // gh pr view answers, by owner/name#number.
  prs: Record<string, Record<string, unknown>>
  // gh pr list --author @me answers.
  mine?: Record<string, unknown>[]
  branch?: string
  // A pane that is not placed: the pane is closed.
  closed?: boolean
  // What the Bash tool answers.
  bash?: (command: string) => string
  limited?: boolean
}

const pr = (ref: string, o: Record<string, unknown> = {}) => {
  const [repo, n] = ref.split('#')
  return { number: Number(n), title: `PR ${n}`, url: `https://github.com/${repo}/pull/${n}`, state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', statusCheckRollup: [], mergedAt: null, headRefName: 'feature/x', ...o }
}

// A fake host: git and gh answer from the world; every gh call is recorded.
async function boot($: any, on: any, w: World, extra: (on: any) => void = () => {}, entries: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const gh: string[][] = []
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_: unknown, e: { argv?: string[] }) => {
    const a = e.argv ?? []
    const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git') {
      if (a[1] === 'rev-parse' && a[2] === '--show-toplevel') return ok('/repo\n')
      if (a[1] === 'branch') return ok(`${w.branch ?? 'feature/x'}\n`)
      if (a[1] === 'remote' && a[2] === 'get-url') return ok('git@github.com:acme/app.git\n')
      return ok('')
    }
    if (a[0] === 'gh') {
      gh.push(a)
      if (w.limited) return ok('', 1, 'API rate limit exceeded for user')
      if (a[2] === 'list') return ok(JSON.stringify(w.mine ?? []))
      if (a[2] === 'view') {
        const ref = `${a[a.indexOf('-R') + 1]}#${a[3]}`
        const got = w.prs[ref]
        return got === undefined ? ok('', 1, 'no pull requests found') : ok(JSON.stringify(got))
      }
    }
    return ok('', 1)
  })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: w.closed ? [] : [{ id: 'progress', title: 'Progress', isShown: true, isFocused: false, isPlaced: true }] }))
  on('tool.call', { tool: 'Bash' }, (_: unknown, e: { command?: string }) => ({ result: w.bash?.(String(e.command ?? '')) ?? '' }))
  extra(on)
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const views = (ref: string) => gh.filter(a => a[2] === 'view' && `${a[a.indexOf('-R') + 1]}#${a[3]}` === ref).length
  return { clock, gh, views, store }
}
const send = ($: any, args: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1, phases: ['Plan', 'Build', 'Deploy'], ...args } as never)
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as never)
const run = async (clock: any, ms: number) => {
  for (let k = 0; k < ms / 5_000; k++) await clock.advance(5_000)
}
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text ?? ''))
const svgAlts = async (ui: any) => (await ui.findAll({ type: 'Svg' })).map((x: any) => String(x.props?.alt ?? ''))
const tabPrs = async ($: any, clock: any) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  await ui.press({ key: 'tab-prs' })
  const out = await texts(ui)
  await ui.unmount()
  return out
}

test('one record: one read feeds the item chip, the PRs tab and the Deploy count', async ($, on) => {
  const w: World = { prs: { 'acme/app#9': pr('acme/app#9', { state: 'MERGED', mergedAt: '2026-11-25T02:00:00Z' }) }, bash: () => 'https://github.com/acme/app/pull/9\n' }
  const { clock, views } = await boot($, on, w)
  await send($, { items: [{ id: 'ship', phase: 1, name: 'Ship it', status: 'now', pr: 9 }] })
  await bash($, 'gh pr create --fill')
  await run(clock, 10_000)
  // The item names 9 in the work's repository and the session made acme/app#9: one record, one read.
  expect(views('acme/app#9')).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  expect(await svgAlts(ui)).toContain('Pull request 9: merged')
  await ui.unmount()
  expect(await tabPrs($, clock)).toContain('PR 9')
  // The Deploy stage, with no count of its own, counts the session's pull requests from the same record.
  await send($, { phase: 2 })
  const deploy = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  await deploy.press({ key: 'tab-progress' })
  // 1 of 1 merged: the Deploy gate is met.
  expect(await svgAlts(deploy)).toContain('Gate met: every pull request merges')
  await deploy.unmount()
})

test('a merged pull request is not read again; an open one is read once a minute', async ($, on) => {
  const w: World = {
    prs: { 'acme/app#1': pr('acme/app#1', { state: 'MERGED', mergedAt: '2026-11-25T02:00:00Z' }), 'acme/app#2': pr('acme/app#2') },
    bash: c => (c.includes('one') ? 'https://github.com/acme/app/pull/1\n' : 'https://github.com/acme/app/pull/2\n'),
  }
  const { clock, views } = await boot($, on, w)
  await bash($, 'gh pr create --title one')
  await bash($, 'gh pr create --title two')
  await run(clock, 10_000)
  expect(views('acme/app#1')).toBe(1)
  expect(views('acme/app#2')).toBe(1)
  await run(clock, 3 * 60_000)
  expect(views('acme/app#1')).toBe(1)
  expect(views('acme/app#2')).toBe(4)
})

test('the pull requests are read while the pane is closed', async ($, on) => {
  const w: World = { prs: { 'acme/app#9': pr('acme/app#9') }, closed: true, bash: () => 'https://github.com/acme/app/pull/9\n' }
  const { clock, views } = await boot($, on, w)
  await bash($, 'gh pr create --fill')
  await clock.settle()
  expect(views('acme/app#9')).toBe(1)
  await run(clock, 60_000)
  expect(views('acme/app#9')).toBe(2)
})

test('a rate-limited reply stops the reads for a while and keeps the last record', async ($, on) => {
  const w: World = { prs: { 'acme/app#9': pr('acme/app#9') }, bash: () => 'https://github.com/acme/app/pull/9\n' }
  const { clock, gh } = await boot($, on, w)
  await send($)
  await bash($, 'gh pr create --fill')
  await clock.settle()
  w.limited = true
  await run(clock, 60_000)
  const atLimit = gh.length
  // 60 s with no gh call after the refused one.
  await run(clock, 55_000)
  expect(gh.length).toBe(atLimit)
  expect(await tabPrs($, clock)).toContain('PR 9')
})

test('a Marga job that opens a pull request in another repository is caught, live and in the transcript', async ($, on) => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_M1","name":"Bash","input":{"command":"marga run --repo other/lib job.md"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_M1","content":[{"type":"text","text":"done: https://github.com/other/lib/pull/4"}]}]}}',
  ]
  const t = `${lines.join('\n')}\n`
  const w: World = {
    prs: { 'other/lib#4': pr('other/lib#4', { title: 'From the run' }), 'other/tool#5': pr('other/tool#5', { title: 'From the collect' }) },
    bash: c => (c.startsWith('marga collect') ? 'job 2 finished\nhttps://github.com/other/tool/pull/5\n' : ''),
  }
  const { clock, views } = await boot($, on, w, o => {
    o('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } }))
    o('fs.stat', () => ({ value: { kind: 'file', size: t.length, mtimeMs: 0, isLink: false } }))
    o('fs.read', (_: unknown, e: { offset?: number; length?: number }) => ({ value: t.slice(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? t.length)) }))
  })
  await send($)
  await bash($, 'marga collect job-2')
  await run(clock, 10_000)
  expect(views('other/lib#4')).toBe(1)
  expect(views('other/tool#5')).toBe(1)
  const tab = await tabPrs($, clock)
  expect(tab).toContain('From the run')
  expect(tab).toContain('From the collect')
  expect(prRefsInTranscript(t)).toEqual(['other/lib#4'])
})

test('a pull request a gh pr list output names, on another branch, is not caught', async ($, on) => {
  const w: World = {
    prs: { 'acme/app#7': pr('acme/app#7', { headRefName: 'feature/x' }), 'acme/app#8': pr('acme/app#8', { headRefName: 'named-b' }), 'acme/app#3': pr('acme/app#3', { headRefName: 'someone-else' }) },
    mine: [
      { number: 7, url: 'https://github.com/acme/app/pull/7', headRefName: 'feature/x' },
      { number: 8, url: 'https://github.com/acme/app/pull/8', headRefName: 'named-b' },
      { number: 3, url: 'https://github.com/acme/app/pull/3', headRefName: 'someone-else' },
    ],
    bash: c => (c.startsWith('gh pr list') ? 'someone-else  https://github.com/acme/app/pull/3\n' : ''),
  }
  const { clock, views } = await boot($, on, w)
  await send($)
  await bash($, 'gh pr list --head someone-else')
  // A branch this session's own input names counts.
  await bash($, 'git push -u origin named-b')
  await run(clock, 60_000)
  const tab = await tabPrs($, clock)
  // The current branch's pull request and the pushed branch's are kept; the other branch's is not.
  expect(tab).toContain('PR 7')
  expect(tab).toContain('PR 8')
  expect(tab).not.toContain('PR 3')
  expect(views('acme/app#3')).toBe(0)
})

test('the branches a command names as its own input', () => {
  expect(branchesIn('git push -u origin feat/a && gh pr create --head feat/b --fill')).toEqual(['feat/a', 'feat/b'])
  expect(branchesIn('git -C /w checkout -b fix-1; git switch -c fix-2')).toEqual(['fix-1', 'fix-2'])
  expect(branchesIn('git worktree add -b wt-1 ../wt')).toEqual(['wt-1'])
  expect(branchesIn('git push origin HEAD:refs/heads/rel')).toEqual(['rel'])
  expect(branchesIn('git push')).toEqual([])
  expect(branchesIn('gh pr list --head other')).toEqual([])
})

test('the pull request list is saved with the pane, and a restore takes it back', async ($, on) => {
  const slot = 'pane-test-session-0002'
  const info = (o: any) => o('session.info', () => ({ value: { transcriptPath: '/x/projects/p/test-session-0002.jsonl' } }))
  const w: World = { prs: { 'acme/app#9': pr('acme/app#9') }, bash: () => 'https://github.com/acme/app/pull/9\n' }
  const { clock, store } = await boot($, on, w, info)
  await send($)
  await bash($, 'gh pr create --fill')
  await clock.settle()
  expect((store.get(slot) as { prRefs?: string[] }).prRefs).toEqual(['acme/app#9'])
})

test('a session that starts with no state takes back its pull request list', async ($, on) => {
  const slot = 'pane-test-session-0003'
  const saved = { summary: { project: 'Saved work', phases: ['Plan', 'Build'], phase: 1, stage: 'build', items: [] }, tasks: [], prRefs: ['acme/app#9'], prBranches: ['named-b'] }
  const w: World = { prs: { 'acme/app#9': pr('acme/app#9') } }
  const { clock, views } = await boot($, on, w, o => o('session.info', () => ({ value: { transcriptPath: '/x/projects/p/test-session-0003.jsonl' } })), { [slot]: saved })
  expect(views('acme/app#9')).toBe(1)
  expect(await tabPrs($, clock)).toContain('PR 9')
})

test('a pull request card reads repository and number, then its icon and title, then a two-sentence summary, and opens to Commits, CI and Details', () => {
  const r = prRecordOf('acme/app#9', {
    number: 9, title: 'Add the tab', url: 'https://github.com/acme/app/pull/9', state: 'OPEN', isDraft: false, headRefName: 'b',
    body: '## Summary\nThe pane lists pull requests. Each card opens to its facts. A third sentence is left out.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    commits: [{ oid: 'abcdef123456', messageHeadline: 'First' }, { oid: '1234567aaaa', messageHeadline: 'Second' }],
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }, { name: 'lint', status: 'IN_PROGRESS' }],
  }, 0)
  expect(r.summary).toBe('The pane lists pull requests. Each card opens to its facts.')
  expect(r.commits?.[0]).toEqual({ sha: '1234567', title: 'Second' })
  expect(r.checks?.map(c => c.state)).toEqual(['passing', 'running'])
  expect(summaryOf('')).toBe('')
  // A period inside a version or a file name never ends a sentence.
  expect(summaryOf('The pane ships 0.12.0 today (see machine.ts). It runs live.')).toBe('The pane ships 0.12.0 today (see machine.ts). It runs live.')
})
}

// ---- was data.test.tsx
{
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
}

// ---- was marker.test.tsx
{
// The marker: Haiku marks open items from the newest tool calls; two checks in a row must agree.

const UPDATE = 'mcp__mission-status__update'
const USAGE = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SECRET = 'SECRET-FILE-TEXT-42'

type World = {
  env?: Record<string, string>
  // The model's replies, one per call; 'timeout' answers aborted.
  replies: string[]
}

let useId = 0
const row = (tool: string, input: Record<string, unknown>, text: string, isError = false) => ({
  role: 'assistant' as const,
  text: '',
  toolUses: [{ tool_use_id: `t${++useId}`, tool, input, text, ...(isError ? { isError: true as const } : {}) }],
})

async function boot($: any, on: any, w: World) {
  resetMarker()
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u', ...(w.env ?? {}) })
  mock.store(on)
  const rows: any[] = []
  const asks: any[] = []
  const files = new Map<string, string>()
  const stored: Record<string, any> = {}
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    const v = e.value as any
    if (e.plugin === 'mission-status') stored[e.key] = v !== null && typeof v === 'object' && 'shape' in v && 'value' in v ? v.value : v
    return next(e)
  })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: rows.slice() }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(e.path, e.text), { value: undefined }))
  on('model.complete', (_: unknown, e: any) => {
    asks.push(e)
    const r = w.replies.shift() ?? 'timeout'
    return { value: r === 'timeout' ? { isAnswered: false, reason: 'aborted', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } } : { isAnswered: true, text: r, usage: USAGE } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: UPDATE,
    project: 'P',
    stage: 'build',
    phase: 1,
    phases: ['Plan', 'Build', 'Test'],
    items: [
      { id: 'tests', phase: 1, name: 'Write tests', status: 'now' },
      { id: 'docs', phase: 1, name: 'Write docs', status: 'next' },
    ],
  } as never)
  await clock.settle()
  // One check: a new main-loop tool call, then the 5 s quiet wait.
  const check = async (call = row('Bash', { description: 'Run the tests' }, '12 passed\n')) => {
    rows.push(call)
    await $.tool.call({ tool: 'Bash', command: 'true' } as never)
    await clock.advance(QUIET_MS)
  }
  return { clock, rows, asks, files, stored, check, marks: () => stored.marks as { marks: Record<string, { status: string }>; places: unknown[]; fails: number } | undefined }
}

const DONE = JSON.stringify({ marks: [{ id: 'tests', status: 'done' }], places: [] })

test('two agreeing answers keep a mark; one answer does not', async ($, on) => {
  const w = await boot($, on, { replies: [DONE, DONE] })
  await w.check()
  expect(w.asks.length).toBe(1)
  expect(w.marks()?.marks.tests).toBeUndefined()
  await w.check()
  expect(w.asks.length).toBe(2)
  expect(w.marks()?.marks.tests?.status).toBe('done')
})

test('a request asks haiku with a 60 s time limit and low effort', async ($, on) => {
  const w = await boot($, on, { replies: [DONE] })
  await w.check()
  expect(w.asks[0]?.model).toBe('haiku')
  expect(w.asks[0]?.timeoutMs).toBe(60_000)
  expect(w.asks[0]?.effort).toBe('low')
  expect(String(w.asks[0]?.prompt)).toContain('Write tests')
})

test('a timeout changes no mark, and 3 failures in a row stop the marker and set fails', async ($, on) => {
  const world: World = { replies: [DONE, 'timeout', DONE, 'timeout', 'timeout'] }
  const w = await boot($, on, world)
  await w.check()
  await w.check()
  expect(w.marks()?.marks.tests).toBeUndefined()
  // The answer after the timeout still agrees with the one before it.
  await w.check()
  expect(w.marks()?.marks.tests?.status).toBe('done')
  await w.check()
  await w.check()
  expect(w.marks()?.marks.tests?.status).toBe('done')
  // A bad reply is the third failure in a row.
  world.replies.push('not json', DONE)
  await w.check()
  expect(w.marks()?.fails).toBe(3)
  const asked = w.asks.length
  await w.check()
  expect(w.asks.length).toBe(asked)
})

test('no call with the traffic variable set', async ($, on) => {
  const w = await boot($, on, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, replies: [DONE] })
  await w.check()
  await w.check()
  expect(w.asks.length).toBe(0)
})

test('no call without new tool calls; a first answer is confirmed 5 s later on the same lines, then nothing more', async ($, on) => {
  const w = await boot($, on, { replies: [DONE, DONE] })
  await w.clock.advance(60_000)
  expect(w.asks.length).toBe(0)
  await w.check()
  expect(w.asks.length).toBe(1)
  await w.clock.advance(CONFIRM_MS)
  expect(w.asks.length).toBe(2)
  expect(w.marks()?.marks.tests?.status).toBe('done')
  await w.clock.advance(60_000)
  expect(w.asks.length).toBe(2)
})

test('the 5 s wait restarts with each tool call, and a turn end checks at once', async ($, on) => {
  const w = await boot($, on, { replies: [DONE, DONE] })
  w.rows.push(row('Bash', { description: 'Run the tests' }, '12 passed\n'))
  await $.tool.call({ tool: 'Bash', command: 'true' } as never)
  await w.clock.advance(QUIET_MS - 1_000)
  await $.tool.call({ tool: 'Bash', command: 'true' } as never)
  await w.clock.advance(QUIET_MS - 1_000)
  expect(w.asks.length).toBe(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await w.clock.advance(0)
  expect(w.asks.length).toBe(1)
})

test('an agent update clears the marks for the items it sends', async ($, on) => {
  const w = await boot($, on, { replies: [DONE, DONE] })
  await w.check()
  await w.check()
  expect(w.marks()?.marks.tests?.status).toBe('done')
  await $.tool.call({ tool: UPDATE, patch: [{ op: 'change', id: 'tests', status: 'done' }] } as never)
  expect(w.marks()?.marks.tests).toBeUndefined()
})

test('the record line has usage and no tool lines', async ($, on) => {
  const w = await boot($, on, { replies: [DONE] })
  await w.check(row('Bash', { description: 'Run the unit suite' }, 'all good\n'))
  const text = w.files.get('/home/u/.claude/mission-status/marker/s1.jsonl') ?? ''
  const lines = text.trim().split('\n')
  expect(lines.length).toBe(1)
  const line = JSON.parse(lines[0] ?? '{}')
  expect(line.usage.input_tokens).toBe(120)
  expect(line.marks).toEqual({ tests: 'done' })
  expect(text).not.toContain('Run the unit suite')
  expect(text).not.toContain('all good')
})

test('a Read or Edit result text never reaches the prompt', async ($, on) => {
  const w = await boot($, on, { replies: [DONE, DONE] })
  w.rows.push(row('Read', { file_path: '/repo/src/a.ts' }, `${SECRET}\nline two`))
  await w.check(row('Edit', { file_path: '/repo/src/b.ts', old_string: 'x', new_string: 'y' }, `${SECRET} updated`))
  const prompt = String(w.asks[0]?.prompt)
  expect(prompt).toContain('Read: a.ts -> ok')
  expect(prompt).toContain('Edit: b.ts -> ok')
  expect(prompt).not.toContain(SECRET)
})
}
