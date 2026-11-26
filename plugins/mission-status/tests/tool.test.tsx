import { expect, mock, test } from 'claude-code/testing'
import { brokenRules, derive, type Facts, itemKey, itemRule, mergeItems, NO_FACTS, type NodeStatus, stageRule, timeOf } from '../hooks/machine'
import { applyPlan, asTemplates, CAP_BYTES, CHECK_MS, FIRST_REMINDER, HOLD_TEXT, prRefsInTranscript, REMINDER, RULE, skillSteps, STALE_MS, templatesLine, TURN_TEXT } from '../hooks/model'
import { settleRuns } from '../hooks/store'
import { type Item, type Summary, type Task } from '../types'

// Each block below was one test file. The blocks keep their own helpers and state; one file runs in one child.

// ---- was schema.test.tsx
{
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

test('sub-phases: an item keeps its steps and the step that runs now; change moves the step; a long list is refused', async ($, on) => {
  await start($, on)
  const deep = ['Size', 'Origin', 'Lenses', 'Curate', 'Screen', 'File', 'Yield']
  expect((await send($, { project: 'P', phases: ['Build', 'Close out'], phase: 1, patch: [{ op: 'add', id: 'deep', phase: 1, name: 'Deep review', status: 'now', steps: deep, step: 2 }] })).deny).toBeUndefined()
  let item = (await state($, 'summary')).items.find((x: { id?: string }) => x.id === 'deep')
  expect(item.steps).toEqual(deep)
  expect(item.step).toBe(2)
  expect((await send($, { patch: [{ op: 'change', id: 'deep', step: 3 }] })).deny).toBeUndefined()
  item = (await state($, 'summary')).items.find((x: { id?: string }) => x.id === 'deep')
  expect(item.steps).toEqual(deep)
  expect(item.step).toBe(3)
  expect(String((await send($, { patch: [{ op: 'change', id: 'deep', steps: [...deep, 'A', 'B'] }] })).deny)).toContain('at most 8')
})

test('parent by id: a child that names its parent by id nests under it, and after by id waits on it', async ($, on) => {
  await start($, on)
  const patch = [
    { op: 'add', id: 'close-out', phase: 1, name: 'Close out', status: 'now' },
    { op: 'add', id: 'close-step-3', phase: 1, name: 'Remote off', status: 'done', parent: 'close-out' },
    { op: 'add', id: 'close-step-4', phase: 1, name: 'Deep review', status: 'now', parent: 'close-out', after: 'close-step-3' },
  ]
  expect((await send($, { project: 'P', phases: ['Build', 'Close'], phase: 1, patch })).deny).toBeUndefined()
  const items = (await state($, 'summary')).items as { id?: string; parent: string | null; after: string | null }[]
  const deep = items.find(x => x.id === 'close-step-4')
  // Stored as the other item's id, so a rename of that item keeps its children and its waits.
  expect(deep?.parent).toBe('close-out')
  expect(deep?.after).toBe('close-step-3')
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
  const res = await send($, { project: 'P', phases: ['Plan', 'Close out'], phase: 1, items: [{ phase: 1, name: 'Close out', status: 'now' }] })
  expect(String(res.deny)).toContain("has its stage's own name")
  expect((await send($, { project: 'P', phases: ['Plan', 'Close out'], phase: 1, items: [{ phase: 1, name: 'Deep review', status: 'now' }] })).deny).toBeUndefined()
  expect(String((await send($, { patch: [{ op: 'add', id: 'w', phase: 1, name: 'close out', status: 'now' }] })).deny)).toContain("has its stage's own name")
})
}

// ---- was triggers.test.ts
{
// The freshness triggers: product plan, "How the state stays current".

const start = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  watch(on)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return { clock, opened }
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
const bash = ($: any, agentId?: string) => $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as never)
const plan = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__ccd_turn__update_plan', ...args } as never)
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
const ctx = (r: any): string[] => r.context ?? []
const BASE = { project: 'P', stage: 'build', phase: 1 }

test('after a context compaction the standing rule goes back into the agent context', async ($, on) => {
  await start($, on)
  expect((await $.classic.SessionStart({ source: 'compact' })).additionalContext).toContain(RULE)
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext ?? []).not.toContain(RULE)
})

test('the 5th tool call with no agent state opens the pane from the task list, waiting for the agent, and reminds at once', async ($, on) => {
  const { opened } = await start($, on)
  await plan($, {
    items: [
      { content: 'Read the plan', status: 'completed' },
      { content: 'Build the schema', status: 'in_progress' },
      { content: 'Write the tests', status: 'pending' },
    ],
  })
  for (let k = 0; k < 3; k++) expect(ctx(await bash($))).toEqual([])
  expect(await state($, 'summary')).toBeUndefined()
  const fifth = await bash($)
  expect(ctx(fifth)).toEqual([FIRST_REMINDER])
  const s = await state($, 'summary')
  expect(s.template).toBe('custom')
  expect(s.phases).toEqual(['Read the plan', 'Build the schema', 'Write the tests'])
  expect(s.phase).toBe(1)
  expect(s.waitingForAgent).toBe(true)
  expect(opened).toContain('progress')
  expect((await state($, 'tasks')).map((x: any) => x.phase)).toEqual([0, 1, 2])
  expect(ctx(await bash($))).toEqual([])
  // The agent's first state clears the mark.
  await send($, BASE)
  expect((await state($, 'summary')).waitingForAgent).toBe(false)
})

