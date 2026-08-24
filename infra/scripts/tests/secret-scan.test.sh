#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
repository="$temporary_dir/repository"

mkdir -p "$repository"
cp "$root/.gitleaks.toml" "$root/.gitleaks-baseline.json" "$repository/"
printf '.env\n' > "$repository/.gitignore"

git -C "$repository" init --quiet
git -C "$repository" config user.name 'Secret Scan Test'
git -C "$repository" config user.email 'secret-scan@example.invalid'
git -C "$repository" add .gitignore .gitleaks.toml .gitleaks-baseline.json
git -C "$repository" commit --quiet -m 'Initialize fixture'

fake_secret='aB3dE5gH7jK9mN2pQ4sT6vW8yZ0cD1fG'
printf 'api_key = "%s"\n' "$fake_secret" > "$repository/.env"
git -C "$repository" add --all
if git -C "$repository" ls-files --error-unmatch .env >/dev/null 2>&1; then
    echo '.env was unexpectedly added to the Git index' >&2
    exit 1
fi
git -C "$repository" check-ignore --quiet .env
REPOSITORY_ROOT="$repository" "$root/infra/scripts/scan-secrets.sh" >/dev/null

printf 'api_key = "%s"\n' "$fake_secret" > "$repository/leaked.txt"
git -C "$repository" add leaked.txt
git -C "$repository" commit --quiet -m 'Add synthetic leak'
if REPOSITORY_ROOT="$repository" "$root/infra/scripts/scan-secrets.sh" >/dev/null 2>&1; then
    echo 'Gitleaks accepted a committed synthetic secret' >&2
    exit 1
fi
