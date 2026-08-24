#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 && -f $1 && $2 =~ ^[0-9a-f]{64}$ ]] || exit 2
actual=$(sha256sum -- "$1")
actual=${actual%% *}
[[ $actual == "$2" ]] || { echo "SHA-256 mismatch for $1" >&2; exit 1; }
