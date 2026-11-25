import { atom, read } from 'claude-code'
import type { On } from 'claude-code'
import type { Summary } from '../types'

// The quiet chat. While the pane holds a state, the text the agent writes between tool calls ("Now the tests.") is
// hidden in the chat view: the pane already shows the progress. Shown still: a block with a question, and each turn's
// final message. The stored transcript is unchanged, so the hidden text stays in the session's record.
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const holdback = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)

// Blocks drawn while a turn ran; the turn's final message leaves the set when the turn ends.
const narration = new Set<string>()
let isInTurn = false

const key = (text: string) => text.trim()
// A block that asks the person something stays: it may be the input the work waits on.
export const asks = (text: string) => /\?\s*$/m.test(text.trim())

export function registerQuiet(on: On): void {
  on('turn.start', { text: /(?:)/ }, async ($, e, next) => {
    if (e.agentId === undefined) isInTurn = true
    return next(e)
  })

  // The matchers keep these hooks apart from the other parts' hooks on the same events.
  on('turn.complete', { isAborted: [false, true] }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      isInTurn = false
      narration.delete(key(String((e as { answer?: unknown }).answer ?? '')))
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = String(e.props.text ?? '')
    if (e.props.isSummary === true || asks(text)) return next(e)
    const s = await read($, summary).catch(() => null)
    if (s === null || (await read($, holdback).catch(() => false))) return next(e)
    if (isInTurn) narration.add(key(text))
    if (!narration.has(key(text))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
