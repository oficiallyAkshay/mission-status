import { expect, mock, test } from 'claude-code/testing'
import { INFER_MS, MAX_FAILS, JEV_URL, SURE, buildRequest, readAnswer, toolLines, withInferred } from '../hooks/infer'
import type { Item } from '../types'

// The state marker (infer.ts): Jev marks items and places new ones; the agent's own update wins.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const use = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: unknown, isError = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })

const TRANSCRIPT = [
  use('t1', 'Write', { file_path: '/repo/hooks/infer.ts', content: 'SECRET FILE BODY' }),
  result('t1', 'File created'),
  use('t2', 'Bash', { command: 'claude plugin test .', description: 'Run the plugin tests' }),
  result('t2', 'running...\nSECRET OUTPUT LINE\n12 of 12 tests pass'),
  use('t3', 'Read', { file_path: '/repo/README.md' }),
  result('t3', [{ type: 'text', text: 'SECRET README TEXT' }]),
  use('t4', 'Bash', { command: 'false' }),
  result('t4', 'boom', true),
  use('t5', 'mcp__mission-status__update', { project: 'P' }),
].join('\n') + '\n'

type World = { bodies: any[]; answer: { status: number; text: string }; key: string | undefined; clock: any; transcript: string }
let world: World
const start = async ($: any, on: any, key: string | null = 'k-test'): Promise<World> => {
  const w: World = { bodies: [], answer: { status: 200, text: '{}' }, key: key ?? undefined, clock: null, transcript: TRANSCRIPT }
  world = w
  w.clock = mock.clock(on, { now: 1_000_000 })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('env.get', (_: unknown, e: { name: string }, next: any) => (e.name === 'JEV_API_KEY' ? { value: w.key } : next(e)))
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: w.transcript.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_: unknown, e: { offset?: number; length?: number }) => {
    const at = e.offset ?? 0
    return { value: w.transcript.slice(at, at + (e.length ?? w.transcript.length)) }
  })
  on('http.fetch', (_: unknown, e: { url: string; init?: { body?: string; headers?: Record<string, string> } }) => {
    if (e.url !== JEV_URL) return { value: { status: 404, ok: false, headers: {}, text: '' } }
    w.bodies.push({ ...JSON.parse(e.init?.body ?? '{}'), key: e.init?.headers?.authorization })
    return { value: { status: w.answer.status, ok: w.answer.status < 300, headers: {}, text: w.answer.text } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return w
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
// A main-loop tool call: the engine writes it to the transcript, where the marker reads it.
let n = 0
const bash = async ($: any) => {
  n++
  world.transcript += use(`b${n}`, 'Bash', { command: 'ls' }) + '\n' + result(`b${n}`, 'a.txt') + '\n'
  return $.tool.call({ tool: 'Bash', command: 'ls' } as never)
}
const choice = (c: string, p: number) => ({ type: 'choice', choice: c, confidence: p, probabilities: { [c]: p } })
const answer = (answers: Record<string, unknown>) => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 321, output_tokens: 0 } })
const tick = async (w: World) => {
  await w.clock.advance(INFER_MS + 1)
  await new Promise(r => setTimeout(r, 20))
}
const BASE = { project: 'P', stage: 'build', phase: 1 }
const ITEMS = [
  { id: 'tests', phase: 1, name: 'Write the tests', status: 'now' },
  { id: 'docs', phase: 1, name: 'Update the docs', status: 'next' },
]
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text ?? ''))

test('tool lines carry the tool, its target and its end, and no file contents', () => {
  expect(toolLines(TRANSCRIPT)).toEqual(['Write: infer.ts -> ok', 'Bash: Run the plugin tests -> 12 of 12 tests pass', 'Read: README.md -> ok', 'Bash: false -> error'])
})

test('an answer below the sure level, an unknown option or bad JSON changes nothing', () => {
  const items = [{ key: 'a', name: 'A', phase: 1, status: 'now' as const, parent: null }]
  const plan = buildRequest(items, ['Bash: x'], [])!
  expect(readAnswer('not json', plan)).toBeNull()
  expect(readAnswer('{"error":{}}', plan)).toBeNull()
  expect(readAnswer(answer({ s0: choice('done', SURE - 0.01) }), plan)?.marks).toEqual({})
  expect(readAnswer(answer({ s0: choice('finished', 0.99) }), plan)?.marks).toEqual({})
  expect(readAnswer(answer({ s0: choice('done', 0.97) }), plan)?.marks).toEqual({ a: 'done' })
  expect(readAnswer(answer({ s0: choice('done', 0.97) }), plan)?.tokens).toBe(321)
})

test('a placed parent that would make a loop is dropped', () => {
  const items: Item[] = [
    { id: 'a', phase: 1, name: 'A', status: 'now', after: null, parent: 'B', when: null },
    { id: 'b', phase: 1, name: 'B', status: 'now', after: null, parent: null, when: null },
  ]
  const out = withInferred(items, { marks: {}, parents: { b: 'A' }, seen: [], calls: 0, tokens: 0, fails: 0, off: false })
  expect(out.map(x => x.parent)).toEqual(['B', null])
})