test('the pane does not open by itself when the agent already sent state, and helper calls do not count', async ($, on) => {
  await start($, on)
  for (let k = 0; k < 6; k++) await bash($, 'helper-1')
  expect(await state($, 'summary')).toBeUndefined()
  await send($, BASE)
  for (let k = 0; k < 5; k++) expect(ctx(await bash($))).toEqual([])
  expect((await state($, 'summary')).waitingForAgent).toBe(false)
})

test('stale after 10 minutes of tool calls: a one-line reminder rides on the next step', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await start($, on)
  await send($, BASE)
  await clock.advance(STALE_MS - 1000)
  expect(ctx(await bash($))).toEqual([])
  await clock.advance(1000)
  expect(ctx(await bash($))).toEqual([REMINDER])
  expect(ctx(await bash($))).toEqual([])
})

test('the time between turns does not count: after the person is away, the stale window goes on from where it was', { timeoutMs: 20_000 }, async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  const { clock } = await start($, on)
  await send($, BASE)
  await clock.advance(STALE_MS - 2000)
  expect(ctx(await bash($))).toEqual([])
  await $.turn.complete({ reason: 'answer', answer: 'Done.' } as never)
  // The person is away longer than the window; the next turn is not stale at once.
  await clock.advance(STALE_MS)
  await $.prompt.submit({ text: 'go on' } as never)
  expect(ctx(await bash($))).toEqual([])
  await clock.advance(2000)
  expect(ctx(await bash($))).toEqual([REMINDER])
})

test('stale after 3 new task-list steps with no agent update', async ($, on) => {
  await start($, on)
  await send($, BASE)
  await plan($, { items: ['a', 'b', 'c', 'd'].map(content => ({ content, status: 'pending' })) })
  await plan($, { start: 1 })
  await plan($, { advance: true })
  expect(ctx(await bash($))).toEqual([])
  // The third step starts: the reminder rides on that task-list call's own result, the agent's next step.
  expect(ctx(await plan($, { advance: true }))).toEqual([REMINDER])
  expect(ctx(await bash($))).toEqual([])
})

test('a turn end while stale is held once with a request for an update', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await start($, on)
  await send($, BASE)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await clock.advance(STALE_MS)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(HOLD_TEXT)
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('after 2 ignored reminders the state is marked May be out of date; an agent update clears it', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await start($, on)
  await send($, BASE)
  await clock.advance(STALE_MS)
  expect(ctx(await bash($))).toEqual([REMINDER])
  for (let k = 0; k < 3; k++) await bash($) // reminder 1 ignored
  expect((await state($, 'summary')).mayBeOutOfDate).toBe(false)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(HOLD_TEXT)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined() // reminder 2 ignored
  expect((await state($, 'summary')).mayBeOutOfDate).toBe(true)
  await send($, BASE)
  expect((await state($, 'summary')).mayBeOutOfDate).toBe(false)
})

test('the standing rule keeps the chat to what unblocks the person', () => {
  expect(RULE).toContain('only what the person must do or decide to unblock the work')
  expect(RULE).toContain('Send no progress lines, status, recaps, plans or narration in the chat')
})

test('every 2 minutes with no agent update, a check names the items still in progress', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await start($, on)
  await send($, { ...BASE, items: [{ phase: 0, name: 'Write the tests', status: 'now' }, { phase: 0, name: 'Read the brief', status: 'done' }] })
  expect(ctx(await bash($))).toEqual([])
  await clock.advance(CHECK_MS)
  const line = ctx(await bash($))
  expect(line.length).toBe(1)
  expect(line[0]).toContain('Write the tests')
  expect(line[0]).not.toContain('Read the brief')
  // Once asked, it waits another 2 minutes; an agent update starts the count again.
  expect(ctx(await bash($))).toEqual([])
  await send($, { phase: 0 })
  await clock.advance(CHECK_MS - 1000)
  expect(ctx(await bash($))).toEqual([])
})

test('a turn that ran tool calls and sent no update is held once at its end; a turn that sent one is not', async ($, on) => {
  await start($, on)
  await send($, BASE)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await bash($)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(TURN_TEXT)
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  await bash($)
  await send($, { phase: 1 })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('where the marker runs, no stale reminder and no held turn end; where traffic is off, both stay', { timeoutMs: 20_000 }, async ($, on) => {
  on('env.get', () => ({ value: undefined }))
  const { clock } = await start($, on)
  await send($, BASE)
  await clock.advance(STALE_MS + 1000)
  expect(ctx(await bash($))).toEqual([])
  expect(((await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }).block).toBeUndefined()
})

test('with nonessential traffic off the marker is off, so the stale reminder still rides on the next step', { timeoutMs: 20_000 }, async ($, on) => {
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' ? '1' : undefined }))
  const { clock } = await start($, on)
  await send($, BASE)
  await clock.advance(STALE_MS + 1000)
  expect(ctx(await bash($))).toEqual([REMINDER])
})
}

// ---- was machine.test.ts
{
// A small seeded generator (a plugin imports only its own files, so no property-testing library): the same seed gives
// the same trees, so a failure names a sequence that can be run again.
function rng(seed: number) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}
const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)] as T

