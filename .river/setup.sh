#!/bin/sh
set -eu

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

(cd mods/river-changes/shiki && npm ci)

for mod in mods/*/; do
	mod="${mod%/}"
	for file in gpui-kit.d.ts jsconfig.json; do
		if [ -f "$APP_HOME/$mod/$file" ]; then
			cp "$APP_HOME/$mod/$file" "$mod/$file"
		fi
	done
done
