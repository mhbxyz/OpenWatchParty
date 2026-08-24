#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

manifest="$temporary_dir/manifest.json"
repository_root=$(cd -- "$script_dir/../.." && pwd)
version=$(jq -er '.version' "$repository_root/version.json")
target_abi=$(jq -er '.jellyfinTargetAbi' "$repository_root/version.json")
release_tag="v$version"
archive="$temporary_dir/OpenWatchParty-${release_tag}.zip"
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
"$script_dir/update-plugin-manifest.sh" "$manifest" "$archive" "$release_tag" "$changelog" "$timestamp"

[[ ! -e $marker ]]
[[ $(jq -r '.[0].versions[0].version' "$manifest") == "$version" ]]
[[ $(jq -r '.[0].versions[0].changelog' "$manifest") == "$changelog" ]]
[[ $(jq -r '.[0].versions[0].timestamp' "$manifest") == "$timestamp" ]]
[[ $(jq -r '.[0].versions[0].targetAbi' "$manifest") == "$target_abi" ]]
[[ $(jq -r '.[0].versions[0].sourceUrl' "$manifest") == "https://github.com/mhbxyz/OpenWatchParty/releases/download/${release_tag}/OpenWatchParty-${release_tag}.zip" ]]
read -r expected_checksum _ < <(md5sum "$archive")
[[ $(jq -r '.[0].versions[0].checksum' "$manifest") == "$expected_checksum" ]]

for malicious_tag in \
    "${release_tag};touch \"$marker\"" \
    "${release_tag}-\$(touch \"$marker\")" \
    "${release_tag}-\`touch \"$marker\"\`" \
    "${release_tag}"$'\nbad'; do
    if "$script_dir/update-plugin-manifest.sh" "$manifest" "$archive" "$malicious_tag" 'bad tag'; then
        echo "Malicious release tag was accepted: $malicious_tag" >&2
        exit 1
    fi
done
[[ ! -e $marker ]]

if "$script_dir/update-plugin-manifest.sh" "$manifest" "$archive" "v${version}-mismatch" 'wrong version'; then
    echo 'Mismatched release version was accepted' >&2
    exit 1
fi