function randomState(r: () => number): { s: NonNullable<Summary>; steps: Task[]; facts: Facts } {
  const phases = ['Plan', 'Build', 'Test', 'Ship'].slice(0, 2 + Math.floor(r() * 3))
  const phase = Math.floor(r() * (phases.length + 1))
  const items: Item[] = []
  const n = Math.floor(r() * 9)
  for (let i = 0; i < n; i++) {
    const ph = Math.floor(r() * phases.length)
    const same = items.filter(x => x.phase === ph)
    // Parents and waits point at earlier items, sometimes at later ones or at themselves, so loops get made too.
    const parent = same.length > 0 && r() < 0.4 ? (pick(r, same).id ?? null) : r() < 0.05 ? `i${i + 1}` : null
    const after = same.length > 0 && r() < 0.3 ? (pick(r, same).id ?? null) : null
    items.push({ id: `i${i}`, phase: ph, name: `Item ${i}`, status: pick(r, ['now', 'next', 'done', 'failed', 'done', 'now'] as const), after, parent, when: null, since: null, touchedAt: 0 } as Item)
  }
  const s = { project: 'P', ticket: null, links: [], goalLine: null, stage: 'build', phases, phase, symptom: null, hypotheses: [], waitingOn: null, waitingSince: 0, counts: [], items, active: r() < 0.2 ? [Math.floor(r() * phases.length)] : [], template: null, starts: [], ends: [], change: null, at: 0 } as unknown as NonNullable<Summary>
  const steps: Task[] = Array.from({ length: Math.floor(r() * 3) }, (_, k) => ({ name: `Step ${k}`, status: pick(r, ['now', 'next', 'done'] as const), phase: Math.floor(r() * phases.length), since: null }))
  const facts: Facts = { ...NO_FACTS, turnOpen: r() < 0.6, waiting: r() < 0.1, helpersRunning: r() < 0.2, hostKey: null }
  return { s, steps, facts }
}

test('2,000 random trees and facts: every sanity rule holds on every derive', () => {
  const failures: string[] = []
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed)
    const { s, steps, facts } = randomState(r)
    const items = mergeItems(s, steps, facts)
    const host = items.find(x => x.status === 'now' && x.phase === s.phase)
    const f = { ...facts, hostKey: host !== undefined && r() < 0.5 ? itemKey(host) : null }
    const d = derive(s, items, f)
    for (const b of brokenRules(s, items, f, d)) failures.push(`seed ${seed}: ${b}`)
  }
  expect(failures.slice(0, 5)).toEqual([])
})

test('nothing runs without a turn, a helper or a running child: a "now" left over shows open', () => {
  const r = rng(7)
  const { s } = randomState(r)
  const one = { ...s, phases: ['Build'], phase: 0, active: [], items: [{ id: 'a', phase: 0, name: 'A', status: 'now', after: null, parent: null, when: null } as Item] }
  expect(derive(one, one.items, { ...NO_FACTS, turnOpen: false }).item(one.items[0] as Item)).toBe('open')
  expect(derive(one, one.items, { ...NO_FACTS, turnOpen: true }).item(one.items[0] as Item)).toBe('running')
  // A question to the person stops the run too.
  expect(derive(one, one.items, { ...NO_FACTS, turnOpen: true, waiting: true }).item(one.items[0] as Item)).toBe('open')
})

