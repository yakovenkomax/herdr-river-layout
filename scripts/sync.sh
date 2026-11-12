#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
LAYOUTS=(river)
MODS=(river-create-task river-spaces river-tabs river-pane river-chrome river-changes river-files river-find)
EXCLUDES=(--exclude node_modules --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude '*.error' --exclude .DS_Store)

copy() {
	local from="$1" to="$2"

	for layout in "${LAYOUTS[@]}"; do
		cp "$from/layouts/$layout.json" "$to/layouts/$layout.json"
	done

	for mod in "${MODS[@]}"; do
		mkdir -p "$to/mods/$mod"
		rsync -a --delete "${EXCLUDES[@]}" "$from/mods/$mod/" "$to/mods/$mod/"
	done
}

case "${1:-}" in
	pull)
		copy "$APP_HOME" "$REPO"
		;;
	install)
		copy "$REPO" "$APP_HOME"
		(cd "$APP_HOME/mods/river-changes/shiki" && npm install --silent)
		echo "Merge keys.json into $APP_HOME/keys.json by hand."
		;;
	*)
		echo "Usage: sync.sh pull | install" >&2
		exit 1
		;;
esac
