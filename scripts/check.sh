#!/bin/bash
# Runs the three checks on the plugin: validate, type-check, tests. Output streams and is kept in /tmp.
# CC_TYPES: the engine's claude-code.d.ts (the plugin-authoring skill prints its path when it loads).
# CLAUDE_BIN: the claude engine to validate and test with; use the desktop app's own engine, for the same API.
CLAUDE="${CLAUDE_BIN:-$(ls -d "$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1)}"
[ -x "$CLAUDE" ] || CLAUDE=claude
set -o pipefail
cd "$(dirname "$0")/../plugins/mission-status" || exit 2
LOG=/tmp/mission-status-check-$(date +%s).log
{
  echo "[$(date -u +%FT%TZ)] engine $("$CLAUDE" --version 2>/dev/null)"; echo "[$(date -u +%FT%TZ)] validate"; "$CLAUDE" plugin validate . 2>&1 | grep -E "✘|✔|❯" 
  if [ -n "$CC_TYPES" ] && [ -f "$CC_TYPES" ]; then
    TMP=$(mktemp -d); FILES=$(ls hooks/*.ts hooks/*.tsx types/index.d.ts | sed "s#^#\"$PWD/#; s#\$#\"#" | paste -sd, -)
    printf '{"compilerOptions":{"target":"es2023","lib":["es2023"],"types":[],"module":"esnext","moduleResolution":"bundler","strict":true,"noUncheckedIndexedAccess":true,"noEmit":true,"skipLibCheck":true,"jsx":"react","jsxFactory":"h","jsxFragmentFactory":"Fragment"},"files":["%s",%s]}' "$CC_TYPES" "$FILES" > "$TMP/tsconfig.json"
    echo "[$(date -u +%FT%TZ)] type-check"; npx -y -p typescript@5.6.3 tsc -p "$TMP" 2>&1 && echo "type-check clean"
  else echo "type-check skipped: set CC_TYPES"; fi
  echo "[$(date -u +%FT%TZ)] tests"; "$CLAUDE" plugin test . 2>&1 | tail -4
} 2>&1 | tee "$LOG"