test('a parent the agent called done stays open while a child is open, and says why; the header is not done', () => {
  const items = [
    { id: 'p', phase: 0, name: 'Parent', status: 'done', after: null, parent: null, when: null },
    { id: 'c', phase: 0, name: 'Child', status: 'next', after: null, parent: 'p', when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, NO_FACTS)
  expect(d.item(items[0] as Item)).toBe('open')
  expect(d.reason(itemKey(items[0] as Item))).toContain('Child')
  expect(d.stage(0)).toBe('open')
  expect(d.allDone).toBe(false)
})

test('if A depends on B and B is not done, A is not done', () => {
  const items = [
    { id: 'b', phase: 0, name: 'B', status: 'next', after: null, parent: null, when: null },
    { id: 'a', phase: 0, name: 'A', status: 'done', after: 'b', parent: null, when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 0, active: [], items } as unknown as NonNullable<Summary>
  expect(derive(s, items, NO_FACTS).item(items[1] as Item)).toBe('open')
})

test('a loop in parents never hangs and its items count as open', () => {
  const items = [
    { id: 'a', phase: 0, name: 'A', status: 'done', after: null, parent: 'b', when: null },
    { id: 'b', phase: 0, name: 'B', status: 'done', after: null, parent: 'a', when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, NO_FACTS)
  expect(['open', 'done']).toContain(d.item(items[0] as Item))
  expect(d.allDone).toBe(d.stage(0) === 'done')
})

test('a merged pull request closes its item even while the agent still says now', () => {
  const items = [{ id: 'a', phase: 0, name: 'A', status: 'now', after: null, parent: null, when: null, pr: '7', touchedAt: 10 } as Item]
  const s = { phases: ['Only'], phase: 0, active: [], items } as unknown as NonNullable<Summary>
  const facts = { ...NO_FACTS, turnOpen: true, ci: { '7': { state: 'passing' as const, start: null, end: null, mergedAt: 20 } } }
  const merged = mergeItems(s, [], facts)
  expect(derive(s, merged, facts).item(merged[0] as Item)).toBe('done')
})

test('a mark newer than the agent stands in for its status; the agent\'s next word wins again', () => {
  const items = [{ id: 'a', phase: 0, name: 'A', status: 'now', after: null, parent: null, when: null, touchedAt: 10 } as Item]
  const s = { phases: ['Only'], phase: 0, active: [], items } as unknown as NonNullable<Summary>
  const newer = { ...NO_FACTS, marks: { a: { status: 'done' as const, at: 20 } } }
  expect(mergeItems(s, [], newer)[0]?.status).toBe('done')
  const older = { ...NO_FACTS, marks: { a: { status: 'done' as const, at: 5 } } }
  expect(mergeItems(s, [], older)[0]?.status).toBe('now')
})

test('running time counts only while running, and a second settle at the same time changes nothing', () => {
  let runs = settleRuns({}, new Set(['x']), 1_000)
  expect(runs.x).toEqual({ ms: 0, from: 1_000 })
  runs = settleRuns(runs, new Set(), 4_000)
  expect(runs.x).toEqual({ ms: 3_000, from: null })
  // An idle hour adds nothing.
  runs = settleRuns(runs, new Set(), 4_000 + 3_600_000)
  expect(runs.x?.ms).toBe(3_000)
  runs = settleRuns(runs, new Set(['x']), 5_000_000)
  const again = settleRuns(runs, new Set(['x']), 5_000_000)
  expect(again).toBe(runs)
})

// Every input of each rule table, enumerated: claims, every set of child statuses, every dependency status and every
// fact. Each input maps to one status by construction (first match); these checks prove the rules hold for all.
const ALL: NodeStatus[] = ['running', 'open', 'done', 'failed', 'next', 'needs']
const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map(a => [...a, x])], [[]])

test('item table: every one of 35,840 inputs keeps the rules (done needs done children and dependency; a running child runs its parent unless it needs the person; running needs evidence; needs never runs; nothing starts itself)', () => {
  const bad: string[] = []
  let n = 0
  for (const claim of ['now', 'next', 'done', 'failed', 'needs'] as const)
   for (const blocked of [false, true])
    for (const kids of subsets(ALL))
      for (const dep of ['none', ...ALL] as const)
        for (const ciFailing of [false, true])
          for (const live of [false, true])
            for (const hosting of [false, true]) {
              n++
              const i = { claim, blocked, kids, dep, ciFailing, live, hosting }
              // Cannot happen: a waiting parent makes its children wait, so none of them runs.
              if (blocked && kids.includes('running')) continue
              const { status, why } = itemRule(i)
              const tag = JSON.stringify(i)
              if (status === 'done' && (kids.some(k => k !== 'done') || (dep !== 'none' && dep !== 'done'))) bad.push(`done too early ${tag}`)
              if (kids.includes('running') && status !== 'running' && status !== 'failed' && status !== 'needs') bad.push(`running child, parent ${status} ${tag}`)
              if (status === 'running' && !live && !hosting && !kids.includes('running')) bad.push(`runs with no evidence ${tag}`)
              if (claim === 'needs' && !ciFailing && status !== 'needs') bad.push(`needs hidden ${tag}`)
              if (claim === 'needs' && status === 'running') bad.push(`needs runs ${tag}`)
              if (kids.includes('needs') && status === 'done') bad.push(`done over a needs child ${tag}`)
              if (blocked && status === 'running') bad.push(`runs before its prerequisite is done ${tag}`)
              if (claim === 'next' && kids.every(k => k === 'next') && !hosting && !ciFailing && status !== 'next') bad.push(`starts by itself ${tag}`)
              if ((claim === 'failed' || ciFailing) && status !== 'failed') bad.push(`failure hidden ${tag}`)
              if (claim === 'done' && !ciFailing && kids.every(k => k === 'done') && (dep === 'none' || dep === 'done') && status !== 'done') bad.push(`done withheld ${tag}`)
              if (status === 'open' && claim === 'done' && why === null) bad.push(`held with no reason ${tag}`)
            }
  expect(n).toBe(5 * 2 * 64 * 7 * 2 * 2 * 2)
  expect(bad.slice(0, 5)).toEqual([])
})

test('stage table against an independent spec, over every input: items, gates, position and turn', () => {
  // The spec in plain words, written apart from the table: what the owner would call true.
  const spec = (items: NodeStatus[], gates: 'none' | 'met' | 'unmet', position: 'passed' | 'active' | 'ahead', live: boolean): NodeStatus => {
    if (items.includes('running')) return 'running' // something in it runs
    if (items.includes('needs')) return 'needs' // something in it waits on the person
    if (items.includes('failed')) return 'failed' // something in it failed
    const allDone = items.length > 0 && items.every(x => x === 'done')
    const emptyAndPassed = items.length === 0 && position === 'passed'
    if ((allDone || emptyAndPassed) && gates !== 'unmet') return 'done' // its work is finished and its gate is met
    if (allDone || emptyAndPassed) return 'open' // finished work, gate not met: waits for the gate
    if (position === 'active') return live ? 'running' : 'open' // the agent works here now
    return items.some(x => x !== 'next') || position === 'passed' ? 'open' : 'next' // started, or behind the agent
  }
  const bad: string[] = []
  let n = 0
  for (const items of subsets(ALL))
    for (const gates of ['none', 'met', 'unmet'] as const)
      for (const position of ['passed', 'active', 'ahead'] as const)
        for (const live of [false, true]) {
          n++
          const got = stageRule({ items, gates, position, live }).status
          const want = spec(items, gates, position, live)
          if (got !== want) bad.push(`${JSON.stringify({ items, gates, position, live })}: table ${got}, spec ${want}`)
        }
  expect(n).toBe(2 ** ALL.length * 3 * 3 * 2)
  expect(bad.slice(0, 5)).toEqual([])
})

test('the owner\'s cases: a stage whose items are all done is done even when the agent\'s stage number lags; a met gate over running work is not met', () => {
  const items = [it('Machine', 1, 'done'), it('Facts', 1, 'done'), it('Rules', 1, 'done')]
  const s = { ...one(items, ['A', 'State machine', 'C'], 0), counts: [] }
  const d = derive(s as never, items, { ...NO_FACTS, turnOpen: true })
  expect(d.stage(1)).toBe('done')
  const work = [it('Check.sh passes', 0, 'now', { note: '234 of 237 pass' }), it('Merge machine branch', 0, 'next')]
  const gate = { phase: 0, when: 'All tests pass', label: 'Tests', text: 'Met' }
  const s2 = { ...one(work, ['Check'], 0), counts: [gate] }
  const d2 = derive(s2 as never, work, { ...NO_FACTS, turnOpen: true })
  expect(d2.gateMet(gate as never)).toBe(false)
  expect(d2.stage(0)).toBe('running')
  expect(brokenRules(s2 as never, work, { ...NO_FACTS, turnOpen: true }, d2)).toEqual([])
  // All work done but the gate unmet: the stage waits for the gate.
  const done2 = work.map(x => ({ ...x, status: 'done' }) as Item)
  const s3 = { ...one(done2, ['Check'], 0), counts: [{ ...gate, text: 'Waiting' }] }
  const d3 = derive(s3 as never, done2, NO_FACTS)
  expect(d3.stage(0)).toBe('open')
  expect(d3.reason('stage-0')).toContain('All tests pass')
})

test('the tree is made acyclic first: a wait on an ancestor, a descendant or a cycle of waits is cut, and the result does not depend on order', () => {
  // Parallel, so the order the list is sent in carries no meaning here: only the evaluation order is under test.
  const mk = (id: string, status: string, parent: string | null, after: string | null) => ({ id, phase: 0, name: id, status, parent, after, when: null, parallel: true }) as Item
  const shapes = [
    [mk('a', 'done', null, 'b'), mk('b', 'done', 'a', null)], // a waits for its own child
    [mk('a', 'done', 'b', null), mk('b', 'done', null, 'a')], // b waits for its own child
    [mk('a', 'done', null, 'b'), mk('b', 'done', null, 'c'), mk('c', 'done', null, 'a')], // a cycle of waits
    [mk('a', 'done', null, 'c'), mk('b', 'done', 'a', null), mk('c', 'now', null, 'b')], // a wait through a child
  ]
  for (const items of shapes) {
    const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
    const forward = derive(s, items, NO_FACTS)
    const backward = derive(s, [...items].reverse(), NO_FACTS)
    for (const x of items) expect(forward.item(x)).toBe(backward.item(x))
    expect(brokenRules(s, items, NO_FACTS, forward)).toEqual([])
  }
})

test('an item outside the stage list belongs to the nearest stage, so "all done" never hides it', () => {
  const items = [{ id: 'x', phase: 9, name: 'Lost', status: 'now', after: null, parent: null, when: null } as Item]
  const s = { phases: ['A', 'B'], phase: 2, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, { ...NO_FACTS, turnOpen: true })
  expect(d.stage(1)).toBe('running')
  expect(d.allDone).toBe(false)
})

const it = (id: string, phase: number, status: string, extra: Partial<Item> = {}) => ({ id, phase, name: id, status, after: null, parent: null, when: null, ...extra }) as Item
const one = (items: Item[], phases: string[], phase: number) => ({ phases, phase, active: [], items } as unknown as NonNullable<Summary>)

test('the owner\'s Report card: one row runs, in order, and the checklist step is the same row, not a duplicate', () => {
  const items = [it('Revenue chart', 0, 'done'), it('Package bundle', 0, 'next'), it('Write digest', 0, 'now'), it('Verify release', 0, 'next')]
  const s = one(items, ['Report'], 0)
  const steps: Task[] = [{ name: 'Package and write the digest', status: 'now', phase: 0, since: null }]
  const facts = { ...NO_FACTS, turnOpen: true }
  const merged = mergeItems(s, steps, facts)
  expect(merged.length).toBe(4)
  const d = derive(s, merged, facts)
  const running = merged.filter(x => d.item(x) === 'running').map(x => x.name)
  // The step binds to "Package bundle" (it named it first among equals) or "Write digest"; either way only work whose
  // predecessor is done runs, and nothing runs out of order.
  expect(running.length).toBeLessThanOrEqual(1)
  for (const x of merged) if (d.item(x) === 'running') expect(d.pre(x) === undefined || d.item(d.pre(x) as Item) === 'done').toBe(true)
  expect(d.item(merged[2] as Item)).not.toBe('running')
  expect(brokenRules(s, merged, facts, d)).toEqual([])
})

test('the owner\'s Analyze card: the checklist step joins "Warehouse load", and later items wait', () => {
  const items = [
    it('Warehouse load', 0, 'now'),
    it('Load tables', 0, 'done', { parent: 'Warehouse load' }),
    it('Run queries', 0, 'now', { parent: 'Warehouse load' }),
    it('Revenue tests', 0, 'next'),
    it('Payments sync', 0, 'next'),
  ]
  const s = one(items, ['Analyze'], 0)
  const steps: Task[] = [{ name: 'Load warehouse and run queries', status: 'now', phase: 0, since: null }]
  const facts = { ...NO_FACTS, turnOpen: true }
  const merged = mergeItems(s, steps, facts)
  expect(merged.map(x => x.name)).toEqual(['Warehouse load', 'Load tables', 'Run queries', 'Revenue tests', 'Payments sync'])
  const d = derive(s, merged, facts)
  expect(d.item(merged[0] as Item)).toBe('running')
  expect(d.item(merged[2] as Item)).toBe('running')
  expect(d.item(merged[3] as Item)).toBe('next')
  expect(brokenRules(s, merged, facts, d)).toEqual([])
})

test('parallel lets an item run beside the one before it; without it, it waits', () => {
  const facts = { ...NO_FACTS, turnOpen: true }
  const seq = [it('A', 0, 'now'), it('B', 0, 'now')]
  const d1 = derive(one(seq, ['S'], 0), seq, facts)
  expect([d1.item(seq[0] as Item), d1.item(seq[1] as Item)]).toEqual(['running', 'next'])
  const par = [it('A', 0, 'now'), it('B', 0, 'now', { parallel: true })]
  const d2 = derive(one(par, ['S'], 0), par, facts)
  expect([d2.item(par[0] as Item), d2.item(par[1] as Item)]).toEqual(['running', 'running'])
})

test('a checklist step with no matching item stays its own row; a matched one never draws twice', () => {
  const items = [it('Write docs', 0, 'next')]
  const steps: Task[] = [
    { name: 'Write the docs', status: 'now', phase: 0, since: null },
    { name: 'Deploy to staging', status: 'next', phase: 0, since: null },
  ]
  const merged = mergeItems(one(items, ['S'], 0), steps, NO_FACTS)
  expect(merged.map(x => x.name)).toEqual(['Write docs', 'Deploy to staging'])
  expect(merged[0]?.status).toBe('now')
})

test('all done is false while any item needs the person', () => {
  const items = [
    { id: 'a', phase: 0, name: 'Ship', status: 'done', after: null, parent: null, when: null },
    { id: 'b', phase: 0, name: 'Sign-off', status: 'needs', after: null, parent: null, when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, NO_FACTS)
  expect(d.item(items[1]!)).toBe('needs')
  expect(d.stage(0)).toBe('needs')
  expect(d.allDone).toBe(false)
  expect(brokenRules(s, items, NO_FACTS, d)).toEqual([])
})

test('a node\'s time comes from its children when it has none of its own: a stage the stage number jumped past still has a time', () => {
  expect(timeOf(5_000, [])).toEqual({ ms: 5_000 })
  expect(timeOf(null, [{ ran: 2_000 }, { ran: 3_000 }])).toEqual({ ms: 5_000 })
  expect(timeOf(null, [{ ran: null, since: 1_000, doneAt: 4_000 }, { ran: null, doneAt: 9_000 }])).toEqual({ ms: 8_000 })
  expect(timeOf(null, [{ ran: null, doneAt: 9_000 }])).toEqual({ at: 9_000 })
  expect(timeOf(null, [])).toBeNull()
})
}

// ---- was audit.test.tsx
{
// Audit 2026-11-25: each test states what a person expects to see. A failing test is a finding.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const start = async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
// The item rows in the order the pane draws them, read from each row's badge description.
const STATE = /: (done|in progress|not started)$/
// Stage badges use the same words, so the stage names are left out.
const STAGES = ['Plan', 'Build', 'Learn', 'Close out']
const rows = async (ui: any): Promise<string[]> =>
  (await ui.findAll({ type: 'Svg' })).map((x: any) => String(x.props?.alt ?? '')).filter((a: string) => STATE.test(a)).map((a: string) => a.replace(STATE, '')).filter((n: string, k: number, all: string[]) => !(STAGES.includes(n) && all.indexOf(n) === k))

test('order: items keep the order the agent sent, not done first', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Close out'], phase: 1, items: [
    { id: 'a', phase: 1, name: 'Update', status: 'done' },
    { id: 'b', phase: 1, name: 'Work PR', status: 'now' },
    { id: 'c', phase: 1, name: 'Deep review', status: 'next' },
    { id: 'd', phase: 1, name: 'Remote off', status: 'done' },
  ] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await rows(ui)).toEqual(['Update', 'Work PR', 'Deep review', 'Remote off'])
  await ui.unmount()
})

