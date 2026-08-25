#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
version_file=${VERSION_FILE:-$repository_root/version.json}
documentation_root=${DOCUMENTATION_ROOT:-$repository_root/docs}
readme_file=${README_FILE:-$repository_root/README.md}

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

assert_contains() {
    local label=$1
    local file=$2
    local expected=$3
    grep -Fq -- "$expected" "$file" || fail "$label does not contain '$expected'"
}

version=$(jq -er '.version' "$version_file")
jellyfin_package=$(jq -er '.jellyfinPackageVersion' "$version_file")
jellyfin_target_abi=$(jq -er '.jellyfinTargetAbi' "$version_file")
jellyfin_image=$(jq -er '.jellyfinImageVersion' "$version_file")
file_transformation=$(jq -er '.fileTransformationVersion' "$version_file")
file_transformation_abi=$(jq -er '.fileTransformationAbi' "$version_file")
dotnet_sdk=$(jq -er '.sdk.version' "$repository_root/global.json")
node_engines=$(jq -er '.engines.node' "$repository_root/src/clients/jellyfin-web/package.json")
rust_toolchain=$(awk -F '"' '/^channel = / { print $2; exit }' "$repository_root/rust-toolchain.toml")
[[ -n $rust_toolchain ]] || fail 'Rust toolchain is missing from rust-toolchain.toml'

node_ci=$(awk -F "'" '/node-version:/ { print $2; exit }' "$repository_root/.github/workflows/ci.yml")
ruby_docs=$(awk -F "'" '/ruby-version:/ { print $2; exit }' "$repository_root/.github/workflows/docs.yml")
[[ -n $node_ci ]] || fail 'Node.js version is missing from the CI workflow'
[[ -n $ruby_docs ]] || fail 'Ruby version is missing from the documentation workflow'

cargo_version=$(cargo metadata \
    --manifest-path "$repository_root/src/server/Cargo.toml" \
    --no-deps \
    --format-version 1 | jq -er '.packages[] | select(.name == "session-server") | .version')
assert_equal 'Cargo package version' "$version" "$cargo_version"

owpctl_version=$(cargo metadata \
    --manifest-path "$repository_root/src/owpctl/Cargo.toml" \
    --no-deps \
    --format-version 1 | jq -er '.packages[] | select(.name == "owpctl") | .version')
assert_equal 'owpctl package version' "$version" "$owpctl_version"

client_version=$(jq -er '.version' "$repository_root/src/clients/jellyfin-web/manifest.json")
assert_equal 'Client manifest version' "$version" "$client_version"

msbuild_args=(
    src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj
    -getProperty:OpenWatchPartyVersion
    -getProperty:JellyfinPackageVersion
    -getProperty:JellyfinTargetAbi
)
if [[ $(dotnet --version 2>/dev/null || true) == "$dotnet_sdk" ]]; then
    msbuild_properties=$(cd "$repository_root" && dotnet msbuild "${msbuild_args[@]}")
else
    msbuild_properties=$(docker run --rm \
        -v "$repository_root:/workspace" -w /workspace \
        mcr.microsoft.com/dotnet/sdk:9.0@sha256:35048e3a81e6a07c316e7bbbd80d80d2ba705fe5f23a8ed42b6638c8f4c20d30 \
        dotnet msbuild "${msbuild_args[@]}")
fi
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

compatibility_document="$documentation_root/operations/compatibility.md"
setup_document="$documentation_root/development/setup.md"
ci_document="$documentation_root/development/ci.md"
installation_document="$documentation_root/operations/installation.md"
transformation_document="$documentation_root/development/file-transformation-integration.md"

assert_contains 'README Jellyfin badge' "$readme_file" "Jellyfin-$jellyfin_image-"
assert_contains 'README Jellyfin badge alt text' "$readme_file" "alt=\"Jellyfin $jellyfin_image\""
assert_contains 'README product badge' "$readme_file" "OpenWatchParty-$version-"
assert_contains 'README product badge alt text' "$readme_file" "alt=\"OpenWatchParty $version\""

expected_compatibility_row="| \`$version\` | \`$jellyfin_package\` | \`$jellyfin_target_abi\` | \`$jellyfin_image\` | \`$file_transformation\` | Supported |"
assert_contains 'Canonical compatibility row' "$compatibility_document" "$expected_compatibility_row"
assert_contains 'Compatibility File Transformation ABI' "$compatibility_document" "archive ABI \`$file_transformation_abi\`"

assert_contains 'Installation product version' "$installation_document" "OpenWatchParty \`$version\`"
assert_contains 'Installation Jellyfin target ABI' "$installation_document" "Jellyfin ABI \`$jellyfin_target_abi\`"
assert_contains 'Installation Jellyfin image version' "$installation_document" "image \`$jellyfin_image\`"
assert_contains 'Installation File Transformation version' "$installation_document" "version \`$file_transformation\`"
assert_contains 'Installation Rust version' "$installation_document" "Rust $rust_toolchain"

assert_contains 'Setup .NET SDK version' "$setup_document" ".NET SDK $dotnet_sdk"
assert_contains 'Setup Rust version' "$setup_document" "Rust $rust_toolchain"
assert_contains 'Setup Node.js CI version' "$setup_document" "Node.js $node_ci"
assert_contains 'Setup Node.js engine range' "$setup_document" "\`$node_engines\`"
assert_contains 'Setup Ruby version' "$setup_document" "Ruby $ruby_docs"

assert_contains 'CI product image version' "$ci_document" "owp-session-server:v$version"
assert_contains 'CI Rust toolchain version' "$ci_document" "Rust \`$rust_toolchain\`"
assert_contains 'CI Jellyfin package version' "$ci_document" "Version=\"$jellyfin_package\""
assert_contains 'File Transformation integration version' "$transformation_document" "File Transformation \`$file_transformation\`"
assert_contains 'File Transformation integration ABI' "$transformation_document" "archive ABI \`$file_transformation_abi\`"

if [[ $# -gt 1 ]]; then
    fail 'usage: verify-versions.sh [RELEASE_TAG]'
fi
if [[ $# -eq 1 && -n $1 ]]; then
    release_version=${1#v}
    assert_equal 'Release tag version' "$version" "$release_version"
fi
