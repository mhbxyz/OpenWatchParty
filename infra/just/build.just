# ============================================================================
# Build module
# ============================================================================

set working-directory := "../.."

import "common.just"

[doc('Download File Transformation plugin if not present')]
ft:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f "{{ft_marker}}" ] && [ "$(cat "{{ft_marker}}")" = "{{ft_version}}" ]; then
        echo -e "{{GREEN}}✓ File Transformation {{ft_version}} already present{{RESET}}"
        exit 0
    fi
    echo -e "{{CYAN}}▶ Downloading File Transformation plugin {{ft_version}}...{{RESET}}"
    tmpzip=$(mktemp /tmp/ft-plugin-XXXXXX.zip)
    trap 'rm -f "$tmpzip"' EXIT
    curl -fsSL -o "$tmpzip" "{{ft_url}}"
    infra/scripts/verify-sha256.sh "$tmpzip" "{{ft_sha256}}"
    rm -rf "{{ft_dir}}"
    mkdir -p "{{ft_dir}}"
    unzip -qo "$tmpzip" -d "{{ft_dir}}"
    echo "{{ft_version}}" > "{{ft_marker}}"
    echo -e "{{GREEN}}✓ File Transformation {{ft_version}} installed{{RESET}}"

[default]
[doc('Build the Jellyfin plugin (copies JS + dotnet publish)')]
plugin:
    @echo -e "{{GREEN}}▶ Building Jellyfin plugin...{{RESET}}"
    @mkdir -p {{plugin_dir}}/Web {{plugin_dir}}/dist {{plugin_dir}}/obj {{plugin_dir}}/bin
    @cp {{client_dir}}/plugin.js {{plugin_dir}}/Web/plugin.js
    @for f in {{client_js_files}}; do mkdir -p "$(dirname {{plugin_dir}}/Web/$f)" && cp {{client_dir}}/$f {{plugin_dir}}/Web/$f; done
    @{{compose_tools}} run --rm --user "$(id -u):$(id -g)" plugin-builder
    @infra/scripts/write-plugin-meta.sh {{plugin_dir}}/dist/meta.json
    @echo -e "{{GREEN}}✓ Plugin built: {{plugin_dir}}/dist/{{RESET}}"

[doc('Build the session server locally (Rust)')]
server:
    @echo -e "{{GREEN}}▶ Building session server...{{RESET}}"
    @cd {{server_dir}} && cargo build --release --locked
    @echo -e "{{GREEN}}✓ Server built: {{server_dir}}/target/release/{{RESET}}"

[doc('Rebuild session server Docker image')]
image:
    @echo -e "{{GREEN}}▶ Building session server Docker image...{{RESET}}"
    @{{compose}} build session-server
    @echo -e "{{GREEN}}✓ Docker image built{{RESET}}"

[doc('Build everything (plugin + server image)')]
all: ft plugin image
    @echo -e "{{GREEN}}✓ All components built{{RESET}}"
