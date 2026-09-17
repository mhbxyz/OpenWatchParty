#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
verify_script="$repository_root/infra/scripts/verify-toolchain.sh"
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

fixture="$temporary_dir/fixture"
fixture_sdk='10.0.401'

# Read the canonical pin instead of embedding two digests in this test: otherwise
# this file would itself become a drifting pin reference.
image=$(grep -rhoE 'mcr\.microsoft\.com/dotnet/sdk:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}' \
    "$repository_root/infra/just/test.just" | head -n1)
if [[ -z $image ]]; then
    printf '%s\n' 'Could not read the pinned .NET SDK image from infra/just/test.just' >&2
    exit 1
fi

last_hex=${image: -1}
if [[ $last_hex == a ]]; then
    other_hex=b
else
    other_hex=a
fi
other_image="${image%?}${other_hex}"

mkdir -p "$fixture/infra/scripts" "$fixture/infra/just" "$fixture/.github/workflows" "$fixture/stub"
cp "$verify_script" "$fixture/infra/scripts/verify-toolchain.sh"

cat > "$fixture/infra/just/test.just" <<EOF
image: $image
EOF

cat > "$fixture/global.json" <<EOF
{
  "sdk": {
    "version": "$fixture_sdk"
  }
}
EOF

cat > "$fixture/.github/workflows/ci.yml" <<EOF
jobs:
  dotnet-tests:
    steps:
      - with:
          dotnet-version: '$fixture_sdk'
EOF

cat > "$fixture/stub/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == run ]]; then
    printf '%s\n' "${FAKE_DOTNET_SDK_VERSION:-10.0.401}"
    exit 0
fi
printf 'unexpected docker invocation: %s\n' "$*" >&2
exit 1
STUB
chmod +x "$fixture/stub/docker"

fixture_script="$fixture/infra/scripts/verify-toolchain.sh"

run_verify() {
    PATH="$fixture/stub:$PATH" "$fixture_script"
}

run_verify

printf 'image: %s\n' "$other_image" > "$fixture/infra/just/build.just"
if run_verify >/dev/null 2>&1; then
    printf '%s\n' 'A different pinned image digest was accepted' >&2
    exit 1
fi
rm -f "$fixture/infra/just/build.just"

cat > "$fixture/global.json" <<'EOF'
{
  "sdk": {
    "version": "9.9.9"
  }
}
EOF
if run_verify >/dev/null 2>&1; then
    printf '%s\n' 'A global.json SDK version disagreeing with the image was accepted' >&2
    exit 1
fi

cat > "$fixture/global.json" <<EOF
{
  "sdk": {
    "version": "$fixture_sdk"
  }
}
EOF

cat > "$fixture/.github/workflows/ci.yml" <<'EOF'
jobs:
  dotnet-tests:
    steps:
      - with:
          dotnet-version: '9.9.9'
EOF
if run_verify >/dev/null 2>&1; then
    printf '%s\n' 'A workflow dotnet-version disagreeing with global.json was accepted' >&2
    exit 1
fi

printf '%s\n' 'verify-toolchain.sh rejects every toolchain pin drift.'
