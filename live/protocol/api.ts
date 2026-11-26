// The live service's HTTP surface. Version 1. Bound to 127.0.0.1 only, on a port from 47800 to 47899.

export const PORT_FIRST = 47800
export const PORT_LAST = 47899
// The service keeps its state under the user's own state folder (never a repository), mode 0700:
//   lock   exclusive lock; only the holder runs. A second start reads `port` and exits.
//   port   the port it bound;  pid  its process id;  token  a random 32-byte hex secret, mode 0600
//   sessions/<app>-<session>/events.jsonl   kept 7 days after the session's last event
export const STATE_DIR_NAME = 'mission-status-live'

// GET /.well-known/mission-status → Signature. The only route without a token. Any other answer means the port
// belongs to someone else: skip it. The service stops only the pid it wrote.
export interface Signature {
  name: 'mission-status-live'
  version: string
  pid: number
  port: number
}

// Every other route:
//   - requires header `x-ms-token: <token>`, or for the page shell the one-time key below;
//   - rejects any Host other than 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
//   - sends no CORS headers, and refuses requests that carry an Origin other than its own.
//
// POST /v1/hook/:app            body: the app's own hook JSON → 200 {} at once; mapping and redaction in the service.
// POST /v1/event                body: NormalizedEvent (from ms-hook, which maps first) → 200 {}.
// GET  /s/:session?k=<key>      the page shell. `key` is per session, made by the service, given to the adapter only;
//                               the page then holds a cookie (HttpOnly, SameSite=Strict) for the stream.
// GET  /v1/stream/:session      text/event-stream; each event's data is one A2UI message.
// GET  /v1/sessions             → SessionInfo[]
// POST /v1/open/:session        → { url } with a fresh key, for the adapter.
// POST /v1/shutdown             stops this service only.

export interface SessionInfo {
  app: string
  session: string
  title: string | null
  cwd: string | null
  startedAt: number
  lastEventAt: number
}

// Hook timing: every http hook sets `timeout: 1` (whole seconds, the smallest allowed) and keeps onFailure at
// continue, so a hung service never holds the agent. The service's own reply target is under 50 ms.
export const REPLY_TARGET_MS = 50

// Redaction at ingest, before anything is written or streamed: values of keys matching
// /token|secret|password|passwd|api[_-]?key|authorization|cookie/i, and strings shaped like keys (sk-…, ghp_…,
// xox…, AKIA…, long base64 or hex runs over 32 chars) become "[redacted]".
