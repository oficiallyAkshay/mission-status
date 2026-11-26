import type { EngineInterface } from 'claude-code'
import { atom, read } from 'claude-code'

// True once the person closed the progress pane; only their own open (/mission-status) clears it.
const closedAtom = atom({ plugin: 'mission-status', key: 'closedByPerson' } as const, false)

// Opens a pane only while a surface is attached to draw it. With none (right after a reload, or in a run with no app),
// the app refuses the open and prints a "no surface" line into the transcript; the pane never asks then, so no such
// line shows. A refusal of any other kind is swallowed too: an open is a convenience, never worth a line in the chat.
export async function openPane($: EngineInterface, opts: Parameters<EngineInterface['ui']['open']>[0]): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  if (surfaces.length === 0) return false
  return $.ui
    .open(opts)
    .then(() => true)
    .catch(() => false)
}

// Opens the progress pane on the pane's own initiative (an agent update, a reload, a goal), unless the person closed
// it: then it stays closed until they open it again. Without this, the next agent update reopened a pane just closed.
export async function openPaneAuto($: EngineInterface, opts: Parameters<EngineInterface['ui']['open']>[0]): Promise<boolean> {
  if ((await read($, closedAtom).catch(() => false)) === true) return false
  return openPane($, opts)
}
