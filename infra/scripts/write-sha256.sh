#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 && -f $1 ]] || {
    echo "Usage: $0 ARTIFACT CHECKSUM_FILE" >&2
    exit 2
}

artifact=$1
checksum_file=$2
artifact_name=$(basename -- "$artifact")
[[ $artifact_name != *$'\n'* && $checksum_file != "$artifact" ]] || exit 2

checksum=$(sha256sum -- "$artifact")
checksum=${checksum%% *}
temporary_file=$(mktemp "${checksum_file}.tmp.XXXXXX")
trap 'rm -f -- "$temporary_file"' EXIT
printf '%s  %s\n' "$checksum" "$artifact_name" > "$temporary_file"
mv -- "$temporary_file" "$checksum_file"
trap - EXIT
