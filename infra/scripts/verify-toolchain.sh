#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
global_file=${GLOBAL_FILE:-$repository_root/global.json}
workflow_dir=${WORKFLOW_DIR:-$repository_root/.github/workflows}
image_pattern='mcr\.microsoft\.com/dotnet/sdk:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}'

fail() {
    echo "Toolchain verification failed: $*" >&2
    exit 1
}

# 1. Every pinned SDK image reference in the tree must be byte-identical.
mapfile -t references < <(
    grep -rIHoE \
        --exclude-dir=.git \
        --exclude-dir=.worktrees \
        --exclude-dir=.tmp-test \
        --exclude-dir=target \
        --exclude-dir=bin \
        --exclude-dir=obj \
        --exclude-dir=node_modules \
        --exclude-dir=dist \
        --exclude-dir=_site \
        -- "$image_pattern" "$repository_root" 2>/dev/null || true
)

(( ${#references[@]} > 0 )) || fail "no pinned .NET SDK image reference matching $image_pattern was found"

mapfile -t distinct_references < <(
    printf '%s\n' "${references[@]}" | sed -E 's/^[^:]+://' | LC_ALL=C sort -u
)

if (( ${#distinct_references[@]} != 1 )); then
    echo "Toolchain verification failed: the pinned .NET SDK image has ${#distinct_references[@]} distinct values" >&2
    for reference in "${distinct_references[@]}"; do
        echo "  $reference" >&2
        printf '%s\n' "${references[@]}" | grep -F -- ":$reference" | sed -E 's/^/    /' >&2
    done
    exit 1
fi

image=${distinct_references[0]}
digest=${image##*@}

# 2. The image must provide the SDK that global.json pins.
[[ -f $global_file ]] || fail "global.json is missing at $global_file"
global_sdk=$(jq -er '.sdk.version' "$global_file") || fail "$global_file does not define .sdk.version"

if ! command -v docker >/dev/null 2>&1; then
    fail "Docker is required to read the SDK version from $image; install Docker (or start the daemon) and retry"
fi

if ! image_sdk=$(docker run --rm --entrypoint dotnet "$image" --version 2>/dev/null); then
    fail "could not read the SDK version from $image; ensure Docker is running and the pinned image is reachable"
fi
image_sdk=$(printf '%s' "$image_sdk" | tr -d '[:space:]')
[[ -n $image_sdk ]] || fail "$image did not report an SDK version"

[[ $image_sdk == "$global_sdk" ]] || \
    fail "global.json pins SDK $global_sdk but $image reports SDK $image_sdk"

# 3. Every workflow must install the same SDK that global.json pins.
[[ -d $workflow_dir ]] || fail "workflow directory $workflow_dir is missing"

shopt -s nullglob
workflow_files=("$workflow_dir"/*.yml "$workflow_dir"/*.yaml)
shopt -u nullglob
(( ${#workflow_files[@]} > 0 )) || fail "no workflow files found in $workflow_dir"

for workflow in "${workflow_files[@]}"; do
    while IFS= read -r workflow_sdk; do
        [[ $workflow_sdk == "$global_sdk" ]] || \
            fail "${workflow#"$repository_root/"} pins dotnet-version '$workflow_sdk' but global.json pins '$global_sdk'"
    done < <(grep -oE "dotnet-version:[[:space:]]*['\"]?[^'\"[:space:]]+" "$workflow" \
        | sed -E "s/^dotnet-version:[[:space:]]*['\"]?//" || true)
done

printf 'Toolchain pins agree: %s (digest %s) provides .NET SDK %s\n' "$image" "$digest" "$image_sdk"
