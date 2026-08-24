# ============================================================================
# OpenWatchParty — justfile
# ============================================================================
# Usage: just [recipe]       — run a root recipe
#        just <mod> [recipe] — run a module recipe (build, test, lint, …)
# ============================================================================

set shell := ["bash", "-euo", "pipefail", "-c"]
set quiet
set dotenv-load

export UID := `id -u`
export GID := `id -g`

# -- Project -----------------------------------------------------------------

project_name      := "OpenWatchParty"
compose_file      := "infra/docker/dev/docker-compose.yml"
jellyfin_version  := `jq -er .jellyfinImageVersion version.json`
compose           := "JELLYFIN_VERSION=" + jellyfin_version + " docker compose -f " + compose_file
compose_tools     := "JELLYFIN_VERSION=" + jellyfin_version + " docker compose --profile tools -f " + compose_file
compose_prod_file := "infra/docker/prod/docker-compose.yml"
compose_prod      := "docker compose -f " + compose_prod_file

# -- Directories -------------------------------------------------------------

plugin_dir  := "src/plugins/jellyfin/OpenWatchParty"
client_dir  := "src/clients/jellyfin-web"
server_dir  := "src/server"

# -- Containers --------------------------------------------------------------

jellyfin_ctr := "jellyfin-dev"
session_ctr  := "owp-session-server"

# -- Client JS files (order matters for plugin loading) ----------------------

client_js_files := "state.js utils/time.js utils/video.js utils/misc.js utils/media.js utils/log.js ui/styles.js ui/indicators.js ui/toasts.js ui/cards.js ui/home.js ui/render.js playback/play.js playback/bind.js playback/sync.js chat/messages.js chat/input.js ws/send.js ws/auth.js ws/validation.js ws/handlers/room.js ws/handlers/sync.js ws/handlers/playback.js ws/handlers/clock.js ws/connection.js app/lifecycle.js app/cleanup.js"

# -- Colors ------------------------------------------------------------------

GREEN  := '\033[0;32m'
YELLOW := '\033[0;33m'
BLUE   := '\033[0;34m'
CYAN   := '\033[0;36m'
RED    := '\033[0;31m'
BOLD   := '\033[1m'
RESET  := '\033[0m'

# -- Modules -----------------------------------------------------------------

mod build "infra/just/build.just"
mod test  "infra/just/test.just"
mod lint  "infra/just/lint.just"
mod logs  "infra/just/logs.just"
mod clean "infra/just/clean.just"
mod shell "infra/just/shell.just"

# -- Aliases -----------------------------------------------------------------

alias u := up
alias d := down
alias s := status

# -- Default -----------------------------------------------------------------

[doc('Show available recipes')]
default:
    @just --list --list-submodules

# -- Development -------------------------------------------------------------

[doc('Start the full stack (Jellyfin + session server)')]
up:
    @just build ft
    @just build plugin
    @echo -e "{{GREEN}}▶ Starting services...{{RESET}}"
    @{{compose}} up -d session-server jellyfin-dev
    @echo -e "{{GREEN}}✓ Stack started{{RESET}}"
    @echo ""
    @echo -e "  Jellyfin:  {{CYAN}}http://localhost:8096{{RESET}}"
    @echo -e "  WebSocket: {{CYAN}}ws://localhost:3000/ws{{RESET}}"
    @echo ""

[doc('Stop all services')]
down:
    @echo -e "{{YELLOW}}▶ Stopping services...{{RESET}}"
    @{{compose}} down
    @echo -e "{{GREEN}}✓ Services stopped{{RESET}}"

[doc('Start stack and follow logs')]
dev: up
    @{{compose}} logs -f --tail=100

[doc('Watch client JS files and auto-restart Jellyfin on change')]
watch:
    #!/usr/bin/env bash
    set -euo pipefail
    echo -e "{{CYAN}}▶ Watching {{client_dir}} for changes...{{RESET}}"
    echo "  Press Ctrl+C to stop"
    while true; do
        inotifywait -r -q -e modify -e create -e delete {{client_dir}}/ 2>/dev/null \
            || fswatch -r -1 {{client_dir}}/ 2>/dev/null \
            || sleep 5
        echo -e "{{YELLOW}}▶ Change detected, restarting Jellyfin...{{RESET}}"
        {{compose}} restart jellyfin-dev
        echo -e "{{GREEN}}✓ Restarted{{RESET}}"
    done

[doc('Restart all services')]
restart:
    @echo -e "{{YELLOW}}▶ Restarting services...{{RESET}}"
    @{{compose}} restart session-server jellyfin-dev
    @echo -e "{{GREEN}}✓ Services restarted{{RESET}}"

[doc('Show service status with health checks')]
status:
    #!/usr/bin/env bash
    set -uo pipefail
    echo -e "{{BOLD}}{{CYAN}}Service Status:{{RESET}}"
    echo ""
    {{compose}} ps --format "table {{{{.Name}}}}\t{{{{.Status}}}}\t{{{{.Ports}}}}"
    echo ""
    echo -e "{{BOLD}}{{CYAN}}Health Checks:{{RESET}}"
    echo ""
    printf "  Session Server: "
    curl -sf http://localhost:3000/health > /dev/null 2>&1 \
        && echo -e "{{GREEN}}✓ healthy{{RESET}}" \
        || echo -e "{{RED}}✗ unhealthy{{RESET}}"
    printf "  Jellyfin:       "
    curl -sf http://localhost:8096/health > /dev/null 2>&1 \
        && echo -e "{{GREEN}}✓ healthy{{RESET}}" \
        || echo -e "{{RED}}✗ unhealthy{{RESET}}"
    printf "  WebSocket:      "
    timeout 2 bash -c 'echo "" | nc -w1 localhost 3000' > /dev/null 2>&1 \
        && echo -e "{{GREEN}}✓ reachable{{RESET}}" \
        || echo -e "{{YELLOW}}? check manually{{RESET}}"
    echo ""

# -- Build shortcuts ---------------------------------------------------------

[doc('Clean and rebuild everything')]
rebuild:
    @just clean
    @just build all
    @{{compose}} up -d --force-recreate
    @echo -e "{{GREEN}}✓ Stack rebuilt and restarted{{RESET}}"

[doc('Build release artifacts (zip)')]
release:
    @infra/scripts/verify-workflow-permissions.py
    @infra/scripts/verify-pins.sh
    @infra/scripts/scan-secrets.sh
    @echo -e "{{GREEN}}▶ Packaging plugin release...{{RESET}}"
    @infra/scripts/package-plugin.sh

[doc('Full reset (stop + remove containers + clean artifacts)')]
reset: down
    @just clean docker
    @just clean

# -- Setup -------------------------------------------------------------------

[doc('Configure git hooks and local dev environment')]
setup:
    @git config core.hooksPath .githooks
    @echo -e "{{GREEN}}✓ Git hooks configured (.githooks/){{RESET}}"

# -- Quality -----------------------------------------------------------------

[doc('Format all code')]
fmt:
    @echo -e "{{CYAN}}▶ Formatting Rust code...{{RESET}}"
    @cd {{server_dir}} && cargo fmt
    @echo -e "{{GREEN}}✓ Code formatted{{RESET}}"

[doc('Run cargo check (fast compile check)')]
check:
    @echo -e "{{CYAN}}▶ Running cargo check...{{RESET}}"
    @cd {{server_dir}} && cargo check
    @echo -e "{{GREEN}}✓ Check passed{{RESET}}"
