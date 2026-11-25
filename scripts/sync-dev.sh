#!/bin/bash
# Copies the plugin into a Claude session's dev-mods folder, where the desktop app hot-reloads it.
# usage: sync-dev.sh <dev-mods session folder>
[ -d "$1" ] || { echo "usage: sync-dev.sh <dev-mods session folder>"; exit 2; }
SRC="$(dirname "$0")/../plugins/progress-pane"
rsync -a --delete --exclude '.claude-plugin/types/' "$SRC/" "$1/progress-pane/" && echo "synced to $1/progress-pane"