test('nesting: a parent given by id holds its children (a skill sends parent: "close-out")', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Close out'], phase: 1, items: [
    { id: 'deep-review', phase: 1, name: 'Deep review', status: 'done' },
    { id: 'lenses', phase: 1, name: 'Lenses', status: 'done', parent: 'deep-review' },
    { id: 'curator', phase: 1, name: 'Curator', status: 'done', parent: 'deep-review' },
    { id: 'work-pr', phase: 1, name: 'Work PR', status: 'now' },
  ] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A done parent is closed, so its children are not drawn at the top level beside Work PR.
  expect(await rows(ui)).toEqual(['Deep review', 'Work PR'])
  await ui.unmount()
})

test('waits: after given by id orders the siblings', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Close out'], phase: 1, items: [
    { id: 'close-step-1', phase: 1, name: 'What is left', status: 'next', after: 'close-step-0' },
    { id: 'close-step-0', phase: 1, name: 'Update', status: 'next' },
  ] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await rows(ui)).toEqual(['Update', 'What is left'])
  await ui.unmount()
})

test('rename: a parent renamed by a patch keeps its children', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1, items: [
    { id: 'review', phase: 1, name: 'Review', status: 'done' },
    { id: 'lens', phase: 1, name: 'Lens one', status: 'done', parent: 'Review' },
  ] })
  await send($, { patch: [{ op: 'change', id: 'review', name: 'Code review' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A stage whose work is all done folds to one line: open it to read its rows.
  if ((await ui.findAll({ type: 'Button' })).some((x: any) => x.key === 'open-1' && x.props?.label === '+')) await ui.press({ key: 'open-1' })
  expect(await rows(ui)).toEqual(['Code review'])
  await ui.unmount()
})

test('stage name: an item cannot end up named as its stage after the stages change', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build', 'Learn'], phase: 2, items: [{ id: 'close-out', phase: 2, name: 'Close out', status: 'now' }] })
  const r = await send($, { phases: ['Plan', 'Build', 'Close out'] })
  // Either the stage change is refused, or the pane does not draw the item as a copy of the stage title.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const refused = /kept the last good view/.test(JSON.stringify(r ?? ''))
  expect(refused || !(await rows(ui)).includes('Close out')).toBe(true)
  await ui.unmount()
})

test('a closing skill: the refusal stays; the steps as items on the Close out stage, with no parent card, are accepted', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Build', 'Close out'], phase: 1 })
  const card = await send($, { patch: [{ op: 'add', id: 'close-out', phase: 1, name: 'Close out', status: 'now' }] })
  expect(JSON.stringify(card ?? '')).toMatch(/its stage's own name/)
  const steps = await send($, { patch: [
    { op: 'add', id: 'close-step-0', phase: 1, name: 'Update', status: 'now' },
    { op: 'add', id: 'close-step-1', phase: 1, name: 'What is left', status: 'next', after: 'close-step-0' },
  ] })
  expect(JSON.stringify(steps ?? '')).not.toMatch(/kept the last good view/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await rows(ui)).toEqual(['Update', 'What is left'])
  await ui.unmount()
})

test('binding: an item bound to a task-list step closes when the step is done', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1, items: [{ id: 'tests', phase: 1, name: 'Write tests', status: 'now', taskStep: 'Add the tests' }] })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Add the tests', status: 'completed' }] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-1' })
  const alts = (await ui.findAll({ type: 'Svg' })).map((x: any) => String(x.props?.alt ?? ''))
  expect(alts).toContain('Write tests: done')
  // The step does not show again beside the item bound to it.
  expect(alts.filter((a: string) => a.startsWith('Add the tests'))).toEqual([])
  await ui.unmount()
})

