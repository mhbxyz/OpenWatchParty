#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
    echo "Usage: $0 MANIFEST ZIP RELEASE_TAG CHANGELOG [TIMESTAMP]" >&2
    exit 2
fi

manifest=$1
zip_file=$2
release_tag=$3
changelog=$4
timestamp=${5:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}
version=${release_tag#v}
repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
version_file=${VERSION_FILE:-$repository_root/version.json}
expected_version=$(jq -er '.version' "$version_file")
target_abi=$(jq -er '.jellyfinTargetAbi' "$version_file")

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "Invalid release tag: $release_tag" >&2
    exit 2
fi
if [[ $version != "$expected_version" ]]; then
    echo "Release version $version does not match version.json ($expected_version)" >&2
    exit 2
fi
if [[ ! -f $manifest || ! -f $zip_file ]]; then
    echo "Manifest or plugin archive does not exist" >&2
    exit 2
fi

read -r checksum _ < <(md5sum -- "$zip_file")
archive_name=$(basename -- "$zip_file")
source_url="https://github.com/mhbxyz/OpenWatchParty/releases/download/${release_tag}/${archive_name}"
temporary_file=$(mktemp "${manifest}.tmp.XXXXXX")
trap 'rm -f -- "$temporary_file"' EXIT

jq --arg version "$version" \
   --arg checksum "$checksum" \
   --arg timestamp "$timestamp" \
   --arg changelog "$changelog" \
   --arg source_url "$source_url" \
   --arg target_abi "$target_abi" \
   '.[0].versions = [{
      "version": $version,
      "changelog": $changelog,
      "targetAbi": $target_abi,
      "sourceUrl": $source_url,
      "checksum": $checksum,
      "timestamp": $timestamp
    }] + (.[0].versions | map(select(.version != $version)))' \
   "$manifest" > "$temporary_file"

mv -- "$temporary_file" "$manifest"
trap - EXIT
