# Anonymous metrics

mission-status can send a few anonymous events about how the progress pane is used, so the owner can see whether the pane works. On by default; nothing is sent until the notice has shown once; off at any time with the switch or /pane-metrics off. This page lists every event and every field. The code is `plugins/mission-status/hooks/metrics.tsx`, and a test holds the code to this list.

## Turn it on or off

- The switch in onboarding, shown with the notice, turns it on or off.
- `/pane-metrics on` turns it on and makes the install id. Typing it counts as having seen the notice.
- `/pane-metrics off` turns it off at once: nothing more is counted or sent, events not yet sent are dropped, and the install id is deleted.
- `/pane-metrics` alone says whether it is on, and shows the install id when it is.

When the environment variable `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, nothing is sent, whatever the choice.

## What is sent

Nothing is sent until both are true: the metrics notice has been on screen at least once, and the choice is on. Before onboarding shows the switch, the choice is unset, and nothing is sent. Events are kept in memory and sent at most once a minute, as one JSON `POST` over HTTPS to PostHog Cloud (US), `https://us.i.posthog.com/i/v0/e/`: `{api_key, batch}`, where each entry is `{event, distinct_id, timestamp, properties}`. A send that fails is dropped and never tried again. A send never holds up the pane or a tool call. Events still in memory when the session ends are sent then if a minute has passed since the last send, and are dropped otherwise.

A real-work session is a session with 5 or more tool calls.

### Properties on every event

| Property | Value |
|---|---|
| `product` | `mission-status` |
| `schema_version` | `1` |
| `$process_person_profile` | `false`: PostHog builds no person profile |
| `$geoip_disable` | `true`: PostHog looks up no location |

### Events

Every other property is a word from the fixed list shown, or a whole number. The code drops any property or value not in this table.

| Event | When | Properties |
|---|---|---|
| `session_real_work` | Once per session, at the 5th tool call | `holdback`: `yes` or `no` |
| `pane_shown` | Once per real-work session, the first time the pane is drawn | `holdback`: `yes` or `no` |
| `progress_ask` | For each prompt you type in a real-work session (prompts before the 5th tool call are held, then sent). The prompt is sorted on your Mac by the word list below; only the answer leaves it | `progress`: `yes` or `no`; `holdback`: `yes` or `no` |
| `update_accuracy` | Each time the agent updates the pane while a task-list step is in progress | `accurate`: `yes` when the agent's current stage (or a stage it marks as running in parallel) holds the step in progress, `no` otherwise |
| `stale_reminder` | When the pane would remind the agent to update: at the 5th tool call with no update yet, after 3 new task-list steps with no update, or after 10 minutes of tool calls with no update. Once per stale stretch | `trigger`: `no_state`, `steps` or `time` |
| `update_after_reminder` | When the agent updates after a reminder, or when 3 tool calls pass after it with no update | `followed`: `yes` when the update came within 3 tool calls, `no` otherwise; `steps`: the tool calls between the reminder and this event |
| `render` | At each send, when the pane was drawn since the last one | `count`: drawings since the last send |
| `render_error` | When drawing the pane fails | `code`: `type`, `range`, `reference`, `syntax`, `error` or `other` (the kind of error, never its message) |
| `update_ok` | When the mod updated itself and the new version is running | none |
| `update_failed` | When a self-update failed (a failed check for a new release is not counted) | `code`: `install` (the install command failed), `reload` (the new code did not load) or `other` |

`distinct_id` is the install id (below). `timestamp` is the time of the event.

### Never sent

Prompt text, goal text, stage or item names, task-list steps, file names, paths, branch names, commands, pull request titles, links, session titles, session ids, repository names, account ids, email addresses, error messages. The metrics code never reads the session id or the account. The onboarding reads the signed-in account once, to show itself once for each account; it keeps only a one-way hash of it in the plugin's local store and sends nothing about it. The tests send these through a session and fail if any of them, or anything that looks like an id or a path other than `distinct_id`, reaches an event.

## The progress word list

A prompt is a progress question when, in lower case with apostrophes and punctuation removed, it holds one of these as whole words:

status, progress, eta, where are we, where are you, where do we stand, how far, how far along, how long, how much longer, how is it going, hows it going, how are we doing, whats left, what is left, whats remaining, what remains, whats the state, what stage, which stage, what are you doing, what are you working on, whats happening, what is happening, any update, any updates, give me an update, update me, are you done, are we done, is it done, done yet, finished yet, still working, still running, still going

The list is `PROGRESS_WORDS` in `metrics.tsx`. A change to it changes the measure, so it changes `schema_version`.

## The holdback

For 30 days after the release date (`RELEASE_AT` in `metrics.tsx`), on installs with metrics on (the notice seen) only, a random 1 in 10 real-work sessions is a holdback: that session shows no pane and gets no standing rule, so the agent works as it would without the pane. The holdback sessions are the comparison group for the progress-question measure. The choice is made on your Mac at the 5th tool call and kept for that session only. Installs that turned metrics off, that have not seen the notice, or that set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, never get a holdback. After the 30 days, nobody does.

## The id, honestly

`distinct_id` is a random UUID v4 made on your Mac at the first send, and kept in the mod's own store. It is pseudonymous, not anonymous: it lets the events of one install be told apart from another's, and it identifies nobody by itself. `/pane-metrics off` deletes it; turning metrics on again makes a new one that nothing links to the old one. The request also reaches PostHog's servers over the network, so PostHog's servers see the connection's IP address while handling it. The project is set to discard client IP data, and `$geoip_disable` stops any location lookup, but that setting is the owner's and not something the mod can prove from your side.

## Where it goes

PostHog Cloud (US), a PostHog project the maintainer runs, with `product: "mission-status"` on each event. The project key in `metrics.tsx` is PostHog's public, write-only key: anyone can read it, and it can only add events. The mod sends with the engine's own `$.http.fetch`: no PostHog SDK, no autocapture, no session recording.

## The optional state marker (Sarvam)

This is not a metric, and it is off by default. When `SARVAM_API_KEY` is set in the environment of Claude Code, the pane sends recent work to Sarvam to mark item states (`plugins/mission-status/hooks/infer.ts`). What goes, about every 30 s and only after new tool calls, as one JSON `POST` to `https://api.sarvam.ai/v2/systemone` with your key in the `api-subscription-key` header:

- The model id `sarvam-prism`.
- The pane's item names, stages and states (at most 40), and the names of new items to place.
- The newest 40 tool-call lines, each at most 160 characters: the tool, its target (a Bash description or command, a file name without its folder, a search pattern, a query, a URL, a helper's description) and its end: ok, error, or a Bash command's last output line (at most 100 characters).

Never sent to Sarvam: file contents, other tool output, prompts, the chat, paths beyond a file's own name, the session id. Unset the variable to stop it. Sarvam's own terms apply to what it receives.

## Deletion requests

To ask for your events to be deleted, open an issue in this repository with your install id. Type `/pane-metrics` to see it. The owner deletes the events with that id in PostHog and replies within 30 days.
