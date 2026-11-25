# mission-status

Know where your agent stands, without reading through its work.

mission-status is a live progress pane for Claude Code in the Claude desktop app. It sits beside the chat and shows the goal, the stages, what done means for each stage, and where the work is right now. The agent keeps it current, so you never ask "where are we?" again.

The chat goes quiet. You hear from the agent only when something changed or needs you: a decision, an approval, or a step only you can do.

## Install

In a Claude Code session in the desktop app, run:

```
/plugin marketplace add oficiallyAkshay/mission-status
/plugin install mission-status@mission-status
```

The pane opens by itself once a session does real work. `/mission-status` opens it at any time.

It needs the Claude desktop app. The terminal and the editor extensions show no pane.

## What the pane shows

| Part | What it tells you |
|---|---|
| The goal | One sentence: what the session is for |
| The stage track | Every stage on one line, with the current one lit |
| Stage cards | Each stage's state, its time, and what the agent is doing now |
| Done when | For each stage, what finished means |
| Items | The work inside a stage: done, now, next |
| Links | Plans, documents, Claude artifacts and pages, on the stage that made them |
| Helpers | The helpers that run now, and for how long |

## Any kind of work

The agent picks a template, or writes its own stages when none fits. It can add, remove or rename stages at any time, and the pane changes shape with it.

| Template | Stages |
|---|---|
| Feature | Plan, Build, Test, Deploy, Learn |
| Product loop | Plan, Build, Review, Deploy, Monitor, Iterate |
| Bug fix | Reproduce, Find cause, Fix, Test, Deploy |
| Incident | Detect, Triage, Mitigate, Root cause, Fix, Review |
| Research | Question, Gather, Analyze, Synthesize, Report |
| Design | Brief, Explore, Pick, Refine, Hand off |
| Board batch | Intake, Plan, Build, Review, Merge |
| Writing | Outline, Draft, Review, Publish |
| Migration | Plan, Dry run, Migrate, Verify, Clean up |

## What it costs

Most of the pane is read by code and costs no tokens: the task list, helpers and timers. Only a stage change asks the agent, in one short update call.

## Privacy

Anonymous usage metrics are off until you say yes, once, in onboarding. `/pane-metrics off` turns them off at once. Every event and field is listed in [docs/telemetry.md](docs/telemetry.md). Nothing is sent when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

## Updates

The plugin keeps itself current: it checks this repository's latest release at start and every six hours, and installs a newer one between turns. A copy installed from a folder never updates itself.

## Uninstall

```
/plugin uninstall mission-status@mission-status
```

## Develop

- The plugin: `plugins/mission-status/` (hooks in `hooks/`, the contract in `types/index.d.ts`, tests in `tests/`).
- Checks: `scripts/check.sh` runs `claude plugin validate` and `claude plugin test` with the desktop app's own engine.
- A change to the plugin raises `version` in `plugins/mission-status/.claude-plugin/plugin.json`; CI fails the pull request otherwise. Each merged version becomes a release.
- The site: `site/`.

## Licence

MIT. See [LICENSE](LICENSE).
