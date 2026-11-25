import { expect, test } from 'claude-code/testing'
import { CAP_BYTES, asTemplates, prRefsInTranscript, skillSteps, templatesLine } from '../hooks/model'

// About 4 characters per token.
const tokensOf = (value: unknown): number => Math.ceil((JSON.stringify(value) ?? '').length / 4)

// v1 scope item 1: the schema's guards on every agent update.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const start = async ($: any, on: any) => {
  watch(on)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
// The test reads the plugin's state as the engine stores it: the last value the plugin wrote under each key.
let stored: Record<string, any> = {}
const watch = (on: any) => {
  stored = {}
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    // A shaped value is stored as { shape, value }.
    const v = e.value as any
    if (e.plugin === 'mission-status') stored[e.key] = v !== null && typeof v === 'object' && 'shape' in v && 'value' in v ? v.value : v
    return next(e)
  })
}
const state = async (_: any, key: string) => stored[key]
const BASE = { project: 'P', stage: 'build', phase: 1 }

test('an update over the 32 KB cap is refused with the error text, and the last good view stays', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, goalLine: 'The first goal.' })
  const r = await send($, { ...BASE, goalLine: 'x'.repeat(CAP_BYTES + 10) })
  expect(r.deny).toMatch(/kept the last good view/)
  expect(r.deny).toMatch(/the cap is 32 KB/)
  expect((await state($, 'summary')).goalLine).toBe('The first goal.')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /The first goal\./ })).toBeTruthy()
  await ui.unmount()
})

test('an invalid state writes nothing and returns every error to the agent', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [{ phase: 1, name: 'keep me', status: 'now' }] })
  const r = await send($, { ...BASE, project: 'Q', stage: 'nope', items: [{ phase: 1, name: 'bad', status: 'sleeping' }] })
  expect(r.deny).toMatch(/stage must be one of/)
  expect(r.deny).toMatch(/items\[0\]: status must be one of done, now, next, failed/)
  const s = await state($, 'summary')
  expect(s.project).toBe('P')
  expect(s.items.map((x: any) => x.name)).toEqual(['Keep me'])
})

test('the first state needs project and phase', async ($, on) => {
  await start($, on)
  const r = await send($, { stage: 'build' })
  expect(r.deny).toMatch(/the first state needs project/)
  expect(r.deny).toMatch(/the first state needs phase/)
  expect(await state($, 'summary')).toBeUndefined()
})

test('every write carries a version; an older agent version never replaces a newer one', async ($, on) => {
  await start($, on)
  const one = await send($, { ...BASE, version: 1, goalLine: 'one' })
  expect(one.result).toMatch(/version 1/)
  await send($, { ...BASE, version: 3, goalLine: 'three' })
  expect((await state($, 'summary')).version).toBe(2)
  const late = await send($, { ...BASE, version: 2, goalLine: 'two' })
  expect(late.deny).toMatch(/version 2 is older than the stored version 3/)
  expect((await state($, 'summary')).goalLine).toBe('three')
  await send($, { ...BASE, goalLine: 'no version' })
  expect((await state($, 'summary')).version).toBe(3)
})

test('items carry stable ids; patches add, change and remove one item', async ($, on) => {
  await start($, on)
  await send($, {
    ...BASE,
    items: [
      { phase: 1, name: 'Draw the ring', status: 'now' },
      { id: 'cols', phase: 1, name: 'Draw the columns', status: 'next' },
    ],
  })
  expect((await state($, 'summary')).items.map((x: any) => x.id)).toEqual(['draw-the-ring', 'cols'])
  const r = await send($, {
    patch: [
      { op: 'change', id: 'draw-the-ring', status: 'done' },
      { op: 'add', id: 'tests', phase: 1, name: 'Write the tests', status: 'now' },
      { op: 'remove', id: 'cols' },
    ],
  })
  expect(r.deny).toBeUndefined()
  const items = (await state($, 'summary')).items
  expect(items.map((x: any) => `${x.id}:${x.status}`)).toEqual(['draw-the-ring:done', 'tests:now'])
  expect(items[0].name).toBe('Draw the ring')
})

test('a patch on an unknown id, or items with patch, is refused', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [{ phase: 1, name: 'one', status: 'now' }] })
  expect((await send($, { patch: [{ op: 'change', id: 'two', status: 'done' }] })).deny).toMatch(/no item has id two/)
  expect((await send($, { patch: [{ op: 'add', phase: 1, name: 'One', status: 'now' }] })).deny).toMatch(/id one exists; use change/)
  expect((await send($, { items: [], patch: [] })).deny).toMatch(/not both/)
  expect((await state($, 'summary')).items.length).toBe(1)
})

