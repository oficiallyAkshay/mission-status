# Contributing

Thank you for helping. mission-status is a Claude Code mod: one plugin, tested with the engine that the Claude desktop app ships.

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
| `docs/` | The product plan and the telemetry field list |
| `scripts/` | Checks and the development copy |

## Licence

By contributing, you agree that your work is released under the MIT licence of this repository.
