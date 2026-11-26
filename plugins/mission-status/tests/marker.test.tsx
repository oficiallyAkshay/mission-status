import { expect, mock, test } from 'claude-code/testing'
import { CONFIRM_MS, QUIET_MS, resetMarker } from '../hooks/marker'

// The marker: Haiku marks open items from the newest tool calls; two checks in a row must agree.

const UPDATE = 'mcp__mission-status__update'
const USAGE = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SECRET = 'SECRET-FILE-TEXT-42'

type World = {
  env?: Record<string, string>
  holdback?: boolean
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
  if (w.holdback === true)
    on('state.get', async (_: unknown, e: { plugin: string; key: string }, next: (e: unknown) => unknown) =>
      e.plugin === 'mission-status' && e.key === 'holdback' ? { value: { value: true, version: 1 } } : next(e),
    )
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

test('no call in a holdback session', async ($, on) => {
  const w = await boot($, on, { holdback: true, replies: [DONE] })
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
