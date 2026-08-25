# ============================================================================
# Lint module
# ============================================================================

set working-directory := "../.."

import "common.just"

[default]
[doc('Run all linters (Rust + JS)')]
default: server client

[doc('Lint Rust code with clippy')]
server:
    @echo -e "{{CYAN}}▶ Linting Rust code...{{RESET}}"
    @cd {{server_dir}} && cargo clippy -- -D warnings
    @cd src/owpctl && cargo clippy --all-targets --all-features -- -D warnings
    @echo -e "{{GREEN}}✓ Rust lint passed{{RESET}}"

[doc('Lint JavaScript code')]
client:
    #!/usr/bin/env bash
    set -euo pipefail
    echo -e "{{CYAN}}▶ Linting JavaScript...{{RESET}}"
    npm --prefix {{client_dir}} ci
    npm --prefix {{client_dir}} run lint
    echo -e "{{GREEN}}✓ JavaScript lint passed{{RESET}}"
