#!/usr/bin/env bash
set -euo pipefail

repository_root=${REPOSITORY_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
gitleaks_image='zricethezav/gitleaks:v8.30.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb'

docker run --rm \
    --volume "$repository_root:/repository" \
    --workdir /repository \
    "$gitleaks_image" \
    git --redact --config .gitleaks.toml --baseline-path .gitleaks-baseline.json
