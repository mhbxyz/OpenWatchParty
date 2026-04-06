# ============================================================================
# Shared variables and settings for all just modules
# ============================================================================

set shell := ["bash", "-euo", "pipefail", "-c"]
set quiet

# -- Project -----------------------------------------------------------------

project_name      := "OpenWatchParty"
compose_file      := "infra/docker/dev/docker-compose.yml"
compose           := "docker compose -f " + compose_file
compose_tools     := "docker compose --profile tools -f " + compose_file
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

client_js_files := "state.js utils/time.js utils/video.js utils/misc.js utils/media.js utils/log.js ui/styles.js ui/indicators.js ui/toasts.js ui/cards.js ui/home.js ui/render.js playback/play.js playback/bind.js playback/sync.js chat/messages.js chat/input.js ws/send.js ws/auth.js ws/handlers/room.js ws/handlers/sync.js ws/handlers/playback.js ws/handlers/clock.js ws/connection.js app/lifecycle.js app/cleanup.js"

# -- Colors ------------------------------------------------------------------

GREEN  := '\033[0;32m'
YELLOW := '\033[0;33m'
BLUE   := '\033[0;34m'
CYAN   := '\033[0;36m'
RED    := '\033[0;31m'
BOLD   := '\033[1m'
RESET  := '\033[0m'

# -- File Transformation plugin ------------------------------------------------

ft_version := "2.5.5.0"
ft_abi     := "10.11.6"
ft_url     := "https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/releases/download/" + ft_version + "/Release-" + ft_abi + ".zip"
ft_dir     := "infra/docker/dev/config/plugins/FileTransformation"
ft_marker  := ft_dir + "/.version"
