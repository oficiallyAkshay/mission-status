import { expect, mock, test } from 'claude-code/testing'
import { FIRST_REMINDER, HOLD_TEXT, REMINDER, RULE, STALE_MS } from '../hooks/model'

// The freshness triggers: product plan, "How the state stays current".

const start = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  watch(on)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
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

test('stale after 10 minutes of tool calls: a one-line reminder rides on the next step', async ($, on) => {
  const { clock } = await start($, on)
  await send($, BASE)
  await clock.advance(STALE_MS - 1000)
  expect(ctx(await bash($))).toEqual([])
  await clock.advance(1000)
  expect(ctx(await bash($))).toEqual([REMINDER])
  expect(ctx(await bash($))).toEqual([])
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

test('a turn end while stale is held once with a request for an update', async ($, on) => {
  const { clock } = await start($, on)
  await send($, BASE)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  await clock.advance(STALE_MS)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(HOLD_TEXT)
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('after 2 ignored reminders the state is marked May be out of date; an agent update clears it', async ($, on) => {
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
