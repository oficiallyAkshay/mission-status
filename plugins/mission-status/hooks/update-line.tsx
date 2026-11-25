import type { UpdateState } from './update'

// How long the pane shows "Updated to x.y.z" after an update.
export const UPDATED_SHOWN_MS = 60_000
// What the person runs by hand when the update fails 3 times.
export const MANUAL_COMMAND = 'claude plugin marketplace update && claude plugin update mission-status'

// The one update line of the pane, or null for none.
export function updateText(s: UpdateState, now: number): string | null {
  if (!s) return null
  if (s.phase === 'updated' && s.version && now - s.at < UPDATED_SHOWN_MS) return `Updated to ${s.version}`
  if (s.phase === 'available' && s.version) return `Version ${s.version} is available.`
  if (s.phase === 'failed') return `Update failed. Run: ${MANUAL_COMMAND}`
  return null
}
