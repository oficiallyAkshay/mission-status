import { prRecordOf, summaryOf } from '../hooks/readers'
import { expect, mock, test } from 'claude-code/testing'
import { branchesIn, prRefsInTranscript } from '../hooks/model'

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
  holdback?: boolean
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
  if (w.holdback)
    on('state.get', async (_: unknown, e: { plugin: string; key: string }, next: (e: unknown) => unknown) =>
      e.plugin === 'mission-status' && e.key === 'holdback' ? { value: { value: true, version: 1 } } : next(e),
    )
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

test('holdback: a holdback session makes no gh call at all', async ($, on) => {
  const w: World = { prs: { 'acme/app#9': pr('acme/app#9') }, holdback: true, bash: () => 'https://github.com/acme/app/pull/9\n' }
  const { clock, gh } = await boot($, on, w)
  await bash($, 'gh pr create --fill')
  await run(clock, 3 * 60_000)
  expect(gh).toEqual([])
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
