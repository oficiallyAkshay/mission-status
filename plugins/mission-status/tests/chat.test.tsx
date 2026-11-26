import { expect, mock, test } from 'claude-code/testing'
import { CONSENT_KEY, FLUSH_MS, ID_KEY, NOTICE_KEY } from '../hooks/metrics'
import { expand } from '../hooks/doc'
import { bound } from '../hooks/quiet'

// Faults of the chat group: the quiet chat, the metrics consent, the document path and the docs.

const base = (on: any, isClock = true) => {
  on('tool.register', () => ({ value: {} }))
  if (isClock) on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  if (isClock) on('clock.every', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}
const quietStart = async ($: any, on: any, state: { key: string; value: unknown }[] = [], complete: () => unknown = () => ({ text: '' })) => {
  base(on)
  on('state.set', { key: /(?:)/ }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    state.push({ key: e.key, value: e.value })
    return next(e)
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', complete)
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1 } as never)
}
const shown = async ($: any, text: string) => {
  const ui = await $.ui.mount({ plugin: 'mission-status', component: 'AssistantMessage', requestId: 'm', props: { text, isFirstOfReply: false }, surface: 'desktop' } as never)
  const t = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return t
}
const done = ($: any, answer: string, turnId: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)

test('F3 quiet: a block shown before the turn began is not hidden when drawn again in the turn', async ($, on) => {
  await quietStart($, on)
  expect(await shown($, 'Shown between turns.')).toBe('Shown between turns.')
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect(await shown($, 'Shown between turns.')).toBe('Shown between turns.')
  await done($, 'Final one.', 't1')
  await $.turn.start({ text: 'next', turnId: 't2' } as never)
  expect(await shown($, 'Final one.')).toBe('Final one.')
  expect(await shown($, 'New narration.')).toBeUndefined()
})

test('F23 quiet: a turn.complete that throws below still ends the turn', async ($, on) => {
  await quietStart($, on, [], () => {
    throw new Error('below')
  })
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await done($, 'x', 't1').catch(() => undefined)
  expect(await shown($, 'Drawn after the turn.')).toBe('Drawn after the turn.')
})

test('F28 quiet: the hidden keys are kept in session state, the last 200', async ($, on) => {
  const state: { key: string; value: unknown }[] = []
  await quietStart($, on, state)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  for (let k = 0; k < 3; k++) await shown($, `Narration ${k}.`)
  await done($, 'Final.', 't1')
  const kept = state.filter(x => x.key === 'quietKept').at(-1)?.value as { hidden: string[] } | undefined
  expect(kept?.hidden).toEqual(['Narration 0.', 'Narration 1.', 'Narration 2.'])
  const many = new Set(Array.from({ length: 230 }, (_, k) => `n${k}`))
  bound(many)
  expect([...many].length).toBe(200)
  expect([...many].at(0)).toBe('n30')
})

// The metrics world: every request to PostHog is caught here.
const consented = { [CONSENT_KEY]: 'yes', [NOTICE_KEY]: true }
const metricsStart = async ($: any, on: any, opts: { store?: Record<string, unknown>; deny?: string } = {}) => {
  const bodies: unknown[] = []
  const state: { key: string; value: unknown }[] = []
  const commands: string[] = []
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  base(on, false)
  on('store.set', { key: /(?:)/ }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    if (opts.deny === e.key) return { deny: 'disk full' }
    store.set(e.key, e.value)
    return next(e)
  })
  on('state.set', { key: /(?:)/ }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    state.push({ key: e.key, value: e.value })
    return next(e)
  })
  const clock = mock.clock(on, { now: Date.UTC(2026, 11, 16) })
  mock.store(on, opts.store ?? {})
  mock.env(on, {})
  on('command.register', (_: unknown, e: { name: string }) => (commands.push(e.name), { value: { command: e.name } }))
  on('http.fetch', (_: unknown, e: { init?: { body?: string } }) => {
    bodies.push(JSON.parse(e.init?.body ?? '{}'))
    return { value: { status: 200, ok: true, headers: {}, text: '{"status":1}' } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return { bodies, state, store, clock, commands }
}
const work = async ($: any, n: number) => {
  for (let k = 0; k < n; k++) await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List' } as never)
}

test('F4 metrics: a stored no stops a session whose own value is yes, and makes no install id', async ($, on) => {
  // Another session wrote the stored no; this session's own value is still yes.
  on('state.get', { plugin: 'mission-status', key: 'consent' }, () => ({ value: { value: 'yes', version: 1 } }))
  const w = await metricsStart($, on, { store: { [CONSENT_KEY]: 'no', [NOTICE_KEY]: true } })
  await work($, 6)
  w.clock.advance(FLUSH_MS + 1)
  await work($, 1)
  w.clock.advance(FLUSH_MS + 1)
  expect(w.bodies.length).toBe(0)
  expect(w.store.get(ID_KEY)).toBeUndefined()
})

test('metrics: the command and the timer exist even when the session start fails', async ($, on) => {
  on('state.get', { key: 'metricsSession' }, () => {
    throw new Error('state down')
  })
  const w = await metricsStart($, on, { store: consented })
  expect(w.commands).toContain('pane-metrics')
})

test('metrics: /pane-metrics off turns the session off even if the store write fails', async ($, on) => {
  const w = await metricsStart($, on, { store: consented, deny: CONSENT_KEY })
  await $.command.run({ command: 'pane-metrics', args: 'off' } as never).catch(() => undefined)
  expect(w.state.filter(x => x.key === 'consent').at(-1)?.value).toBe('no')
})

test('F28 metrics: pane_shown is kept as sent in the stored session', async ($, on) => {
  const w = await metricsStart($, on, { store: consented })
  const PANE = { plugin: 'mission-status', component: 'Pane', requestId: 'progress', props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, surface: 'desktop' } as const
  await work($, 5)
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 0 } as never)
  const ui = await $.ui.mount(PANE as never)
  await ui.unmount()
  await work($, 1)
  const kept = w.state.filter(x => x.key === 'metricsSession').at(-1)?.value as { paneSent?: boolean } | undefined
  expect(kept?.paneSent).toBe(true)
})

test('F20 doc: a ~ path is read as the expanded path', async ($, on) => {
  expect(expand('~/.claude/plans/a.md', '/Users/me')).toBe('/Users/me/.claude/plans/a.md')
  expect(expand('/tmp/a.md', '/Users/me')).toBe('/tmp/a.md')
  base(on)
  const reads: string[] = []
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => (reads.push(e.path), { value: '# Plan' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 0, links: [{ phase: 0, label: 'Plan', href: '~/.claude/plans/a.md' }], items: [{ phase: 0, name: 'a', status: 'now' }] } as never)
  const ui = await $.ui.mount({ plugin: 'mission-status', component: 'Pane', requestId: 'mission-status-doc', props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, surface: 'desktop' } as never)
  await ui.unmount()
  for (const r of reads) expect(r.startsWith('~')).toBe(false)
})
