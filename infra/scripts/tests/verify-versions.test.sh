#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
verify_script="$repository_root/infra/scripts/verify-versions.sh"
version=$(jq -er '.version' "$repository_root/version.json")
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