test('task-list steps belong to the pane: a full agent state never deletes them, and an agent item may not take their ids', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Read the plan', status: 'in_progress' }] } as never)
  await send($, { ...BASE, items: [{ phase: 1, name: 'agent item', status: 'now' }] })
  await send($, { ...BASE, items: [] })
  expect((await state($, 'tasks')).map((x: any) => x.name)).toEqual(['Read the plan'])
  const r = await send($, { ...BASE, items: [{ id: 'task:read-the-plan', phase: 1, name: 'Read the plan', status: 'done' }] })
  expect(r.deny).toMatch(/belongs to the pane's task list/)
  expect((await send($, { patch: [{ op: 'remove', id: 'task:read-the-plan' }] })).deny).toMatch(/belongs to the pane's task list/)
})

test('an agent update for a 30-item state stays at or under 2,000 tokens (characters / 4)', async ($, on) => {
  await start($, on)
  const update = {
    project: 'Checkout redesign',
    stage: 'build',
    template: 'feature',
    phase: 1,
    version: 4,
    goalLine: 'The pane shows the live counts beside the chat. The chat shows only the items that need you.',
    counts: [
      { phase: 0, when: 'you approve the plan', text: 'Met' },
      { phase: 1, label: 'Tests', when: 'all pane tests pass', n: 18, m: 30 },
      { phase: 2, when: 'you approve the look' },
      { phase: 3, when: 'the pull request merges' },
      { phase: 4, when: 'the lessons are filed' },
    ],
    items: Array.from({ length: 30 }, (_, k) => ({
      id: `i${k + 1}`,
      phase: k < 10 ? 0 : 1,
      name: `Build part ${k + 1}`,
      status: k < 18 ? 'done' : k < 21 ? 'now' : 'next',
      ...(k % 3 === 0 ? { note: 'schema and triggers' } : {}),
      ...(k > 21 ? { after: `Build part ${k}` } : {}),
    })),
  }
  const tokens = tokensOf(update)
  expect(tokens).toBeLessThanOrEqual(2000)
  // The update the test measures is one the pane accepts.
  expect((await send($, update)).deny).toBeUndefined()
  expect((await state($, 'summary')).items.length).toBe(30)
})

test('a patch that would grow the stored state past 32 KB is refused, and the state stays as it was', async ($, on) => {
  await start($, on)
  const many = (from: number) =>
    Array.from({ length: 60 }, (_, k) => ({ id: `n${from + k}`, phase: 1, name: `Item ${from + k}`, status: 'next', note: 'y'.repeat(200) }))
  expect((await send($, { ...BASE, items: many(0) })).deny).toBeUndefined()
  const r = await send($, { patch: many(100).map(x => ({ op: 'add', ...x })) })
  expect(r.deny).toMatch(/the state would pass the 32 KB cap/)
  expect((await state($, 'summary')).items.length).toBe(60)
})

test('an item a patch sets in progress gets its start time, and keeps it while it stays in progress', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [{ id: 'a', phase: 1, name: 'One', status: 'next' }] })
  expect((await state($, 'summary')).items[0].since).toBeNull()
  await send($, { patch: [{ op: 'change', id: 'a', status: 'now' }] })
  const since = (await state($, 'summary')).items[0].since
  expect(typeof since).toBe('number')
  await send($, { patch: [{ op: 'change', id: 'a', note: 'still going' }] })
  expect((await state($, 'summary')).items[0].since).toBe(since)
})

