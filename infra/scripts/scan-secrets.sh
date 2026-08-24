#!/usr/bin/env bash
set -euo pipefail

repository_root=${REPOSITORY_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
gitleaks_image='zricethezav/gitleaks:v8.30.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb'
mode=${1:-}

case "$mode" in
    '') gitleaks_args=(git --redact --config .gitleaks.toml --baseline-path .gitleaks-baseline.json) ;;
    --staged) gitleaks_args=(git --staged --redact --config .gitleaks.toml) ;;
    *) printf 'Usage: %s [--staged]\n' "$0" >&2; exit 2 ;;
esac

if command -v gitleaks >/dev/null 2>&1; then
    (cd "$repository_root" && gitleaks "${gitleaks_args[@]}")
    exit
fi

docker run --rm \
    --volume "$repository_root:/repository" \
    --workdir /repository \
    "$gitleaks_image" \
    "${gitleaks_args[@]}"
