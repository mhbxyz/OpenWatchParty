#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
output_file="$temporary_dir/meta.json"

"$repository_root/infra/scripts/write-plugin-meta.sh" "$output_file"

expected_version="$(jq -er '.version' "$repository_root/version.json").0"
expected_abi=$(jq -er '.jellyfinTargetAbi' "$repository_root/version.json")
[[ $(jq -er '.version' "$output_file") == "$expected_version" ]]
[[ $(jq -er '.targetAbi' "$output_file") == "$expected_abi" ]]
[[ $(jq -er '.guid' "$output_file") == '0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d' ]]
