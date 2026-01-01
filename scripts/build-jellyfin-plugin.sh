#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN_DIR="$ROOT_DIR/plugins/jellyfin/OpenSyncParty"
DIST_DIR="$PLUGIN_DIR/dist"

cd "$PLUGIN_DIR"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "dotnet SDK not found. Use: make build-plugin"
  exit 1
fi

mkdir -p "$DIST_DIR"

dotnet restore

dotnet publish -c Release -o "$DIST_DIR" OpenSyncPartyPlugin.csproj

echo "Plugin built in $DIST_DIR"
