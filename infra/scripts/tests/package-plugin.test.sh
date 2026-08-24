#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
package_script="$repository_root/infra/scripts/package-plugin.sh"
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

fixture="$temporary_dir/fixture"
client_dir="$fixture/client"
output_dir="$fixture/output"
publish_dir="$output_dir/plugin"
version_file="$fixture/version.json"
mkdir -p "$client_dir/utils" "$publish_dir"
printf '%s\n' '{"version":"1.2.3","jellyfinTargetAbi":"10.11.0.0"}' > "$version_file"
printf "%s\n" "load('state.js');" "load('utils/time.js');" > "$client_dir/plugin.js"
printf '%s\n' 'state' > "$client_dir/state.js"
printf '%s\n' 'time' > "$client_dir/utils/time.js"
printf '%s\n' \
    '1.2.3' \
    'OpenWatchParty.Plugin.Web.configPage.html' \
    'OpenWatchParty.Plugin.Web.plugin.js' \
    'OpenWatchParty.Plugin.Web.state.js' \
    'OpenWatchParty.Plugin.Web.utils.time.js' > "$publish_dir/OpenWatchPartyPlugin.dll"
printf '%s\n' 'dependency' > "$publish_dir/Dependency.dll"
VERSION_FILE="$version_file" "$repository_root/infra/scripts/write-plugin-meta.sh" "$publish_dir/meta.json"

add_to_archive() {
    local archive=$1
    shift
    if command -v zip >/dev/null; then
        zip -q "$archive" "$@"
    else
        7z a -bd -bso0 -bsp0 -tzip "$archive" "$@"
    fi
}

(cd "$publish_dir" && add_to_archive "$output_dir/OpenWatchParty-v1.2.3.zip" \
    Dependency.dll OpenWatchPartyPlugin.dll meta.json)

validate() {
    VERSION_FILE="$version_file" CLIENT_DIR="$client_dir" \
        "$package_script" --validate-only "$output_dir" >/dev/null
}

expect_failure() {
    local name=$1
    shift
    if "$@" >/dev/null 2>&1; then
        echo "Validation unexpectedly accepted fixture without $name" >&2
        exit 1
    fi
}

validate

cp "$publish_dir/OpenWatchPartyPlugin.dll" "$fixture/plugin.dll"
rm "$publish_dir/OpenWatchPartyPlugin.dll"
expect_failure DLL validate
cp "$fixture/plugin.dll" "$publish_dir/OpenWatchPartyPlugin.dll"

mv "$client_dir/utils/time.js" "$fixture/time.js"
expect_failure module validate
mv "$fixture/time.js" "$client_dir/utils/time.js"

cp "$publish_dir/meta.json" "$fixture/meta.json"
jq '.version = "9.9.9.0"' "$fixture/meta.json" > "$publish_dir/meta.json"
expect_failure version validate
cp "$fixture/meta.json" "$publish_dir/meta.json"

cp "$output_dir/OpenWatchParty-v1.2.3.zip" "$fixture/plugin.zip"
printf '%s\n' 'not a zip archive' > "$output_dir/OpenWatchParty-v1.2.3.zip"
expect_failure checksum validate
cp "$fixture/plugin.zip" "$output_dir/OpenWatchParty-v1.2.3.zip"

printf '%s\n' 'unexpected' > "$fixture/unexpected.txt"
(cd "$fixture" && add_to_archive "$output_dir/OpenWatchParty-v1.2.3.zip" unexpected.txt)
expect_failure 'matching local tree' validate
