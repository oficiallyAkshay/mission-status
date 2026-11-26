<p align="center"><img src="site/mark.png" alt="" width="96" height="96"></p>

<h1 align="center">mission-status</h1>

<p align="center"><b>Know where your agent stands, without reading through its work.</b></p>

<p align="center"><img src="docs/assets/progress-tab.png" alt="A Claude desktop window with the mission-status pane open beside the chat, on its Progress tab: the goal, the stages, what each stage needs to be done, and the work running now" width="800"></p>

<p align="center"><a href="https://oficiallyakshay.github.io/mission-status/"><b>Website</b></a> · <a href="#install">Install</a> · <a href="docs/telemetry.md">Usage counts</a></p>

<p align="center">
  <a href="https://github.com/oficiallyAkshay/mission-status/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/oficiallyAkshay/mission-status/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/oficiallyAkshay/mission-status/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/oficiallyAkshay/mission-status/actions/workflows/codeql.yml/badge.svg?branch=main"></a>
  <a href="https://www.bestpractices.dev/projects/17127"><img alt="OpenSSF Best Practices" src="https://www.bestpractices.dev/projects/17127/badge"></a>
  <a href="https://github.com/oficiallyAkshay/mission-status/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/oficiallyAkshay/mission-status?color=8B7CF6"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-2f6f4e?logo=opensourceinitiative&logoColor=white"></a>
  <a href="https://github.com/oficiallyAkshay/clonometer"><img alt="clones of this repository, last seven days and all time" src="https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/oficiallyAkshay/mission-status/badges/clones.json&query=$.badge&label=clones&logo=github&logoColor=white"></a>
</p>

<p align="center">Works with<br>
  <a href="https://github.com/anthropics/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-1e1b4b?logo=claude&logoColor=white"></a>
</p>

## Features

mission-status is a live progress pane for Claude Code in the Claude desktop app. It sits beside the chat and shows the goal, the stages, what done means for each stage, and where the work is right now.

The pane has four levels: a **card** for each stage, **steps** inside a card, **sub-steps** under a step, and **sub-sub-steps** on one line under a sub-step (they pulse together when they run side by side). A step that waits on you shows an amber badge and "Needs you".

<p align="center">👀<br><b>Read in a glance</b><br>The goal, the current stage and its gate show on one screen, so you never ask "where are we?" again.</p>

<p align="center">🧭<br><b>Fits any work</b><br>Features, bug fixes, incidents, research or your own saved stages: the pane changes shape with the work.</p>

<p align="center">🔁<br><b>Stays current</b><br>One state machine shows only what runs now and ends work from facts; a small model in Claude Code keeps the steps current between agent updates.</p>

<p align="center">🤫<br><b>A quiet chat</b><br>The chat holds only what needs you: a decision, an approval, or a step only you can do.</p>

<p align="center">🔒<br><b>Private stays private</b><br>Usage counts are anonymous, never hold your words, files or names, and turn off with one command. The step marker sends only tool names and step names to your own session's model, and stays off when nonessential traffic is off.</p>

<p align="center">📊<br><b>Live numbers</b><br>Git, pull requests, checks and helpers come from their own sources; pull requests stay current even while the pane is closed.</p>

## Fit

**Use it when**
- your sessions run long, with several stages, helpers and pull requests;
- you want to follow a session without reading the chat;
- you follow a runbook or a checklist and want each step tracked.

**Look elsewhere when**
- you work in the terminal or an editor: the pane shows only in the Claude desktop app;
- you want progress bars above the prompt: [zycck/claude-mods](https://github.com/zycck/claude-mods) draws those.

## Install

Install it from a Claude Code session in the Claude desktop app:

```
/plugin marketplace add oficiallyAkshay/mission-status
/plugin install mission-status@mission-status
```

The pane opens by itself once a session does real work, and `/mission-status` opens it at any time.

## How it compares

| | [oficiallyAkshay/mission-status](https://github.com/oficiallyAkshay/mission-status) | [zycck/claude-mods](https://github.com/zycck/claude-mods) |
|---|---|---|
| Place | Side pane | Above prompt |
| Stage gates | ✅ | ❌ |
| Merge state | ✅ | ❌ |
| Runbook tabs | ✅ | ❌ |
| Quiet chat | ✅ | ❌ |
| Terminal | ❌ | ✅ |
| Sounds | ❌ | ✅ |

## Security and limits

No credential needed. The pane runs inside Claude Code on your machine, and it calls no model of its own.

- ❎ sends your prompts, goals, files, branch names or paths anywhere
- ❎ names your account or session in any event
- ❎ installs an update during a turn


By default anonymous usage counts are on after the onboarding shows them; `/pane-metrics off` stops them, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` stops every send. Every event and field is listed in [docs/telemetry.md](docs/telemetry.md). By default the plugin updates itself between turns; the onboarding switch or the pane's Turn on auto-update button sets it.
