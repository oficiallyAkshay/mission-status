// One event shape for every coding app. Each app's hooks map their own event to this (live/adapters, WS6).
// Version 1. A change here is a pull request every workstream owner sees (docs/live-view-plan.md).
// Coverage: Claude Code gives every kind below. For the other apps, only session.start/end, prompt, tool.pre/post and
// turn.end are seen in their docs; the rest is unverified until WS6 checks each app. Consumers must work without
// the unverified kinds. The service redacts input and output at ingest (api.ts).

export type AppId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'copilot'

export type EventKind =
  | 'session.start'
  | 'session.end'
  | 'prompt' // the person sent a message
  | 'tool.pre'
  | 'tool.post'
  | 'tool.fail'
  | 'turn.end' // the agent stopped and waits for the person
  | 'subagent.start'
  | 'subagent.stop'
  | 'task.created'
  | 'task.done'
  | 'compact'
  | 'notify' // the app asks for the person (permission, idle, needs input)

export interface NormalizedEvent {
  v: 1
  app: AppId
  // The app's own session id, as its hooks give it (Cursor: conversation_id).
  session: string
  kind: EventKind
  // Milliseconds since the epoch, stamped by the service on receipt when the app gives none.
  at: number
  cwd: string | null
  // Path to the app's transcript file, when the hook gives one.
  transcript: string | null
  tool?: string
  // Tool input, as the app gives it. Truncated by the service to 16 KiB.
  input?: unknown
  // Tool output or error text. Truncated by the service to 4 KiB.
  output?: unknown
  // Subagent or task id, when the event has one.
  ref?: string
  // The app's own event name, kept for debugging.
  source: string
}
