# mission-status live view: plan (revision 1, 2026-11-26)

## Ask
Nothing in `live/` is built yet. This plan fixes the architecture, the contracts and six workstreams. Each workstream runs in its own session, in its own folder, against the contracts in `live/protocol/`.

## Objective (what the owner sees)
- In the Claude desktop app, every session with real work opens a live HTML view in the app's browser pane, beside the chat, by itself. It has the tabs Current, Timeline, PRs, Watches and Runbook.
- The same view works for Codex, Gemini CLI, Cursor and Copilot CLI sessions, opened from their own hooks.
- The view is generative: a model picks the layout and composes molecules and organisms from our atoms, within a fixed catalog and schema. Data changes and schema changes draw in under 1 s with no new HTML.
- The current pane (`plugins/mission-status`) stays installed and working. The live view is the default route; the pane opens on `/mission-status`.

## Evidence this rests on
Report: https://claude.ai/artifact/EQXFfSJxJiDr6FzhKVtrey. Notes: the shared side-session notes folder.

| Claim | Evidence |
|---|---|
| Localhost page updates fast | Probe: p50 119 ms, p95 299 ms (250 ms poll) |
| A mod opens the tab by itself | Probe: `$.tool.call({tool:'mcp__Claude_Browser__preview_start', url})` from `session.start` opened a live tab in 319 ms, no prompt, other tab untouched |
| Ordinary hooks can feed a local server | Claude Code hooks reference: `type: "http"` hooks, background processes from hooks, plugin `hooks/hooks.json` |
| Other apps have the same core hook events | Official docs: Codex, Gemini CLI, Cursor, Copilot CLI |
| A2UI fits the block model | A2UI v1.0 spec: `createSurface`, `updateComponents`, `updateDataModel`, flat component list by id, JSON Pointer bindings; `@a2ui/lit` custom components = Zod schema + Lit element |

## Architecture

```
 coding app (Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI)
   │ ordinary hooks: Claude posts JSON over HTTP; the others run `ms-hook <app>`
   ▼
 live service (Node 22, one per machine, 127.0.0.1, own port)
   ├─ ingest      POST /v1/hook/:app        → NormalizedEvent (live/protocol/events.ts)
   ├─ store       per-session event log (append only) + derived state, on disk
   ├─ readers     transcript readers per app, gh and CI, git; all deterministic
   ├─ machine     the state machine reused from plugins/mission-status/hooks/machine.ts
   ├─ writers     model calls only where data cannot be read: Jev for pick-one, CLI model for composition and text
   ├─ emitter     state → A2UI messages, diffed to changed paths only
   └─ page        GET /s/:session (the shell), GET /v1/stream/:session (SSE of A2UI messages)
   ▼
 page (A2UI web_core + Lit, our catalog "mission-status/v1")
   tabs: Current · Timeline · PRs · Watches · Runbook, one A2UI surface per tab
 opened by: Claude adapter mod (preview_start, reuses its own tab); other apps: their own route (WS6)
```

