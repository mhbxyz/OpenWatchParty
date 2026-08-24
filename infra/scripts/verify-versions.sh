#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
version_file=${VERSION_FILE:-$repository_root/version.json}

fail() {
    echo "Version verification failed: $*" >&2
    exit 1
}

assert_equal() {
    local label=$1
    local expected=$2
    local actual=$3
    [[ $actual == "$expected" ]] || fail "$label is '$actual', expected '$expected'"
}

version=$(jq -er '.version' "$version_file")
jellyfin_package=$(jq -er '.jellyfinPackageVersion' "$version_file")
jellyfin_target_abi=$(jq -er '.jellyfinTargetAbi' "$version_file")
jellyfin_image=$(jq -er '.jellyfinImageVersion' "$version_file")
jq -er '.fileTransformationVersion, .fileTransformationAbi' "$version_file" > /dev/null

cargo_version=$(cargo metadata \
    --manifest-path "$repository_root/src/server/Cargo.toml" \
    --no-deps \
    --format-version 1 | jq -er '.packages[] | select(.name == "session-server") | .version')
assert_equal 'Cargo package version' "$version" "$cargo_version"

client_version=$(jq -er '.version' "$repository_root/src/clients/jellyfin-web/manifest.json")
assert_equal 'Client manifest version' "$version" "$client_version"

msbuild_properties=$(dotnet msbuild \
    "$repository_root/src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj" \
    -getProperty:OpenWatchPartyVersion \
    -getProperty:JellyfinPackageVersion \
    -getProperty:JellyfinTargetAbi)
assert_equal 'MSBuild product version' "$version" "$(jq -er '.Properties.OpenWatchPartyVersion' <<< "$msbuild_properties")"
assert_equal 'MSBuild Jellyfin package version' "$jellyfin_package" "$(jq -er '.Properties.JellyfinPackageVersion' <<< "$msbuild_properties")"
assert_equal 'MSBuild Jellyfin target ABI' "$jellyfin_target_abi" "$(jq -er '.Properties.JellyfinTargetAbi' <<< "$msbuild_properties")"

just_contents=$(<"$repository_root/infra/just/common.just")
for key in fileTransformationVersion fileTransformationAbi jellyfinImageVersion; do
    [[ $just_contents == *".$key version.json"* ]] || fail "Just configuration does not consume $key from version.json"
done

compose_contents=$(<"$repository_root/infra/docker/dev/docker-compose.yml")
expected_image='image: jellyfin/jellyfin:$'
expected_image+="{JELLYFIN_VERSION:-$jellyfin_image}"
[[ $compose_contents == *"$expected_image"* ]] || fail "dev Jellyfin image does not default to $jellyfin_image"

if [[ $# -gt 1 ]]; then
    fail 'usage: verify-versions.sh [RELEASE_TAG]'
fi
if [[ $# -eq 1 && -n $1 ]]; then
    release_version=${1#v}
    assert_equal 'Release tag version' "$version" "$release_version"
fi
