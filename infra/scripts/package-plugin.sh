#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 [--validate-only] [OUTPUT_DIRECTORY]" >&2
    exit 2
}

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
version_file=${VERSION_FILE:-$repository_root/version.json}
plugin_dir=${PLUGIN_DIR:-$repository_root/src/plugins/jellyfin/OpenWatchParty}
client_dir=${CLIENT_DIR:-$repository_root/src/clients/jellyfin-web}
output_dir=${OUTPUT_DIR:-$repository_root/dist}
validate_only=false

if [[ ${1:-} == --validate-only ]]; then
    validate_only=true
    shift
fi
[[ $# -le 1 ]] || usage
if [[ $# -eq 1 ]]; then
    output_dir=$1
fi

version=$(jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+([.-][0-9A-Za-z.-]+)?$"))' "$version_file")
publish_dir="$output_dir/plugin"
archive="$output_dir/OpenWatchParty-v${version}.zip"
assembly="$publish_dir/OpenWatchPartyPlugin.dll"
metadata="$publish_dir/meta.json"
loader="$client_dir/plugin.js"

publish_plugin() {
    required_sdk=$(jq -er '.sdk.version' "$repository_root/global.json")
    if dotnet_path=$(command -v dotnet); then
        installed_sdks=$("$dotnet_path" --list-sdks)
        if grep -Fq "$required_sdk [" <<< "$installed_sdks"; then
            "$dotnet_path" restore "$project" --locked-mode
            "$dotnet_path" publish "$project" -c Release --no-restore -o "$relative_publish_dir"
            return
        fi
    fi
    if ! docker_path=$(command -v docker); then
        echo "The SDK from global.json is unavailable and Docker is not installed" >&2
        return 1
    fi
    # shellcheck disable=SC2016
    "$docker_path" run --rm \
        --user "$(id -u):$(id -g)" \
        -e HOME=/tmp \
        -e DOTNET_CLI_HOME=/tmp/.dotnet \
        -v "$repository_root:/workspace" \
        -w /workspace \
        mcr.microsoft.com/dotnet/sdk:9.0@sha256:35048e3a81e6a07c316e7bbbd80d80d2ba705fe5f23a8ed42b6638c8f4c20d30 \
        bash -euo pipefail -c \
        'dotnet restore "$1" --locked-mode && dotnet publish "$1" -c Release --no-restore -o "$2"' \
        _ "$project" "$relative_publish_dir"
}

create_archive() {
    zip_path=$(command -v zip) || { echo "Packaging requires zip" >&2; return 1; }
    for file in "${package_files[@]}"; do
        touch -t 198001010000 "$file"
        chmod 0644 "$file"
    done
    "$zip_path" -X -q "$archive" "${package_files[@]}"
}

validate_package() {
    [[ -s $assembly ]] || { echo "Missing plugin assembly: $assembly" >&2; return 1; }
    [[ -s $loader ]] || { echo "Missing client loader: $loader" >&2; return 1; }
    [[ -s $metadata ]] || { echo "Missing plugin metadata: $metadata" >&2; return 1; }
    [[ -s $archive ]] || { echo "Missing plugin archive: $archive" >&2; return 1; }

    [[ $(jq -er '.version' "$metadata") == "${version}.0" ]] || {
        echo "Plugin metadata version does not match version.json" >&2
        return 1
    }

    assembly_strings=$(strings "$assembly")
    grep -Fxq "$version" <<< "$assembly_strings" || {
        echo "Plugin assembly version does not match version.json" >&2
        return 1
    }
    grep -Fxq 'OpenWatchParty.Plugin.Web.configPage.html' <<< "$assembly_strings" || {
        echo "Plugin assembly is missing configPage.html" >&2
        return 1
    }
    grep -Fxq 'OpenWatchParty.Plugin.Web.plugin.js' <<< "$assembly_strings" || {
        echo "Plugin assembly is missing plugin.js" >&2
        return 1
    }

    module_matches=$(grep -oE "load\\(['\"][^'\"]+\\.js['\"]\\)" "$loader")
    mapfile -t modules < <(printf '%s\n' "$module_matches" \
        | sed -E "s/^load\\(['\"]([^'\"]+)['\"]\\)$/\\1/" \
        | LC_ALL=C sort -u)
    [[ ${#modules[@]} -gt 0 ]] || { echo "Client loader declares no modules" >&2; return 1; }
    for module in "${modules[@]}"; do
        [[ -s $client_dir/$module ]] || { echo "Missing client module: $module" >&2; return 1; }
        resource="OpenWatchParty.Plugin.Web.${module//\//.}"
        grep -Fxq "$resource" <<< "$assembly_strings" || {
            echo "Plugin assembly is missing module: $module" >&2
            return 1
        }
    done

    unzip -tq "$archive"
    expected_tree=$(find "$publish_dir" -type f -printf '%P\n' | LC_ALL=C sort)
    archive_tree=$(unzip -Z1 "$archive" | LC_ALL=C sort)
    [[ $archive_tree == "$expected_tree" ]] || {
        echo "Plugin archive tree does not match the published output" >&2
        diff -u <(printf '%s\n' "$expected_tree") <(printf '%s\n' "$archive_tree") >&2
        return 1
    }
    extracted=$(mktemp -d)
    unzip -q "$archive" -d "$extracted"
    while IFS= read -r file; do
        cmp -s "$publish_dir/$file" "$extracted/$file" || {
            rm -rf "$extracted"
            echo "Plugin archive content differs for: $file" >&2
            return 1
        }
    done <<< "$expected_tree"
    rm -rf "$extracted"
}

if [[ $validate_only == false ]]; then
    [[ $plugin_dir == "$repository_root/"* && $publish_dir == "$repository_root/"* ]] || {
        echo "Build paths must be inside the repository" >&2
        exit 1
    }
    project=${plugin_dir#"$repository_root/"}/OpenWatchPartyPlugin.csproj
    relative_publish_dir=${publish_dir#"$repository_root/"}
    rm -rf -- "$publish_dir"
    rm -f -- "$archive"
    mkdir -p -- "$publish_dir"

    publish_plugin
    VERSION_FILE="$version_file" "$repository_root/infra/scripts/write-plugin-meta.sh" "$metadata"

    mapfile -t package_files < <(find "$publish_dir" -type f -printf '%P\n' | LC_ALL=C sort)
    [[ ${#package_files[@]} -gt 0 ]] || { echo "Plugin publish output is empty" >&2; exit 1; }
    (
        cd -- "$publish_dir"
        create_archive
    )
fi

validate_package
printf 'Plugin package: %s\n' "$archive"
