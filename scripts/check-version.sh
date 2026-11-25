#!/bin/bash
# Fails when a change to the plugin keeps the plugin's version. Each merged plugin change is a release, and the
# installed copies update themselves only to a newer version (see the auto-update section of docs/product-plan.md).
# Usage: scripts/check-version.sh <base commit> <head commit>
set -euo pipefail
base="$1"; head="$2"
manifest=plugins/mission-status/.claude-plugin/plugin.json
if git diff --quiet "$base" "$head" -- plugins/mission-status; then
  echo "[$(date -u +%FT%TZ)] the plugin is unchanged: no new version needed"
  exit 0
fi
version_at() { git show "$1:$manifest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }
before=$(version_at "$base"); after=$(version_at "$head")
if [ "$before" = "$after" ]; then
  echo "[$(date -u +%FT%TZ)] the plugin changed but its version is still $after: raise \"version\" in $manifest" >&2
  exit 1
fi
echo "[$(date -u +%FT%TZ)] plugin version $before -> $after"
