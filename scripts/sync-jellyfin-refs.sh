#!/usr/bin/env bash
set -euo pipefail

CONTAINER=${1:-jellyfin-dev}
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REFS_DIR="$ROOT_DIR/plugins/jellyfin/OpenSyncParty/refs"

mkdir -p "$REFS_DIR"

DLLS=(
  MediaBrowser.Controller.dll
  MediaBrowser.Common.dll
  MediaBrowser.Model.dll
)

find_in_container() {
  local name=$1
  docker exec -it "$CONTAINER" sh -lc "find /jellyfin /usr/lib/jellyfin -name $name 2>/dev/null | head -n 1" | tr -d '\r'
}

for dll in "${DLLS[@]}"; do
  path=$(find_in_container "$dll" | tr -d '\r')
  if [ -z "$path" ]; then
    echo "Could not find $dll in container $CONTAINER"
    exit 1
  fi
  docker cp "$CONTAINER:$path" "$REFS_DIR/$dll"
  echo "Synced $dll"
 done

echo "Refs synced to $REFS_DIR"
