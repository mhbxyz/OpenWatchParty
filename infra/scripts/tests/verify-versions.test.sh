#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
verify_script="$repository_root/infra/scripts/verify-versions.sh"
version=$(jq -er '.version' "$repository_root/version.json")
jellyfin_image=$(jq -er '.jellyfinImageVersion' "$repository_root/version.json")
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

"$verify_script" "v$version"

if "$verify_script" "v${version}-mismatch"; then
    echo 'Mismatched release tag was accepted' >&2
    exit 1
fi

jq '.version = "9.9.9"' "$repository_root/version.json" > "$temporary_dir/version.json"
if VERSION_FILE="$temporary_dir/version.json" "$verify_script"; then
    echo 'Divergent canonical version was accepted' >&2
    exit 1
fi

cp -R "$repository_root/docs" "$temporary_dir/docs"
cp "$repository_root/README.md" "$temporary_dir/README.md"
sed -i "s/Jellyfin-$jellyfin_image-/Jellyfin-9.9.9-/" "$temporary_dir/README.md"
if DOCUMENTATION_ROOT="$temporary_dir/docs" README_FILE="$temporary_dir/README.md" "$verify_script"; then
    echo 'Divergent documented version was accepted' >&2
    exit 1
fi
