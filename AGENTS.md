# AGENTS.md

Guidance for coding agents that work in this repository.

## What this is

A Claude Code mod: a live progress pane beside the chat in the Claude desktop app. The code is one hooks module in `plugins/mission-status/hooks/`, started from `register.tsx`.

## Engine rules that bite

- `register.tsx` is the only module in `hooks/hooks.json`; each part exposes a `registerX(on)` function that it calls.
- `$` may be passed only to function declarations across files, never to an arrow function bound to a const.
- Each file declares the stored values (atoms) it reads, with the same plugin and key; atoms are not imported.
- Two hooks on one event need different matchers.
- An `Svg` with an empty `alt` is dropped on the desktop. A variable named `h` hides the JSX factory.
- Drawings get ids from a hash of their input, so an unchanged drawing does not flicker.

## Checks

- Run `scripts/check.sh` before a pull request; it is the only type-check, as CI cannot get the engine's types. It finds them beside a loaded dev copy, or set `CC_TYPES` to the engine's `claude-code.d.ts`. It fails on unused locals.
- `ui.find` ignores `alt` and `href`: use `findAll` and filter in the test.
- Tests that advance many minutes of virtual time set `timeoutMs`.

## Pull requests

- Raise the plugin `version` with every plugin change; CI checks it.
- One behaviour change, one named test that fails without it.
- Keep `docs/telemetry.md` in step with every metrics field.
- Write plain English. Put no secrets, personal names or local paths in the repository.
- A change to how the pane draws is checked in the desktop app before the pull request, and the body says what was seen. A layout fix is measured from the rendered tree, not guessed.
- A revert ships as its own pull request that gives its reason.