test('personal templates: saveTemplate keeps the stages for later sessions, and template uses them', async ($, on) => {
  const kept = new Map<string, unknown>()
  on('store.get', (_: unknown, e: { key: string }) => ({ value: kept.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (kept.set(e.key, e.value), { value: undefined }))
  await start($, on)
  const saved = await send($, { project: 'P', phases: ['Spec', 'Build', 'Ship'], phase: 0, saveTemplate: 'my-flow' })
  expect(String(saved.result)).toContain('Saved the stages as template my-flow')
  expect(kept.get('templates')).toEqual({ 'my-flow': ['Spec', 'Build', 'Ship'] })
  expect((await send($, { phases: ['A', 'B'] })).deny).toBeUndefined()
  expect((await send($, { template: 'my-flow' })).deny).toBeUndefined()
  expect((await state($, 'summary')).phases).toEqual(['Spec', 'Build', 'Ship'])
  expect(String((await send($, { saveTemplate: 'feature' })).deny)).toContain('built-in template')
  expect(String((await send($, { template: 'nope' })).deny)).toContain('my-flow')
  // The standing rule names the person's templates.
  expect(templatesLine(asTemplates(kept.get('templates')))).toContain('my-flow (Spec, Build, Ship)')
})

test('plan-review template: the built-in template sets the five plan-review stages', async ($, on) => {
  await start($, on)
  expect((await send($, { project: 'P', template: 'plan-review', phase: 2 })).deny).toBeUndefined()
  expect((await state($, 'summary')).phases).toEqual(['Intake', 'Draft', 'Review waves', 'Your rows', 'Hand off'])
})

test('smriti templates: smriti-light and smriti-deep set the stages of each pass', async ($, on) => {
  await start($, on)
  expect((await send($, { project: 'P', template: 'smriti-light', phase: 0 })).deny).toBeUndefined()
  expect((await state($, 'summary')).phases).toEqual(['Discover', 'Judge', 'Curate', 'Guardrail', 'Route'])
  expect((await send($, { template: 'smriti-deep', phase: 2 })).deny).toBeUndefined()
  expect((await state($, 'summary')).phases).toEqual(['Size', 'Origin', 'Lenses', 'Curate', 'Screen', 'File', 'Yield'])
})

test('sub-phases: an item keeps its steps and the step that runs now; change moves the step; a long list is refused', async ($, on) => {
  await start($, on)
  const deep = ['Size', 'Origin', 'Lenses', 'Curate', 'Screen', 'File', 'Yield']
  expect((await send($, { project: 'P', phases: ['Build', 'Wrap up'], phase: 1, patch: [{ op: 'add', id: 'smriti', phase: 1, name: 'Smriti deep', status: 'now', steps: deep, step: 2 }] })).deny).toBeUndefined()
  let item = (await state($, 'summary')).items.find((x: { id?: string }) => x.id === 'smriti')
  expect(item.steps).toEqual(deep)
  expect(item.step).toBe(2)
  expect((await send($, { patch: [{ op: 'change', id: 'smriti', step: 3 }] })).deny).toBeUndefined()
  item = (await state($, 'summary')).items.find((x: { id?: string }) => x.id === 'smriti')
  expect(item.steps).toEqual(deep)
  expect(item.step).toBe(3)
  expect(String((await send($, { patch: [{ op: 'change', id: 'smriti', steps: [...deep, 'A', 'B'] }] })).deny)).toContain('at most 8')
})

test('repo: the Merge card reads git in the repository the agent names', async ($, on) => {
  const dirs: (string | undefined)[] = []
  watch(on)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', (_: unknown, e: { argv: string[]; init?: { cwd?: string } }) => {
    if (e.argv[0] === 'git') dirs.push(e.init?.cwd)
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(String((await send($, { project: 'P', phase: 0, repo: 'relative/path' })).deny)).toContain('absolute')
  expect((await send($, { project: 'P', phase: 0, repo: '/work/other-repo' })).deny).toBeUndefined()
  expect((await state($, 'summary')).repo).toBe('/work/other-repo')
  // The update polls at once: its git reads run in the named folder.
  await new Promise(r => setTimeout(r, 50))
  expect(dirs.at(-1)).toBe('/work/other-repo')
})

test('a skill gives its numbered steps: the bold lead names a step, else its first words', () => {
  const md = '# x\n\nIntro 1. not a step\n\n## Steps\n\n1. **Gather.** Read the context.\n2. Read the rules and the shape\n3. **Draw the hero.** Pick a layout.\n\n## Other\n\n1. Not this one\n'
  expect(skillSteps(md)).toEqual(['Gather', 'Read the rules and the shape', 'Draw the hero'])
  expect(skillSteps('1. One\n2. Two\n')).toEqual(['One', 'Two'])
})

test('a transcript gives every pull request its gh pr create calls made, and no other', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_A1","name":"Bash","input":{"command":"git push && gh pr create --title x"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A1","content":"https://github.com/acme/app/pull/9\\n"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_B2","name":"Bash","input":{"command":"gh pr view 3"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_B2","content":"https://github.com/acme/app/pull/3"}]}}',
  ].join('\n')
  expect(prRefsInTranscript(lines)).toEqual(['acme/app#9'])
})

test('an item named as its own stage is refused', async ($, on) => {
  await start($, on)
  const res = await send($, { project: 'P', phases: ['Plan', 'Wrap up'], phase: 1, items: [{ phase: 1, name: 'Wrap up', status: 'now' }] })
  expect(String(res.deny)).toContain("has its stage's own name")
  expect((await send($, { project: 'P', phases: ['Plan', 'Wrap up'], phase: 1, items: [{ phase: 1, name: 'Smriti deep', status: 'now' }] })).deny).toBeUndefined()
  expect(String((await send($, { patch: [{ op: 'add', id: 'w', phase: 1, name: 'wrap up', status: 'now' }] })).deny)).toContain("has its stage's own name")
})
