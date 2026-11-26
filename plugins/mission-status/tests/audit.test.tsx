import { expect, test } from 'claude-code/testing'
import { applyPlan } from '../hooks/model'

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
