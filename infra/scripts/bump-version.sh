#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 NEW_VERSION [--dry-run]" >&2
    echo "  NEW_VERSION  Product version in MAJOR.MINOR.PATCH form (for example 0.5.0)" >&2
    echo "  --dry-run    Print the files that would change without writing them" >&2
    exit 2
}

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
version_file=${VERSION_FILE:-$repository_root/version.json}

dry_run=false
new_version=

while (($# > 0)); do
    case $1 in
        --dry-run) dry_run=true ;;
        -h|--help) usage ;;
        -*) echo "Unknown option: $1" >&2; usage ;;
        *)
            [[ -z $new_version ]] || usage
            new_version=$1
            ;;
    esac
    shift
done

[[ -n $new_version ]] || usage
if [[ ! $new_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Invalid version '$new_version': expected MAJOR.MINOR.PATCH (for example 0.5.0)" >&2
    exit 2
fi
[[ -f $version_file ]] || { echo "Missing canonical version file: $version_file" >&2; exit 1; }
[[ $version_file == "$repository_root/"* ]] || {
    echo "VERSION_FILE must live inside the repository: $version_file" >&2
    exit 1
}
version_relative=${version_file#"$repository_root/"}

current_version=$(jq -er '.version' "$version_file")
jellyfin_package=$(jq -er '.jellyfinPackageVersion' "$version_file")
jellyfin_target_abi=$(jq -er '.jellyfinTargetAbi' "$version_file")
jellyfin_image=$(jq -er '.jellyfinImageVersion' "$version_file")
file_transformation=$(jq -er '.fileTransformationVersion' "$version_file")

temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
shadow_root="$temporary_dir/shadow"
content_file="$temporary_dir/content"
changed_files=()

fail() {
    echo "Version bump failed: $*" >&2
    exit 1
}

# Every edit is staged in a shadow tree so the tree is only written once all
# mirrors have been checked, and so --dry-run can report without touching anything.
current_source() {
    local relative=$1
    local shadow="$shadow_root/$relative"
    if [[ -f $shadow ]]; then
        printf '%s' "$shadow"
    else
        printf '%s' "$repository_root/$relative"
    fi
}

write_shadow() {
    local relative=$1
    local source shadow
    source=$(current_source "$relative")
    shadow="$shadow_root/$relative"
    mkdir -p -- "$(dirname -- "$shadow")"
    cp -- "$content_file" "$shadow"
    cmp -s -- "$source" "$shadow" && return 0
    changed_files+=("$relative")
}

# apply_sed RELATIVE DESCRIPTION REQUIRED_REGEX SED_PROGRAM
apply_sed() {
    local relative=$1 description=$2 required_regex=$3 program=$4
    local source
    source=$(current_source "$relative")
    [[ -f $source ]] || fail "$description: missing file $relative"
    grep -Eq -- "$required_regex" "$source" || \
        fail "$description: expected '$required_regex' in $relative; the mirror was removed or reformatted"
    sed -E "$program" "$source" > "$content_file"
    write_shadow "$relative"
}

update_cargo_package_version() {
    local relative=$1
    local source
    source=$(current_source "$relative")
    [[ -f $source ]] || fail "missing file $relative"
    if ! awk -v new="$new_version" '
        /^\[/ { in_package = ($0 == "[package]") }
        in_package && !done && /^version[[:space:]]*=/ {
            sub(/"[^"]*"/, "\"" new "\"")
            done = 1
        }
        { print }
        END { if (!done) exit 1 }
    ' "$source" > "$content_file"; then
        fail "$relative: no version field found in the [package] table"
    fi
    write_shadow "$relative"
}

update_cargo_lock_version() {
    local relative=$1 package=$2
    local source
    source=$(current_source "$relative")
    [[ -f $source ]] || fail "missing file $relative"
    if ! awk -v package="$package" -v new="$new_version" '
        {
            if ($0 == "name = \"" package "\"") {
                in_block = 1
            } else if (in_block && !done && /^version = "/) {
                sub(/"[^"]*"/, "\"" new "\"")
                done = 1
                in_block = 0
            } else if (in_block && /^name = "/) {
                in_block = 0
            }
            print
        }
        END { if (!done) exit 1 }
    ' "$source" > "$content_file"; then
        fail "$relative: no version field found for package '$package'"
    fi
    write_shadow "$relative"
}

update_compatibility_row() {
    local relative='docs/operations/compatibility.md'
    local source
    source=$(current_source "$relative")
    [[ -f $source ]] || fail "missing file $relative"
    if ! awk -v row="| \`$new_version\` | \`$jellyfin_package\` | \`$jellyfin_target_abi\` | \`$jellyfin_image\` | \`$file_transformation\` | Supported |" \
        -v version="$new_version" '
        /^\|[[:space:]]*OpenWatchParty[[:space:]]*\|/ { header = 1 }
        header && !inserted && /^\|[-| ]+\|[[:space:]]*$/ {
            print
            print row
            inserted = 1
            next
        }
        substr($0, 1, length("| `" version "` |")) == "| `" version "` |" { next }
        { print }
        END { if (!inserted) exit 1 }
    ' "$source" > "$content_file"; then
        fail "$relative: could not find the official matrix table header"
    fi
    write_shadow "$relative"
}

apply_sed "$version_relative" 'version.json version' \
    '"version"[[:space:]]*:' \
    's/^([[:space:]]*"version"[[:space:]]*:[[:space:]]*")[^"]*(")/\1'"$new_version"'\2/'

apply_sed 'src/clients/jellyfin-web/manifest.json' 'client manifest version' \
    '"version"[[:space:]]*:' \
    's/^([[:space:]]*"version"[[:space:]]*:[[:space:]]*")[^"]*(")/\1'"$new_version"'\2/'

update_cargo_package_version 'src/server/Cargo.toml'
update_cargo_package_version 'src/owpctl/Cargo.toml'
update_cargo_lock_version 'src/server/Cargo.lock' 'session-server'
update_cargo_lock_version 'src/owpctl/Cargo.lock' 'owpctl'

apply_sed 'src/plugins/jellyfin/Directory.Build.props' 'plugin MSBuild version' \
    '<OpenWatchPartyVersion>[^<]*</OpenWatchPartyVersion>' \
    's#(<OpenWatchPartyVersion>)[^<]*(</OpenWatchPartyVersion>)#\1'"$new_version"'\2#'

apply_sed 'README.md' 'README product badge' \
    'OpenWatchParty-[0-9]+\.[0-9]+\.[0-9]+-' \
    's/OpenWatchParty-[0-9]+\.[0-9]+\.[0-9]+-/OpenWatchParty-'"$new_version"'-/'

apply_sed 'README.md' 'README product badge alt text' \
    'alt="OpenWatchParty [0-9]+\.[0-9]+\.[0-9]+"' \
    's/alt="OpenWatchParty [0-9]+\.[0-9]+\.[0-9]+"/alt="OpenWatchParty '"$new_version"'"/'

update_compatibility_row

apply_sed 'docs/operations/installation.md' 'installation product version' \
    'OpenWatchParty `[0-9]+\.[0-9]+\.[0-9]+`' \
    's/OpenWatchParty `[0-9]+\.[0-9]+\.[0-9]+`/OpenWatchParty `'"$new_version"'`/'

apply_sed 'docs/operations/installation.md' 'installation version-prefixed image tag' \
    'owp-session-server:v[0-9]+\.[0-9]+\.[0-9]+' \
    's/(owp-session-server:)v[0-9]+\.[0-9]+\.[0-9]+/\1v'"$new_version"'/'

apply_sed 'docs/operations/installation.md' 'installation pinned image tag' \
    'owp-session-server:[0-9]+\.[0-9]+\.[0-9]+' \
    's/(owp-session-server:)[0-9]+\.[0-9]+\.[0-9]+/\1'"$new_version"'/'

apply_sed 'docs/operations/installation.md' 'installation release download tag' \
    'releases/download/v[0-9]+\.[0-9]+\.[0-9]+' \
    's#(releases/download/)v[0-9]+\.[0-9]+\.[0-9]+#\1v'"$new_version"'#'

apply_sed 'docs/operations/installation.md' 'installation plugin archive name' \
    'OpenWatchParty-v[0-9]+\.[0-9]+\.[0-9]+' \
    's/(OpenWatchParty-v)[0-9]+\.[0-9]+\.[0-9]+/\1'"$new_version"'/'

apply_sed 'docs/operations/deployment.md' 'deployment release download tag' \
    'releases/download/v[0-9]+\.[0-9]+\.[0-9]+' \
    's#(releases/download/)v[0-9]+\.[0-9]+\.[0-9]+#\1v'"$new_version"'#'

apply_sed 'docs/operations/deployment.md' 'deployment plugin archive name' \
    'OpenWatchParty-v[0-9]+\.[0-9]+\.[0-9]+' \
    's/(OpenWatchParty-v)[0-9]+\.[0-9]+\.[0-9]+/\1'"$new_version"'/'

apply_sed 'docs/development/ci.md' 'ci version-prefixed image tag' \
    'owp-session-server:v[0-9]+\.[0-9]+\.[0-9]+' \
    's/(owp-session-server:)v[0-9]+\.[0-9]+\.[0-9]+/\1v'"$new_version"'/'

if ((${#changed_files[@]} > 0)); then
    mapfile -t changed_files < <(printf '%s\n' "${changed_files[@]}" | LC_ALL=C sort -u)
fi

if ((${#changed_files[@]} == 0)); then
    printf 'No changes: every mirror already records OpenWatchParty %s (version.json has %s).\n' \
        "$new_version" "$current_version"
    exit 0
fi

if [[ $dry_run == true ]]; then
    printf 'Dry run: OpenWatchParty %s would update %d file(s):\n' "$new_version" "${#changed_files[@]}"
else
    for relative in "${changed_files[@]}"; do
        cat -- "$shadow_root/$relative" > "$repository_root/$relative"
    done
    printf 'Updated OpenWatchParty %s in %d file(s):\n' "$new_version" "${#changed_files[@]}"
fi

for relative in "${changed_files[@]}"; do
    printf '  %s\n' "$relative"
done
printf 'Run infra/scripts/verify-versions.sh to confirm every mirror stays aligned.\n'
