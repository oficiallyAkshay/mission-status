import { expect, test } from 'claude-code/testing'
import { asks } from '../hooks/quiet'

// The quiet chat: with the pane on, mid-turn narration is hidden in the chat view; questions and final messages show.
const MSG = (text: string) => ({ plugin: 'mission-status', component: 'AssistantMessage', requestId: 'm', props: { text, isFirstOfReply: false } }) as never

const start = async ($: any, on: any) => {
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}
const shown = async ($: any, text: string) => {
  const ui = await $.ui.mount({ ...MSG(text), surface: 'desktop' })
  const t = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return t
}

test('a question is a block that ends in a question mark', () => {
  expect(asks('Which direction should I build?')).toBe(true)
  expect(asks('Now the tests.')).toBe(false)
})

test('with the pane on, narration during a turn is hidden; the final message and questions show', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1 } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect(await shown($, 'Now the tests.')).toBeUndefined()
  expect(await shown($, 'Which font should I use?')).toBe('Which font should I use?')
  expect(await shown($, 'All 26 tests pass.')).toBeUndefined()
  await $.turn.complete({ answer: 'All 26 tests pass.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(await shown($, 'All 26 tests pass.')).toBe('All 26 tests pass.')
  expect(await shown($, 'Now the tests.')).toBeUndefined()
})

test('with no pane state, the chat shows every block', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect(await shown($, 'Now the tests.')).toBe('Now the tests.')
})
