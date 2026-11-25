# Contributing

Thank you for helping. mission-status is a Claude Code mod: one plugin, tested with the engine that the Claude desktop app ships. Back to the [README](../README.md).

## Install and remove

In a Claude Code session in the Claude desktop app:

```
/plugin marketplace add oficiallyAkshay/mission-status
/plugin install mission-status@mission-status
```

The pane opens by itself once a session does real work, and `/mission-status` opens it at any time. To remove it:

```
/plugin uninstall mission-status@mission-status
```

## Commands

| Command | What it does |
|---|---|
| `/mission-status` | Opens the pane |
| `/mission-status-welcome` | Shows the onboarding again |
| `/pane-metrics on` or `off` | Turns the anonymous usage counts on or off |

## Templates

The pane ships ten templates. The agent picks one, or writes its own stages when none fits. It can add, remove or rename stages at any time, and save a set of stages as a personal template.

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
| Plan review | Intake, Draft, Review waves, Your rows, Hand off |

## Updates and cost

The plugin checks this repository's latest release at start and every six hours, and installs a newer one between turns. A copy installed from a folder never updates itself. Most of the pane is read by code and costs no tokens: the task list, helpers, git and timers. Three things ask the agent for an update: a stage change, a reminder when the state is stale, and the hold of a turn end. The reminder and the hold each ask the agent to call the update tool once.

## Workflows

| Workflow | What it does |
|---|---|
| ci | Lints the workflows, scans for secrets, validates and tests the plugin, and checks that the version moved |
| release | Tags and releases each new plugin version on main |
| clonometer | Counts clones and views every hour onto the badges branch; it needs the TRAFFIC_TOKEN secret |

## Before you start

- Open an issue first for a new feature, so the shape is agreed before the work.
- A small fix (a typo, a wrong colour, a clear bug) can go straight to a pull request.

## Set up

1. Install the Claude desktop app. Its engine runs the checks, so the API matches what people use.
2. Clone the repository.
3. Run the checks:

```
scripts/check.sh
```

The script validates the plugin, type-checks it when `CC_TYPES` names the engine's `claude-code.d.ts`, and runs the tests.

To see the pane while you work, copy the plugin into a session's mods folder with `scripts/sync-dev.sh <folder>`. The desktop app reloads it when the turn ends.

## Rules for a pull request

- Raise `version` in `plugins/mission-status/.claude-plugin/plugin.json` when you change the plugin. CI fails otherwise, and each merged version becomes a release.
- Add or change a test for each behaviour you change. The test must fail without your change.
- Never weaken or skip a test to make CI pass.
- Keep text plain: short sentences, active voice, no jargon.
- Metrics stay anonymous. A new event or field needs a matching row in `docs/telemetry.md`, and the privacy tests must still pass.
- No secrets, keys, personal names or local paths in code, tests or docs.

## Layout

| Path | What it holds |
|---|---|
| `plugins/mission-status/hooks/` | The mod: `register.tsx` is the entry, `view.tsx` draws the pane, `model.ts` holds the state rules |
| `plugins/mission-status/types/index.d.ts` | The state contract |
| `plugins/mission-status/tests/` | The tests, run by `claude plugin test` |
| `docs/` | The product plan, the telemetry field list and the README's pictures |
| `scripts/` | Checks and the development copy |

## Licence

By contributing, you agree that your work is released under the MIT licence of this repository.