### Fixed rules
1. Deterministic first. A model is called only for: grouping work into outcomes (Current), timeline verbs and one-line titles, short summaries, and composing a layout for a new outcome shape. Timers, counts, statuses, PR and CI state, table cells from commands: no model.
2. Nothing on the 1 s path calls a model. Timers tick in the page from start times.
3. The main agent sends nothing to the view. So the `current` writer, not the agent, produces the outcomes; `machine.ts` keeps deciding statuses, fed by the writer's outcomes plus read facts (tool calls, task list, helpers, jobs). While the 0.18 pane is installed, its update-tool calls are read from hook payloads as a hint only. Pane parity (WS4, WS5) covers what can be read or written by the writers; agent-only fields with no source are dropped, and the parity table says which.
4. A writer's output is checked against the catalog's Zod schemas. Bad output keeps the last good view and is logged.
5. Writers never trigger themselves: every writer process runs with `MS_LIVE_WRITER=1`, and every hook, the shim and the adapter return at once when it is set (`live/protocol/writer.ts`). A test proves it.
6. The service is local and guarded (`live/protocol/api.ts`): one instance per machine by an exclusive lock; a token on every route but the signature; Host checked against 127.0.0.1; no CORS; a one-time key for the page; state folder 0700; secrets redacted at ingest; logs kept 7 days. It stops only the process id it wrote, skips any port whose signature is not its own, and never uses or writes `.claude/launch.json`.
7. Hooks never hold the agent: every http hook sets `timeout: 1` and keeps `onFailure` at continue. SessionStart uses a command hook (whether SessionStart takes http hooks is unverified), which also starts the service when it is down.
8. The adapter mod lists tabs first and reuses its own tab; it never calls `preview_stop` (the preview server id is shared with the person's tabs); it closes only its own tab.
9. Plain English, no secrets, personal names or local paths in the repository (AGENTS.md). Private tooling of the owner (a specific decision model, a job router) is configured outside the repository behind the generic `Decider`.

### Repository layout and owners
| Path | Owner |
|---|---|
| `live/protocol/` | This plan. Changes go through a pull request that every owner sees. |
| `live/service/` | WS1 |
| `plugins/mission-status-live/` (new plugin: ordinary hooks + adapter mod) | WS1 |
| `plugins/mission-status/` (current pane): only the auto-open guard | WS1, one small pull request with a version bump. The pane reads a flag the live plugin's SessionStart writes; it never probes over HTTP |
| `scripts/check-version.sh`, `.github/workflows/ci.yml`, `.claude-plugin/marketplace.json` | WS1: loop checks over every plugin folder; add `mission-status-live` to the marketplace |
| `live/page/` (shell, runtime glue, template store) | WS2 |
| `live/writer/` (prompts, Jev decider, CLI runner, validation) | WS2 |
| `live/catalog/` (atoms, molecules, organisms, gallery) | WS3 |
| `live/tabs/current/`, `live/tabs/timeline/`, `live/tabs/runbook/` | WS4 |
| `live/tabs/prs/`, `live/tabs/watches/`, `live/port/` (parity map) | WS5 |
| `live/adapters/` (shim and one folder per app) | WS6 |

## Workstreams
| # | Session name | Outcome the owner sees | Depends on |
|---|---|---|---|
| WS1 | live-core | A Claude session opens the live tab by itself and shows its events within 1 s; the pane still works | protocol |
| WS2 | live-genui | A writer can add a new card or column, or compose a new molecule, and the page draws it with no new HTML | protocol |
| WS3 | live-blocks | A gallery page shows all 20 catalog components in light and dark with fixture data | protocol, WS2 registry API (in protocol) |
| WS4 | live-tabs | Current shows only open outcomes; Timeline appends entries with verbs; Runbook draws runbooks. WS4 owns the parity rows for what Current replaces (Progress: goal, stages, items, gates, timers) | WS1 data, WS3 blocks (fixtures until then) |
| WS5 | live-port | PRs, Watches, the update line and onboarding (where it applies) show in the HTML view, checked row by row; WS5 also writes the full parity table and gives the Progress rows to WS4 | WS3, WS1 |
| WS6 | live-harnesses | A Codex, Gemini CLI, Cursor and Copilot CLI session each feeds the same service and opens the view | protocol, WS1 ingest |

All six start now against fixtures; each owns only its own folders. Integration milestone M1: WS1 + WS2 + three WS3 blocks show a real Claude session. M2: all tabs. M3: other apps.

## Stages
| Stage | Who | Done when |
|---|---|---|
| Plan and contracts committed | Claude | This file and `live/protocol/` are on the branch |
| M1: Claude session live in HTML | Claude (WS1, WS2, WS3) | A real session shows its stages and timers in the live tab, verified in the app |
| M2: All tabs, pane parity | Claude (WS4, WS5) | Parity table all rows met, checked in the app |
| M3: Other apps | Claude (WS6) | Each app's session shows in the view, one run each |
| Look check | Owner | He passes each tab in the app |

## Corrections from the independent review (2026-11-26)
| Finding | Change made |
|---|---|
| "Agent sends nothing" removed the input `machine.ts` needs | Rule 3: the `current` writer feeds `machine.ts`; parity limited to readable or writable fields |
| A2UI catalogs do not import each other | `mission-status/v1` re-exports the basic components it uses |
| Data under the view paths had no types | `ViewModel` and its row types in `live/protocol/view.ts` |
| Unauthenticated localhost routes (injection into writers, DNS rebinding) | Token, Host check, no CORS, page key, 0700 state (rule 6, `api.ts`) |
| Writers' own CLI runs would fire the hooks again | `MS_LIVE_WRITER=1` guard and a test (rule 5) |
| A hook budget that could not be enforced | `timeout: 1` on every http hook (rule 7) |
| CI checks only the first plugin | WS1 loops CI and the version check over every plugin and adds the marketplace entry |
| The pane probing the service races at session start | The pane reads a flag file instead; version bump |
| Two services could start at once | Exclusive lock on the state folder |
| No template store API and no writer triggers | `TemplateStore` in `catalog.ts`; `WriterRequest`, `WriterResult` and the triggers in `writer.ts` |
| Tool input with secrets kept and streamed | Redaction at ingest, 7-day retention |
| Status words differed from the pane's | One mapping, `PANE_STATUS` in `catalog.ts` |
| WS4 and WS5 both owned Progress parity | WS4 owns the Progress rows; WS5 the rest |
| Private tooling named in the repository; other apps' events unverified | Generic `Decider`; per-app coverage marked unverified in `events.ts` |

## Undo
Remove `live/` and `plugins/mission-status-live/`, and revert the one auto-open guard pull request; the current pane is unchanged otherwise.

## Expected limit
Codex, Gemini CLI, Cursor and Copilot CLI have no in-app browser pane we can open from a hook (not checked), so outside Claude the view opens in the system browser. The service needs Node 22 on the machine in v1.

## Decisions
| Decision | Recommendation | Note |
|---|---|---|
| Service runtime | Node 22 in v1; a `deno compile` binary later for machines without Node | Owner's Mac has Node 22 and Deno |
| Where the live route lives | A new plugin `mission-status-live` in the same marketplace, on by default in local testing | Keeps the 0.18 pane untouched and its CI version job intact |
| Pane while live is on | The pane skips its auto-open when the live service answers; `/mission-status` still opens it | One small guarded change in the pane |
| Model access | Each app's own CLI (`claude -p`, `codex exec`, `gemini -p`), run with `MS_LIVE_WRITER=1`; WS1 probes that `claude -p` works from a hook-started service | No token is read from the keychain |
| Pick-one decisions | A generic `Decider` (`live/protocol/writer.ts`). The default asks the app's CLI model; a local config outside the repository may point it at a faster decision model | It picks block kinds, expand or fold, and the next part for each slot when composing; a mid-size model only for a whole new layout |
| Saved compositions | The service's template store (`TemplateStore` in `live/protocol/catalog.ts`); A2UI relative paths for bindings | A2UI lists runtime templates as roadmap only |
| Catalog | `mission-status/v1` re-exports the basic components it uses, since A2UI catalogs do not import each other | WS2 confirms against the v1.0 spec |
| A2UI versions | Pin `@a2ui/web_core` 0.16.1 and `@a2ui/lit` 0.16.0; bundle into the page | Released 2026-11-23; expect breaking changes |
| Stage templates | Not used by the live view; Current replaces them (parent ruling 2026-11-26) | The pane keeps its templates |
