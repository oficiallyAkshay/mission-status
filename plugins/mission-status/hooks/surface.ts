import type { EngineInterface } from 'claude-code'

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
