#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
current_version=$(jq -er '.version' "$repository_root/version.json")
new_version=0.5.0
next_version=0.6.0
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

copy="$temporary_dir/repo"
mkdir -p "$copy"

# Copy the working tree without the heavy or concurrent directories, then make it
# a real git repository so "the tree is unchanged" can be asserted with git.
git -C "$repository_root" ls-files -co --exclude-standard -z -- \
    . ':(exclude).worktrees/**' ':(exclude).tmp-test/**' \
    | tar -C "$repository_root" --null -T - -cf - | tar -xf - -C "$copy"

git -C "$copy" init -q
git -C "$copy" config user.email 'bump-version-test@example.invalid'
git -C "$copy" config user.name 'bump-version test'
git -C "$copy" add -A
git -C "$copy" commit -q -m 'baseline'

bump() {
    "$copy/infra/scripts/bump-version.sh" "$@"
}

assert_clean() {
    local message=$1
    if [[ -n $(git -C "$copy" status --porcelain) ]]; then
        git -C "$copy" status --porcelain >&2
        printf '%s\n' "$message" >&2
        exit 1
    fi
}

assert_literal() {
    local file=$1 literal=$2
    grep -Fq -- "$literal" "$copy/$file" || {
        printf 'Missing mirror value %s in %s\n' "$literal" "$file" >&2
        exit 1
    }
}

# Bumping to the version that is already canonical must be a no-op.
bump "$current_version"
assert_clean 'Bumping to the current version modified the tree'

# A dry run must report changes without writing them.
bump "$new_version" --dry-run >/dev/null
assert_clean 'A dry run modified the tree'

# A real bump must update every mirror and keep verify-versions.sh happy.
bump "$new_version" >/dev/null
"$copy/infra/scripts/verify-versions.sh"

assert_literal 'src/clients/jellyfin-web/manifest.json' "\"version\": \"$new_version\""
assert_literal 'src/plugins/jellyfin/Directory.Build.props' "<OpenWatchPartyVersion>$new_version</OpenWatchPartyVersion>"
assert_literal 'src/server/Cargo.toml' "version = \"$new_version\""
assert_literal 'src/owpctl/Cargo.toml' "version = \"$new_version\""
assert_literal 'README.md' "OpenWatchParty-$new_version-"
assert_literal 'README.md' "alt=\"OpenWatchParty $new_version\""
assert_literal 'docs/operations/installation.md' "OpenWatchParty \`$new_version\`"
assert_literal 'docs/operations/installation.md' "ghcr.io/mhbxyz/owp-session-server:v$new_version"
assert_literal 'docs/operations/installation.md' "OpenWatchParty-v$new_version.zip"
assert_literal 'docs/operations/deployment.md' "OpenWatchParty-v$new_version.zip"
assert_literal 'docs/development/ci.md' "owp-session-server:v$new_version"

grep -A1 '^name = "session-server"' "$copy/src/server/Cargo.lock" \
    | grep -Fq "version = \"$new_version\"" || {
    printf '%s\n' 'server Cargo.lock did not mirror the new version' >&2
    exit 1
}
grep -A1 '^name = "owpctl"' "$copy/src/owpctl/Cargo.lock" \
    | grep -Fq "version = \"$new_version\"" || {
    printf '%s\n' 'owpctl Cargo.lock did not mirror the new version' >&2
    exit 1
}

# A removed mirror must fail loudly instead of being skipped.
sed -i '/^version = "/d' "$copy/src/server/Cargo.toml"
if bump "$next_version" >/dev/null 2>&1; then
    printf '%s\n' 'A removed Cargo.toml version mirror was accepted' >&2
    exit 1
fi

printf '%s\n' 'bump-version.sh mirrors every version and fails on drift.'
