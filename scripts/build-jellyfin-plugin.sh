#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN_DIR="$ROOT_DIR/plugins/jellyfin/OpenSyncParty"
DIST_DIR="$PLUGIN_DIR/dist"
CLIENT_JS="$ROOT_DIR/clients/web-plugin/plugin.js"
EMBEDDED_JS="$PLUGIN_DIR/Web/plugin.js"

cd "$PLUGIN_DIR"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "dotnet SDK not found. Use: make build-plugin"
  exit 1
fi

mkdir -p "$DIST_DIR"

cp "$CLIENT_JS" "$EMBEDDED_JS"

dotnet restore

dotnet publish -c Release -o "$DIST_DIR" OpenSyncPartyPlugin.csproj

echo "Plugin built in $DIST_DIR"
