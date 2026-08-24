#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 && -f $1 && -f $2 ]] || {
    echo "Usage: $0 CHECKSUM_FILE ARTIFACT" >&2
    exit 2
}

checksum_file=$1
artifact=$2
mapfile -t lines < "$checksum_file"
[[ ${#lines[@]} -eq 1 && ${lines[0]} =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || {
    echo "Invalid SHA-256 checksum file: $checksum_file" >&2
    exit 2
}
expected_checksum=${BASH_REMATCH[1]}
expected_name=${BASH_REMATCH[2]}
[[ $expected_name == "$(basename -- "$artifact")" ]] || {
    echo "Checksum filename does not match artifact: $artifact" >&2
    exit 2
}

"$(dirname -- "${BASH_SOURCE[0]}")/verify-sha256.sh" "$artifact" "$expected_checksum"
