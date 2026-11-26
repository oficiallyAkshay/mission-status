# mission-status v1: product plan (revision 6)

## Problem
People who run long Claude Code sessions ask "where are we?" again and again, and get long text answers that are hard to skim and go stale at once.

## Outcome
A person installs the pane with one command. In the Claude desktop app, every session with real work shows a live view of its progress beside the chat: the goal, the stages, what runs now, what gates each stage, the merge state, and the state of each subsession it started.

## Owner rulings that fix scope (2026-11-24)
Desktop app only (no terminal or VS Code view). Ten stage templates ship. The nine special type blocks and the subsessions below are not built. Onboarding has a WebGL shader background. No tickets. The only settings are auto-update (on or off) and saveTemplate (the agent saves a set of stages as a personal template). Dark and light themes. Public repository and marketplace, MIT. Metrics consent asked once in onboarding; PostHog Cloud US, one PostHog project, with product "mission-status".

## Definitions
- Real-work session: a session with 5 or more tool calls (tool calls only).
- Subsession (not built): a separate Claude session that another session started (the app links them as parent and child). Subagents inside one session are helpers, not subsessions.

## v1 scope
1. Schema: one versioned progress state with migrations, a size cap (32 KB), and validation. Two writers with split ownership: task-list items belong to the pane; agent items carry stable ids; a full state from the agent never deletes items that belong to the pane. Every write carries a version number, and an older version never replaces a newer one. The agent may send item changes as patches. A state that fails validation keeps the last good view and returns the error text to the agent.
2. Nine session types (the stage lists ship as ten templates, including plan-review; the nine special blocks are NOT BUILT), each a template (a stage list plus at most one special block): Feature; Bug fix and root cause (symptom, suspected causes with states); Incident (impact, timeline, time open); Research (findings with confidence, narrowing counts); Design (directions with the recommended pick); Board batch (work tree, items in flight, stuck items on top); Review (findings by severity, verdict); Migration (moved count, failed count, undo ready); Writing (sections, readers). Custom stages when no type fits. The agent may switch the type, and add, remove, rename or reorder stages, items and gates at any time.
3. Core view: stage bar (a row of stage chips that wraps; nothing is measured), stage cards (status badge, circle spinner, MM:SS timer, the chat's own status words), gate lines with exit clauses, nested items with + and -, parallel stages, an Update button.
4. Pull requests (0.12.0; the Merge card is gone): each item that made a pull request carries a linked chip with its state icon, and the PRs tab lists every pull request the session (or a Marga job it ran) opened, as cards with the repository and number, the title and a two-sentence summary, opening to Commits, CI and Details. One record per pull request feeds both, read once a minute in parallel whether the pane is open or not; a merged or closed one is not read again; nothing is read in a headless session or after 10 idle minutes with no turn and no CI running; a failed read shows "GitHub not read since" in the PRs tab.
4a. State machine (0.12.0): one pure function decides every status from facts (two ordered rule tables, checked over every input): running only while a turn, a helper or a child runs it; done only when its children and dependency are done; timers count running time only; the clock ticks only while something runs.
4b. Step marker (0.12.0): 5 s after the last main-loop tool call and at each turn end (a confirming check 5 s after a new mark), Haiku inside Claude Code proposes marks and new steps; a mark shows only when two calls agree, and the state machine still decides. Off with nonessential traffic off and in headless sessions.
5. Subsessions (NOT BUILT): each subsession has its own pane, with its own state, at its own level. In the parent's pane, each subsession is one card in the stage where the parent started it: its title, its current stage, its status words, its timer, and its state (running, waiting on the person, done, failed). A click on the card opens that subsession. The parent reads each child's state from a shared store on the machine. Each session's hooks (not the pane on screen) write their entry under the session id, atomically, with a heartbeat time. With no heartbeat for 60 s and no live session, the card shows "Stopped". The parent never sends child state itself.
6. Onboarding at first run: a WebGL shader as the app background during onboarding only (still frames under Reduce Motion), a 15 second live demo made from the pane's own parts, the metrics consent choice.
7. Metrics after consent only.
8. Dark and light themes.
9. Auto-update: the mod keeps itself current. At start and every 6 hours it checks the public repository's latest release (one request to the GitHub releases API, no account or session data, skipped when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set). A newer release installs by itself through `claude plugin update` between turns (never during a turn) and the mod reloads in place; the pane shows one line, "Updated to 1.2.0", for a minute. A failed update keeps the running version, retries at the next check, and after 3 failures shows "Update failed" with a manual command. A release that changes the schema migrates the stored state, so an update never empties the pane. A copy installed from a folder (development) never updates itself. Metrics events: `update_ok`, `update_failed` (code only).
10. Release: public repository with a marketplace file, MIT licence, credit to plan-progress (MIT), a public field list for the metrics, no SECURITY.md.

## Not in v1
Terminal and VS Code views. Tickets and ticket readers. User settings beyond the metrics on and off command, auto-update and saveTemplate. Team or shared views across machines.

## Backlog
- Summarize and Status buttons on each stage card and item card. A press starts a side chat for the session with one focused question: Summarize explains what the card's work found or changed (how the bug was reproduced, the root cause, what the fix changed); Status says where that card stands now and what it waits on. The person gets a focused answer for any card as it runs, without following the main chat.

## How the state stays current
| Trigger | Who acts | What changes |
|---|---|---|
| First turn of real work | Agent, by a standing rule in its instructions | Picks the type and sends the first full state; the pane opens |
| The 5th tool call with no agent state | Pane | Opens by itself with the Custom type built from the task list, marked "Waiting for the agent", and sends the reminder at once |
| Every meaningful change | Agent, same rule | Sends the full state; looks again at the stages and the type |
| After each context compaction | Pane | Puts the standing rule back into the agent's context |
| Task list changes, tool calls, turn start and end | Pane, no agent call | Items, status words, timers |
| Every 5 s (helpers, then a settle of every status) / once a minute per open pull request, pane open or not | Pane, no agent call | Helpers, pull requests, CI |
| 5 s after the last tool call, and at each turn end | Marker (Haiku in Claude Code) | Marks and new steps, kept when two calls agree |
| Stale: 10 minutes of tool calls, or 3 new task steps, with no agent update | Pane, only where the marker is off | Adds a one-line reminder to the agent's next step |
| Every 2 minutes with no agent update, while items are in progress | Pane, only where the marker is off | Adds a check that names the items still in progress |
| A turn ends while stale, or after work with no update | Pane, only where the marker is off | Holds the end of the turn once and asks the agent for an update; after 2 ignored reminders the pane shows "May be out of date" |
| The person presses Update | Person | Asks the agent for a fresh full state |
Status words and items update as small patches. Tests measure the tokens of each agent update and fail above 2,000 tokens for a 30-item state.

## Metrics
- Sent only after consent; `/pane-metrics off` and `/pane-metrics on` change the choice at any time.
- Allowlist only: words from fixed lists, counts and durations. Errors are codes, never message text. A test fails if any event field holds free text.
- Never sent: goal text, stage or item names, file names, branch names, commands, pull request titles, links, session titles, session ids, repository names, paths, account ids. One id is allowed: `distinct_id`, a random UUID v4 made on the device at first consent and deleted by the off command. The privacy test fails on any other field whose value looks like an id or a path, and a second test proves that session ids and account ids never appear in any event.
- PostHog Cloud US, one PostHog project, `product: "mission-status"` on each event, `$process_person_profile: false`, `$geoip_disable: true`, project set to discard IP, no autocapture, no session recording, no SDK, a random install id that the off command deletes.
- The field list is in the public repository and linked from the consent screen.
- Respects `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Sends at most one batch a minute; drops on failure.

## Success measures (first 30 days)
| Measure | Definition | Target |
|---|---|---|
| Progress asks | Prompts sorted as progress questions by a fixed, published, local word list, per real-work session, followed over time. No holdback and no comparison group (owner, 2026-11-25). Event: `progress_ask` (yes or no) | falls over time |
| Adoption | Share of real-work sessions (by tool calls) that show a pane. Events: `session_real_work`, `pane_shown` | 80% |
| Usage | Installs (unique `distinct_id`; one install is one device), sessions that showed the pane (`pane_shown`), projects tracked (unique `project_id` per install, from `project_tracked`), pull requests tracked (unique `pr_id` per install, from `pr_tracked`) | followed, no target |
| Accuracy | Share of agent updates whose current stage holds the open task-list step; the device computes it and sends yes or no. Event: `update_accuracy` | 90% |
| Freshness | Share of stale reminders followed by an update within 3 steps. Events: `stale_reminder`, `update_after_reminder` | 90% |
| Health | Render errors per 1,000 renders. Events: `render` (count), `render_error` (code) | under 1 |

## Done when
A fresh Mac installs it from the public marketplace with one command; every real-work session shows the pane; all ten templates render in the owner's app (the nine type blocks and subsessions are not built) and pass his look check; a bad state keeps the last good view; one live test each passes for auto-update (an older install updates to a new release by itself and keeps its state), the compaction rule, the stale reminder, the held turn end, the auto-open at the 5th tool call, a crashed child (shows Stopped) and a cloud child (shows "state not available here"), with results reported as counts; an unknown app version falls back to plain text with a clear message; tests and a front-end review pass; the owner approves the public release.

## Order
Schema and triggers -> (types, subsessions, metrics, onboarding) in parallel -> (core polish, Merge card cases, light theme) in parallel -> packaging -> release checks. The name, brand and site run in their own session.

## Risks
- Only the owner can see the pane in the real app; each type needs one look from him.
- The look depends on this desktop app build; older builds fall back to plain text.
- The agent may not update; covered by the triggers above.
- A shared store between sessions is local to one machine; cloud subsessions show as "state not available here". Only the person's own account can read the store; it never sits in a repository folder; entries of sessions that ended more than 7 days ago are deleted.

## Open decision for the owner
The name.
