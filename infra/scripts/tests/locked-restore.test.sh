#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT

cp -R "$repository_root/src/plugins/jellyfin" "$temporary_dir/jellyfin"
cp "$repository_root/global.json" "$temporary_dir/global.json"
project="$temporary_dir/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj"
sed -i 's/Newtonsoft.Json" Version="13.0.3/Newtonsoft.Json" Version="13.0.2/' "$project"

set +e
output=$(docker run --rm \
    -v "$temporary_dir:/work" \
    -w /work \
    mcr.microsoft.com/dotnet/sdk:9.0@sha256:35048e3a81e6a07c316e7bbbd80d80d2ba705fe5f23a8ed42b6638c8f4c20d30 \
    dotnet restore jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj --locked-mode 2>&1)
status=$?
set -e
if [ "$status" -eq 0 ]; then
    printf '%s\n' 'locked restore unexpectedly accepted package drift' >&2
    exit 1
fi
if ! printf '%s\n' "$output" | grep -q 'NU1004'; then
    printf '%s\n' 'locked restore failed for an unexpected reason' >&2
    printf '%s\n' "$output" >&2
    exit 1
fi
