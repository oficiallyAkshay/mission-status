// Model writers: when they run, what they get, what they return. WS1 triggers and stores; WS2 builds prompts, calls
// models and validates. Version 1.

import type { NormalizedEvent } from './events'
import type { Outcome, TimelineEntry, ViewModel } from './view'
import type { Template } from './catalog'

export type WriterKind =
  | 'timeline' // group new events into entries, pick a verb and a title (small model)
  | 'current' // rewrite open outcomes from the transcript and facts (mid model)
  | 'compose' // a new outcome shape: compose a Template from catalog parts (decider first, model if needed)
  | 'summary' // a one-sentence PR or card summary (small model)

// Triggers (WS1): timeline at each turn.end and every 2 min while events arrive; current at each turn.end and every
// 2 min while a turn is open; compose when current returns an outcome whose shape no organism or template fits;
// summary once per new PR. One writer of each kind per session at a time: a new trigger while one runs is held,
// and a run that takes more than 90 s is stopped and its result dropped.
export interface WriterRequest {
  kind: WriterKind
  session: string
  app: string
  // Events since the last run of this kind, already redacted.
  events: NormalizedEvent[]
  // The view as it stands, so the writer changes only what moved.
  view: ViewModel
  transcriptTail: string | null
}

export type WriterResult =
  | { kind: 'timeline'; append: TimelineEntry[] }
  | { kind: 'current'; outcomes: Outcome[]; closed: string[] }
  | { kind: 'compose'; template: Template }
  | { kind: 'summary'; ref: string; text: string }

// Pick-one decisions (block kind, expand or fold, next part for a slot) go to a Decider first.
export interface Decider {
  choose(question: string, options: string[], state: string): Promise<{ pick: string; confidence: number } | null>
}

// Every writer process (claude -p, codex exec, gemini -p) runs with this set. Every hook, the adapter mod and the
// shim return at once when it is set, so a writer never starts a session view or another writer.
export const WRITER_ENV = 'MS_LIVE_WRITER'