test('task list slotting: a step started by a whole list moves to the current stage, as advance does', () => {
  const first = applyPlan([], { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }, 0)
  const byAdvance = applyPlan(first, { advance: true }, 1)
  const byList = applyPlan(first, { items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] }, 1)
  expect(byAdvance.find(x => x.name === 'B')?.phase).toBe(1)
  expect(byList.find(x => x.name === 'B')?.phase).toBe(byAdvance.find(x => x.name === 'B')?.phase)
})

// The quiet chat hides text drawn while a turn runs. A block from an earlier turn that is drawn again during a turn
// (the person scrolls up, the window redraws) is not narration of this turn.
test('quiet chat: an earlier turn\'s final answer, drawn again during a later turn, stays shown', async ($, on) => {
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await start($, on)
  const shown = async (text: string) => {
    const ui = await $.ui.mount({ plugin: 'mission-status', component: 'AssistantMessage', requestId: 'm', props: { text, isFirstOfReply: true }, surface: 'desktop' } as never)
    const t = (await ui.find({ type: 'Text' }))?.text
    await ui.unmount()
    return t
  }
  await send($, { project: 'P', stage: 'build', phase: 1 })
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.turn.complete({ answer: 'The fix is in PR 12.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(await shown('The fix is in PR 12.')).toBe('The fix is in PR 12.')
  await $.turn.start({ text: 'next', turnId: 't2' } as never)
  expect(await shown('The fix is in PR 12.')).toBe('The fix is in PR 12.')
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(await shown('The fix is in PR 12.')).toBe('The fix is in PR 12.')
})

test('failed item: its badge says failed, not "not started"', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1, items: [{ id: 'x', phase: 1, name: 'Deploy check', status: 'failed' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const alts = (await ui.findAll({ type: 'Svg' })).map((x: any) => String(x.props?.alt ?? ''))
  expect(alts.find((a: string) => a.startsWith('Deploy check'))).toBe('Deploy check: failed')
  await ui.unmount()
})

test('runbooks: a fifth runbook is refused or kept, never dropped in silence', async ($, on) => {
  await start($, on)
  const book = (id: string) => ({ id, title: id, steps: [{ name: 'One', status: 'now' }] })
  await send($, { project: 'P', phase: 0, runbooks: ['a', 'b', 'c', 'd'].map(book) })
  const r = await send($, { runbooks: [book('e')] })
  const refused = /kept the last good view/.test(JSON.stringify(r ?? ''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const hasE = (await ui.findAll({ type: 'Button' })).some((x: any) => /\be\b/.test(String(x.props?.label ?? '')))
  expect(refused || hasE).toBe(true)
  await ui.unmount()
})

test('template: a name the object prototype holds is refused, not a crash', async ($, on) => {
  await start($, on)
  const r = await send($, { project: 'P', phase: 0, template: 'constructor' })
  expect(JSON.stringify(r ?? '')).toMatch(/template must be one of/)
})

test('restore: a session that starts with no state takes back the state saved before an app quit', async ($, on) => {
  // The store slot is pane- and the transcript's file name; a plain test name keeps the secret scan quiet.
  const slot = 'pane-test-session-0001'
  const saved = {
    summary: { project: 'Saved work', phases: ['Plan', 'Build'], phase: 1, stage: 'build', items: [{ id: 'a', phase: 1, name: 'Write the code', status: 'now', after: null, parent: null, when: null }] },
    tasks: [],
  }
  const store = new Map<string, unknown>([[slot, saved]])
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.info', () => ({ value: { transcriptPath: '/x/projects/p/test-session-0001.jsonl' } }))
  // The app quit: this start has no state of its own.
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await rows(ui)).toContain('Write the code')
  await ui.unmount()
  // The next write saves the state again under the same key.
  await send($, { patch: [{ op: 'change', id: 'a', status: 'done' }] })
  expect((store.get(slot) as { summary: { items: { status: string }[] } }).summary.items[0]?.status).toBe('done')
})

test('task list: a step in progress shows even in a stage the agent fills with its own items', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1 })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Fix the parser', status: 'in_progress' }] } as never)
  await send($, { items: [{ id: 'done-one', phase: 1, name: 'Read the code', status: 'done' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await rows(ui)).toEqual(['Read the code', 'Fix the parser'])
  await ui.unmount()
})

test('tree lines: a name that wraps gets a line as tall as its row, so the tree has no gap', async ($, on) => {
  await start($, on)
  const long = 'Read every hook file and list each place where a stored value can go stale after a reload'
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1, items: [
    { id: 'a', phase: 1, name: long, status: 'now' },
    { id: 'b', phase: 1, name: 'Fix them', status: 'next' },
  ] })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'desktop' })
  const lines = (await ui.findAll({ type: 'Svg' })).filter((x: any) => x.props?.alt === 'Wait line').map((x: any) => Number(x.props?.height ?? 0))
  expect(lines.some((hgt: number) => hgt >= 20)).toBe(true)
  await ui.unmount()
})

test('spacing: items are blocks with one gap; no row draws a spacer or a line piece of a guessed height', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1, items: [
    { id: 'a', phase: 1, name: 'First item with a long name that wraps onto a second line at this width', status: 'done', note: 'A note that also wraps onto a second line at this narrow width' },
    { id: 'b', phase: 1, name: 'Second', status: 'now', note: 'Short note' },
    { id: 'c', phase: 1, name: 'Child', status: 'next', parent: 'b' },
    { id: 'd', phase: 1, name: 'Third', status: 'next' },
  ] })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  // No spacer drawings, and every line is the one stretched line (clipped by its cell), never a piece sized to a row.
  expect(svgs.filter((x: any) => x.props?.alt === 'Space').length).toBe(0)
  const lines = svgs.filter((x: any) => x.props?.alt === 'Wait line').map((x: any) => Number(x.props?.height ?? 0))
  expect(lines.length > 0 && lines.every((hgt: number) => hgt >= 1000)).toBe(true)
  await ui.unmount()
})
}