test('a loop through an agent parent given by id is dropped too', () => {
  const items: Item[] = [
    { id: 'a', phase: 1, name: 'A', status: 'now', after: null, parent: 'b', when: null },
    { id: 'b', phase: 1, name: 'B', status: 'now', after: null, parent: null, when: null },
  ]
  const out = withInferred(items, { marks: {}, parents: { b: 'A' }, seen: [], calls: 0, tokens: 0, fails: 0, off: false })
  expect(out.map(x => x.parent)).toEqual(['b', null])
})

test('off with no JEV_API_KEY: nothing goes to Jev', async ($, on) => {
  const w = await start($, on, null)
  await send($, { ...BASE, items: ITEMS })
  for (let k = 0; k < 3; k++) await bash($)
  await tick(w)
  await tick(w)
  expect(w.bodies.length).toBe(0)
})

test('with the key: a sure answer marks the item as inferred, and the agent update clears the mark', async ($, on) => {
  const w = await start($, on)
  await send($, { ...BASE, items: ITEMS })
  await bash($)
  w.answer = { status: 200, text: answer({ s0: choice('done', 0.96), s1: choice('next', 0.95) }) }
  await tick(w)
  expect(w.bodies.length).toBe(1)
  const body = w.bodies[0]
  expect(body.model).toBe('jev-1.13.0')
  expect(body.key).toBe('Bearer k-test')
  const sent = JSON.stringify(body.state)
  expect(sent).not.toContain('SECRET FILE BODY')
  expect(sent).not.toContain('SECRET OUTPUT LINE')
  expect(sent).not.toContain('SECRET README TEXT')
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await texts(ui)).some((t: string) => t.includes('inferred'))).toBe(true)
  await ui.unmount()
  // No new tool call: no new request.
  await tick(w)
  expect(w.bodies.length).toBe(1)
  // The agent's update wins.
  await send($, { patch: [{ op: 'change', id: 'tests', status: 'now' }] })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await texts(ui)).some((t: string) => t.includes('inferred'))).toBe(false)
  await ui.unmount()
})

test('a new item with no parent is placed once and keeps its parent; an agent parent wins', async ($, on) => {
  const w = await start($, on)
  await send($, { ...BASE, items: ITEMS })
  await bash($)
  w.answer = { status: 200, text: answer({}) }
  await tick(w)
  await send($, { patch: [{ op: 'add', id: 'lint', phase: 1, name: 'Fix the lint', status: 'now' }] })
  await bash($)
  w.answer = { status: 200, text: answer({ p0: choice('o0', 0.95) }) }
  await tick(w)
  const asked = w.bodies.at(-1)
  expect(Object.keys(asked.questions)).toContain('p0')
  expect(asked.questions.p0.criteria.o0).toContain('Write the tests')
  // Asked once: the next request has no place question.
  await bash($)
  w.answer = { status: 200, text: answer({}) }
  await tick(w)
  expect(Object.keys(w.bodies.at(-1).questions).some(k => k.startsWith('p'))).toBe(false)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Nested: the parent card has an open button.
  expect((await ui.findAll({ type: 'Button' })).some((b: any) => b.props?.label === '+' || b.props?.label === '−')).toBe(true)
  await ui.unmount()
  // The agent's own parent wins.
  await send($, { patch: [{ op: 'change', id: 'lint', parent: 'Update the docs' }] })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).some((b: any) => b.props?.label === '+' || b.props?.label === '−')).toBe(true)
  await ui.unmount()
})

test(`${MAX_FAILS} refusals in a row stop the marker for the session`, async ($, on) => {
  const w = await start($, on)
  await send($, { ...BASE, items: ITEMS })
  w.answer = { status: 403, text: '{"error":{"code":"invalid_api_key_error"}}' }
  for (let k = 0; k < MAX_FAILS + 2; k++) {
    await bash($)
    await tick(w)
  }
  expect(w.bodies.length).toBe(MAX_FAILS)
})

test('one request at most every 30 s, however many tool calls come between', async ($, on) => {
  const w = await start($, on)
  await send($, { ...BASE, items: ITEMS })
  w.answer = { status: 200, text: answer({}) }
  await bash($)
  await tick(w)
  for (let k = 0; k < 5; k++) await bash($)
  await w.clock.advance(10_000)
  await new Promise(r => setTimeout(r, 20))
  expect(w.bodies.length).toBe(1)
  await tick(w)
  expect(w.bodies.length).toBe(2)
})

test('no caps: every tool call in the tail and every open item goes, with whole lines', () => {
  const long = 'x'.repeat(500)
  const many = Array.from({ length: 60 }, (_, k) => use(`m${k}`, 'Bash', { command: `${long} ${k}` }) + '\n' + result(`m${k}`, 'ok')).join('\n')
  const lines = toolLines(many)
  expect(lines.length).toBe(60)
  expect(lines[0]?.length).toBeGreaterThan(500)
  const items = Array.from({ length: 30 }, (_, k) => ({ key: `i${k}`, name: `Item ${k}`, phase: 1, status: 'now' as const, parent: null }))
  const plan = buildRequest(items, lines, [])!
  expect(plan.ask.length).toBe(30)
  expect(JSON.parse(plan.body).state.items.length).toBe(30)
})
