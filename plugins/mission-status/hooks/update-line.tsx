import type { EngineInterface } from 'claude-code'
import type { UpdateState } from './update'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

// How long the pane shows "Updated to x.y.z" after an update.
export const UPDATED_SHOWN_MS = 60_000
// What the person runs by hand when the update fails 3 times.
export const MANUAL_COMMAND = 'claude plugin marketplace update && claude plugin update mission-status'

// The one update line of the pane, or null for none.
export function updateText(s: UpdateState, now: number): string | null {
  if (!s) return null
  if (s.phase === 'updated' && s.version && now - s.at < UPDATED_SHOWN_MS) return `Updated to ${s.version}`
  if (s.phase === 'failed') return `Update failed. Run: ${MANUAL_COMMAND}`
  return null
}

// Draws the update line with the surface's Text, or nothing. view.tsx calls it with the elements it resolved.
export function renderUpdateLine({ Text }: Pick<Elements, 'Text'>, s: UpdateState, now: number) {
  const text = updateText(s, now)
  return text ? <Text dimColor>{text}</Text> : null
}
