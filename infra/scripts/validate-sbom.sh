#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 && -s $1 ]] || {
    echo "Usage: $0 SBOM_JSON" >&2
    exit 2
}

sbom=$1
if jq -e '
    .spdxVersion | type == "string" and startswith("SPDX-")
' "$sbom" >/dev/null 2>&1; then
    jq -e '
        (.SPDXID | type == "string" and startswith("SPDXRef-")) and
        (.name | type == "string" and length > 0) and
        (.packages | type == "array" and length > 0)
    ' "$sbom" >/dev/null
elif jq -e '.bomFormat == "CycloneDX"' "$sbom" >/dev/null 2>&1; then
    jq -e '
        (.specVersion | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
        (.version | type == "number" and . >= 1) and
        (.components | type == "array" and length > 0)
    ' "$sbom" >/dev/null
else
    echo "Unsupported or invalid SBOM: $sbom" >&2
    exit 1
fi
