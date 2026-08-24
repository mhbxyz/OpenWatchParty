#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

manifest="$temporary_dir/manifest.json"
archive="$temporary_dir/OpenWatchParty-v1.2.3.zip"
marker="$temporary_dir/injected"
cat > "$manifest" <<'JSON'
[{"guid":"test","versions":[]}]
JSON
printf 'plugin archive' > "$archive"

changelog=$(printf '%s\n' \
    "Quotes: \"double\" and 'single'" \
    "Shell: \$(touch \"$marker\") \`touch \"$marker\"\`" \
    'Unicode: sécurité 日本語')
timestamp='2026-08-24T08:00:00Z'
"$script_dir/update-plugin-manifest.sh" "$manifest" "$archive" 'v1.2.3' "$changelog" "$timestamp"

[[ ! -e $marker ]]
[[ $(jq -r '.[0].versions[0].version' "$manifest") == '1.2.3' ]]
[[ $(jq -r '.[0].versions[0].changelog' "$manifest") == "$changelog" ]]
[[ $(jq -r '.[0].versions[0].timestamp' "$manifest") == "$timestamp" ]]
[[ $(jq -r '.[0].versions[0].sourceUrl' "$manifest") == 'https://github.com/mhbxyz/OpenWatchParty/releases/download/v1.2.3/OpenWatchParty-v1.2.3.zip' ]]
read -r expected_checksum _ < <(md5sum "$archive")
[[ $(jq -r '.[0].versions[0].checksum' "$manifest") == "$expected_checksum" ]]

for malicious_tag in \
    "v1.2.3;touch \"$marker\"" \
    "v1.2.3-\$(touch \"$marker\")" \
    "v1.2.3-\`touch \"$marker\"\`" \
    $'v1.2.3\nbad'; do
    if "$script_dir/update-plugin-manifest.sh" "$manifest" "$archive" "$malicious_tag" 'bad tag'; then
        echo "Malicious release tag was accepted: $malicious_tag" >&2
        exit 1
    fi
done
[[ ! -e $marker ]]
