# ============================================================================
# Test module
# ============================================================================

set working-directory := "../.."

import "common.just"

[default]
[doc('Run all tests (Rust + .NET + JS)')]
default: server plugin client release

[doc('Run Rust server tests')]
server:
    @echo -e "{{GREEN}}▶ Running server tests...{{RESET}}"
    @cd {{server_dir}} && cargo test
    @echo -e "{{GREEN}}✓ Tests passed{{RESET}}"

[doc('Run .NET plugin tests')]
plugin:
    @echo -e "{{GREEN}}▶ Running plugin tests...{{RESET}}"
    @mkdir -p {{plugin_dir}}/Web
    @cp {{client_dir}}/plugin.js {{plugin_dir}}/Web/plugin.js
    @for f in {{client_js_files}}; do mkdir -p "$(dirname {{plugin_dir}}/Web/$f)" && cp {{client_dir}}/$f {{plugin_dir}}/Web/$f; done
    @docker run --rm \
        -v "$(pwd)/src/plugins/jellyfin:/src" \
        -w /src \
        -u "$(id -u):$(id -g)" \
        -e HOME=/tmp \
        -e DOTNET_CLI_HOME=/tmp/.dotnet \
        mcr.microsoft.com/dotnet/sdk:9.0@sha256:35048e3a81e6a07c316e7bbbd80d80d2ba705fe5f23a8ed42b6638c8f4c20d30 \
        dotnet test OpenWatchParty.Tests/
    @echo -e "{{GREEN}}✓ Plugin tests passed{{RESET}}"

[doc('Run JavaScript client tests')]
client:
    @echo -e "{{GREEN}}▶ Running client tests...{{RESET}}"
    @npm ci --prefix {{client_dir}}
    @npm test --prefix {{client_dir}}
    @echo -e "{{GREEN}}✓ Client tests passed{{RESET}}"

[doc('Run release script tests')]
release:
    @echo -e "{{GREEN}}▶ Running release script tests...{{RESET}}"
    @infra/scripts/verify-pins.sh
    @infra/scripts/tests/verify-pins.test.sh
    @infra/scripts/tests/update-plugin-manifest.test.sh
    @infra/scripts/tests/verify-versions.test.sh
    @infra/scripts/tests/write-plugin-meta.test.sh
    @echo -e "{{GREEN}}✓ Release script tests passed{{RESET}}"
