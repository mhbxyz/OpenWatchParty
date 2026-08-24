#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
mkdir -p "$temporary_dir/.github/workflows" "$temporary_dir/infra/docker/dev" \
    "$temporary_dir/infra/docker/prod" "$temporary_dir/infra/just"
cat > "$temporary_dir/.github/workflows/test.yml" <<'YAML'
jobs:
  test:
    steps:
      - uses: actions/checkout@11d5960b38c7880c2487e0c4e37ae6063ca640f0 # v4
      - run: |
          ubuntu:latest # openwatchparty/session-server:test
YAML
touch "$temporary_dir/infra/docker/dev/docker-compose.yml" \
    "$temporary_dir/infra/docker/prod/docker-compose.yml" \
    "$temporary_dir/infra/just/empty.just"

if REPOSITORY_ROOT="$temporary_dir" "$repository_root/infra/scripts/verify-pins.sh" >/dev/null 2>&1; then
    echo 'Unpinned Docker Hub image hidden by a comment was accepted' >&2
    exit 1
fi

digest=$(printf 'a%.0s' {1..64})
cat > "$temporary_dir/.github/workflows/test.yml" <<YAML
jobs:
  test:
    steps:
      - uses: actions/checkout@11d5960b38c7880c2487e0c4e37ae6063ca640f0 # v4
      - run: |
          ubuntu:24.04@sha256:$digest
YAML
REPOSITORY_ROOT="$temporary_dir" "$repository_root/infra/scripts/verify-pins.sh" >/dev/null
