#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

artifact="$temporary_dir/OpenWatchParty-v1.0.0.zip"
checksum="$artifact.sha256"
printf 'plugin' > "$artifact"
"$root/infra/scripts/write-sha256.sh" "$artifact" "$checksum"
"$root/infra/scripts/verify-checksum.sh" "$checksum" "$artifact"

printf 'tampered' > "$artifact"
if "$root/infra/scripts/verify-checksum.sh" "$checksum" "$artifact" >/dev/null 2>&1; then
    echo 'A checksum mismatch was accepted' >&2
    exit 1
fi

cat > "$temporary_dir/plugin.spdx.json" <<'JSON'
{"spdxVersion":"SPDX-2.3","SPDXID":"SPDXRef-DOCUMENT","name":"plugin","packages":[{"name":"plugin"}]}
JSON
cat > "$temporary_dir/plugin.cyclonedx.json" <<'JSON'
{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[{"name":"plugin","type":"library"}]}
JSON
"$root/infra/scripts/validate-sbom.sh" "$temporary_dir/plugin.spdx.json"
"$root/infra/scripts/validate-sbom.sh" "$temporary_dir/plugin.cyclonedx.json"

printf '{"bomFormat":"CycloneDX","components":[]}' > "$temporary_dir/invalid.json"
if "$root/infra/scripts/validate-sbom.sh" "$temporary_dir/invalid.json" >/dev/null 2>&1; then
    echo 'An incomplete SBOM was accepted' >&2
    exit 1
fi

workflow="$root/.github/workflows/publish.yml"
for required_asset in \
    'owp-session-server.spdx.json' \
    'owp-session-server.cyclonedx.json' \
    'owp-session-server.sigstore.json' \
    "\"\$PLUGIN_PATH.sha256\"" \
    "\"\$PLUGIN_PATH.sigstore.json\""; do
    grep -Fq -- "$required_asset" "$workflow" || {
        echo "Release workflow is missing supply-chain asset: $required_asset" >&2
        exit 1
    }
done
grep -Fq 'files: artifacts/*' "$workflow" || {
    echo 'Release upload does not include all supply-chain assets' >&2
    exit 1
}
