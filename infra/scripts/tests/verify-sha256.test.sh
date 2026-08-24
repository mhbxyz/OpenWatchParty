#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
file=$(mktemp)
trap 'rm -f "$file"' EXIT
printf 'archive' > "$file"
hash=$(sha256sum "$file"); hash=${hash%% *}
"$root/infra/scripts/verify-sha256.sh" "$file" "$hash"
if "$root/infra/scripts/verify-sha256.sh" "$file" "$(printf '0%.0s' {1..64})"; then exit 1; fi
printf 'truncated' > "$file"
if "$root/infra/scripts/verify-sha256.sh" "$file" "$hash"; then exit 1; fi
