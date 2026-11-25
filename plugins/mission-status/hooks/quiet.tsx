import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Summary } from '../types'

// The quiet chat. While the pane holds a state, the text the agent writes between tool calls ("Now the tests.") is
// hidden in the chat view: the pane already shows the progress. Shown still: a block with a question, and each turn's
// final message. The stored transcript is unchanged, so the hidden text stays in the session's record.
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const holdback = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)

// Blocks hidden as narration, and blocks shown before the current turn began (the final messages of earlier turns, and
// anything drawn between turns). A block in the second set is never hidden: drawn again in a later turn, it is not
// narration of that turn. Both sets are written to $.state when a turn starts and ends (drawing is pure: a render hook
// cannot write), and a plugin reload, which waits for a turn end, keeps them; each keeps its last 200 keys.
type Kept = { hidden: string[]; shown: string[] }
const KEEP = 200
const keptAtom = atom({ plugin: 'mission-status', key: 'quietKept' } as const, { hidden: [], shown: [] } as Kept)
const narration = new Set<string>()
const earlier = new Set<string>()
let isLoaded = false
let isDirty = false
let isInTurn = false

const key = (text: string) => text.trim()
// A block that asks the person something stays: it may be the input the work waits on.
export const asks = (text: string) => /\?\s*$/m.test(text.trim())

export const bound = (set: Set<string>) => {
  while (set.size > KEEP) set.delete(set.values().next().value as string)
}

// Reads the kept sets once per load of this module.
async function load($: EngineInterface): Promise<void> {
  if (isLoaded) return
  isLoaded = true
  const k = await read($, keptAtom).catch(() => null)
  for (const x of k?.hidden ?? []) narration.add(x)
  for (const x of k?.shown ?? []) earlier.add(x)
}

async function keep($: EngineInterface): Promise<void> {
  if (!isDirty) return
  isDirty = false
  bound(narration)
  bound(earlier)
  const kept: Kept = { hidden: [...narration], shown: [...earlier] }
  await update($, keptAtom, () => kept)
}

export function registerQuiet(on: On): void {
  on('turn.start', { text: /(?:)/ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      isInTurn = true
      await load($)
      await keep($)
    }
    return next(e)
  })

  // The matchers keep these hooks apart from the other parts' hooks on the same events.
  on('turn.complete', { isAborted: [false, true] }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.agentId === undefined) {
        isInTurn = false
        await load($)
        const answer = key(String((e as { answer?: unknown }).answer ?? ''))
        narration.delete(answer)
        if (answer !== '') earlier.add(answer)
        isDirty = true
        await keep($)
        $.ui.invalidate('ui.render')
      }
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = String(e.props.text ?? '')
    if (e.props.isSummary === true || asks(text)) return next(e)
    const s = await read($, summary).catch(() => null)
    if (s === null || (await read($, holdback).catch(() => false))) return next(e)
    await load($)
    const k = key(text)
    if (!narration.has(k)) {
      // Drawn between turns, or already shown before this turn: stays. Drawn first during a turn: narration.
      if (!isInTurn || earlier.has(k)) {
        earlier.add(k)
        isDirty = true
        return next(e)
      }
      narration.add(k)
      isDirty = true
    }
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
