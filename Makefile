# ============================================================================
# OpenWatchParty - Makefile
# ============================================================================
# Usage: make [target]
# Run 'make help' for available targets
# ============================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
PROJECT_NAME    := OpenWatchParty
COMPOSE_FILE    := infra/docker/docker-compose.yml
COMPOSE         := docker compose -f $(COMPOSE_FILE)
COMPOSE_TOOLS   := docker compose --profile tools -f $(COMPOSE_FILE)

# Directories
PLUGIN_DIR      := plugins/jellyfin/OpenWatchParty
CLIENT_DIR      := clients/web-plugin
SERVER_DIR      := server
DOCS_DIR        := docs

# Containers
JELLYFIN_CTR    := jellyfin-dev
SERVER_CTR      := openwatchparty-session-server

# User mapping for Docker (avoid root-owned files)
export UID      := $(shell id -u)
export GID      := $(shell id -g)

# Colors (disable with NO_COLOR=1)
ifndef NO_COLOR
  GREEN  := \033[0;32m
  YELLOW := \033[0;33m
  BLUE   := \033[0;34m
  CYAN   := \033[0;36m
  RED    := \033[0;31m
  BOLD   := \033[1m
  RESET  := \033[0m
else
  GREEN  :=
  YELLOW :=
  BLUE   :=
  CYAN   :=
  RED    :=
  BOLD   :=
  RESET  :=
endif

# ----------------------------------------------------------------------------
# Help
# ----------------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@echo ""
	@echo "$(BOLD)$(PROJECT_NAME) Makefile$(RESET)"
	@echo ""
	@echo "$(BOLD)$(CYAN)Development:$(RESET)"
	@echo "  $(GREEN)up$(RESET)                 Start the full stack (Jellyfin + session server)"
	@echo "  $(GREEN)down$(RESET)               Stop all services"
	@echo "  $(GREEN)restart$(RESET)            Restart all services"
	@echo "  $(GREEN)restart-jellyfin$(RESET)   Restart Jellyfin only (after plugin changes)"
	@echo "  $(GREEN)restart-server$(RESET)     Restart session server only"
	@echo "  $(GREEN)dev$(RESET)                Start stack and follow logs"
	@echo "  $(GREEN)watch$(RESET)              Watch JS files and auto-restart on change"
	@echo "  $(GREEN)shell-jellyfin$(RESET)     Open shell in Jellyfin container"
	@echo "  $(GREEN)shell-server$(RESET)       Open shell in session server container"
	@echo ""
	@echo "$(BOLD)$(CYAN)Build:$(RESET)"
	@echo "  $(GREEN)build$(RESET)              Build the Jellyfin plugin"
	@echo "  $(GREEN)build-server$(RESET)       Build the session server (Rust)"
	@echo "  $(GREEN)build-server-docker$(RESET) Rebuild session server Docker image"
	@echo "  $(GREEN)build-all$(RESET)          Build everything (plugin + server image)"
	@echo "  $(GREEN)rebuild$(RESET)            Clean and rebuild everything"
	@echo "  $(GREEN)sync-refs$(RESET)          Sync Jellyfin DLL references from container"
	@echo "  $(GREEN)release$(RESET)            Build release artifacts (zip)"
	@echo ""
	@echo "$(BOLD)$(CYAN)Observability:$(RESET)"
	@echo "  $(GREEN)logs$(RESET)               Follow logs from all services"
	@echo "  $(GREEN)logs-server$(RESET)        Follow session server logs only"
	@echo "  $(GREEN)logs-jellyfin$(RESET)      Follow Jellyfin logs only"
	@echo "  $(GREEN)status$(RESET)             Show service status with health info"
	@echo "  $(GREEN)health$(RESET)             Check health of all services"
	@echo "  $(GREEN)stats$(RESET)              Show container resource usage (CPU/mem)"
	@echo "  $(GREEN)top$(RESET)                Show running processes in containers"
	@echo "  $(GREEN)connections$(RESET)        Show active WebSocket connections"
	@echo ""
	@echo "$(BOLD)$(CYAN)Testing & Quality:$(RESET)"
	@echo "  $(GREEN)test$(RESET)               Run all tests"
	@echo "  $(GREEN)lint$(RESET)               Run all linters (Rust + JS)"
	@echo "  $(GREEN)fmt$(RESET)                Format all code"
	@echo "  $(GREEN)check$(RESET)              Run cargo check (fast compile check)"
	@echo ""
	@echo "$(BOLD)$(CYAN)Cleanup:$(RESET)"
	@echo "  $(GREEN)clean$(RESET)              Clean all build artifacts"
	@echo "  $(GREEN)clean-docker$(RESET)       Remove Docker images and volumes"
	@echo "  $(GREEN)reset$(RESET)              Full reset (containers + artifacts)"
	@echo "  $(GREEN)prune$(RESET)              Remove unused Docker resources"
	@echo "  $(GREEN)fix-permissions$(RESET)    Fix ownership of Docker-created files"
	@echo ""
	@echo "$(BOLD)$(CYAN)Utilities:$(RESET)"
	@echo "  $(GREEN)info$(RESET)               Show project information"
	@echo "  $(GREEN)env$(RESET)                Show environment variables"
	@echo "  $(GREEN)urls$(RESET)               Show service URLs"
	@echo "  $(GREEN)tree$(RESET)               Show project structure"
	@echo ""
	@echo "$(BOLD)$(CYAN)Quick Aliases:$(RESET)  $(GREEN)u$(RESET)=up  $(GREEN)d$(RESET)=down  $(GREEN)r$(RESET)=restart  $(GREEN)l$(RESET)=logs  $(GREEN)s$(RESET)=status  $(GREEN)b$(RESET)=build"
	@echo ""

# ----------------------------------------------------------------------------
# Development
# ----------------------------------------------------------------------------
.PHONY: up down restart dev watch shell-jellyfin shell-server

up: build-plugin ## Start the full stack (Jellyfin + session server)
	@echo "$(GREEN)▶ Starting services...$(RESET)"
	@$(COMPOSE) up -d session-server jellyfin-dev
	@echo "$(GREEN)✓ Stack started$(RESET)"
	@echo ""
	@echo "  Jellyfin:  $(CYAN)http://localhost:8096$(RESET)"
	@echo "  WebSocket: $(CYAN)ws://localhost:3000/ws$(RESET)"
	@echo ""

down: ## Stop all services
	@echo "$(YELLOW)▶ Stopping services...$(RESET)"
	@$(COMPOSE) down
	@echo "$(GREEN)✓ Services stopped$(RESET)"

restart: ## Restart all services
	@echo "$(YELLOW)▶ Restarting services...$(RESET)"
	@$(COMPOSE) restart session-server jellyfin-dev
	@echo "$(GREEN)✓ Services restarted$(RESET)"

restart-jellyfin: ## Restart Jellyfin only (after plugin changes)
	@echo "$(YELLOW)▶ Restarting Jellyfin...$(RESET)"
	@$(COMPOSE) restart jellyfin-dev
	@echo "$(GREEN)✓ Jellyfin restarted$(RESET)"

restart-server: ## Restart session server only
	@echo "$(YELLOW)▶ Restarting session server...$(RESET)"
	@$(COMPOSE) restart session-server
	@echo "$(GREEN)✓ Session server restarted$(RESET)"

dev: up logs ## Start stack and follow logs

watch: ## Watch client JS files and auto-restart Jellyfin on change
	@echo "$(CYAN)▶ Watching $(CLIENT_DIR) for changes...$(RESET)"
	@echo "  Press Ctrl+C to stop"
	@while true; do \
		inotifywait -q -e modify -e create -e delete $(CLIENT_DIR)/*.js 2>/dev/null || fswatch -1 $(CLIENT_DIR)/*.js 2>/dev/null || sleep 5; \
		echo "$(YELLOW)▶ Change detected, restarting Jellyfin...$(RESET)"; \
		$(COMPOSE) restart jellyfin-dev; \
		echo "$(GREEN)✓ Restarted$(RESET)"; \
	done

shell-jellyfin: ## Open shell in Jellyfin container
	@docker exec -it $(JELLYFIN_CTR) /bin/bash

shell-server: ## Open shell in session server container
	@docker exec -it $(SERVER_CTR) /bin/sh

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
.PHONY: build build-plugin build-server build-all sync-refs start-deps

build: build-plugin ## Build the Jellyfin plugin (alias for build-plugin)

build-plugin: start-deps sync-refs ## Build the Jellyfin plugin
	@echo "$(GREEN)▶ Building Jellyfin plugin...$(RESET)"
	@mkdir -p $(PLUGIN_DIR)/Web
	@cp $(CLIENT_DIR)/plugin.js $(PLUGIN_DIR)/Web/plugin.js
	@cp $(CLIENT_DIR)/state.js $(CLIENT_DIR)/utils.js $(CLIENT_DIR)/ui.js $(CLIENT_DIR)/playback.js $(CLIENT_DIR)/ws.js $(CLIENT_DIR)/app.js $(PLUGIN_DIR)/Web/
	@$(COMPOSE_TOOLS) run --rm plugin-builder
	@echo "$(GREEN)✓ Plugin built: $(PLUGIN_DIR)/dist/$(RESET)"

build-server: ## Build the session server (Rust)
	@echo "$(GREEN)▶ Building session server...$(RESET)"
	@cd $(SERVER_DIR) && cargo build --release
	@echo "$(GREEN)✓ Server built: $(SERVER_DIR)/target/release/$(RESET)"

build-server-docker: ## Rebuild session server Docker image
	@echo "$(GREEN)▶ Building session server Docker image...$(RESET)"
	@$(COMPOSE) build session-server
	@echo "$(GREEN)✓ Docker image built$(RESET)"

build-all: build-plugin build-server-docker ## Build everything (plugin + server image)
	@echo "$(GREEN)✓ All components built$(RESET)"

rebuild: clean build-all ## Clean and rebuild everything
	@$(COMPOSE) up -d --force-recreate
	@echo "$(GREEN)✓ Stack rebuilt and restarted$(RESET)"

sync-refs: ## Sync Jellyfin DLL references from container
	@echo "$(CYAN)▶ Syncing Jellyfin DLLs...$(RESET)"
	@./scripts/sync-jellyfin-refs.sh
	@echo "$(GREEN)✓ DLLs synced$(RESET)"

start-deps: ## Start dependencies needed for build
	@# Create directories BEFORE Docker to ensure correct ownership
	@mkdir -p $(PLUGIN_DIR)/dist $(PLUGIN_DIR)/obj $(PLUGIN_DIR)/bin
	@if ! docker ps --format '{{.Names}}' | grep -q $(JELLYFIN_CTR); then \
		echo "$(CYAN)▶ Starting dependencies...$(RESET)"; \
		$(COMPOSE) up -d session-server jellyfin-dev; \
		sleep 5; \
	fi

release: clean ## Build release artifacts
	@echo "$(GREEN)▶ Building release...$(RESET)"
	@mkdir -p dist/plugin dist/server
	@# Build plugin
	@$(MAKE) build-plugin
	@cp -r $(PLUGIN_DIR)/dist/* dist/plugin/
	@# Build server
	@cd $(SERVER_DIR) && cargo build --release
	@cp $(SERVER_DIR)/target/release/session-server dist/server/ 2>/dev/null || true
	@# Package
	@cd dist && zip -r ../$(PROJECT_NAME)-release.zip .
	@echo "$(GREEN)✓ Release built: $(PROJECT_NAME)-release.zip$(RESET)"

# ----------------------------------------------------------------------------
# Observability
# ----------------------------------------------------------------------------
.PHONY: logs logs-server logs-jellyfin status ps health top stats

logs: ## Follow logs from all services
	@$(COMPOSE) logs -f --tail=100

logs-server: ## Follow session server logs only
	@$(COMPOSE) logs -f --tail=100 session-server

logs-jellyfin: ## Follow Jellyfin logs only
	@$(COMPOSE) logs -f --tail=100 jellyfin-dev

status: ## Show service status with health info
	@echo "$(BOLD)$(CYAN)Service Status:$(RESET)"
	@echo ""
	@$(COMPOSE) ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
	@echo ""
	@$(MAKE) -s health

ps: status ## Alias for status

health: ## Check health of all services
	@echo "$(BOLD)$(CYAN)Health Checks:$(RESET)"
	@echo ""
	@printf "  Session Server: "
	@curl -sf http://localhost:3000/health > /dev/null 2>&1 && echo "$(GREEN)✓ healthy$(RESET)" || echo "$(RED)✗ unhealthy$(RESET)"
	@printf "  Jellyfin:       "
	@curl -sf http://localhost:8096/health > /dev/null 2>&1 && echo "$(GREEN)✓ healthy$(RESET)" || echo "$(RED)✗ unhealthy$(RESET)"
	@printf "  WebSocket:      "
	@timeout 2 bash -c 'echo "" | nc -w1 localhost 3000' > /dev/null 2>&1 && echo "$(GREEN)✓ reachable$(RESET)" || echo "$(YELLOW)? check manually$(RESET)"
	@echo ""

top: ## Show running processes in containers
	@echo "$(BOLD)$(CYAN)Container Processes:$(RESET)"
	@echo ""
	@echo "$(YELLOW)── Session Server ──$(RESET)"
	@docker top $(SERVER_CTR) 2>/dev/null || echo "  (not running)"
	@echo ""
	@echo "$(YELLOW)── Jellyfin ──$(RESET)"
	@docker top $(JELLYFIN_CTR) 2>/dev/null || echo "  (not running)"

stats: ## Show container resource usage
	@docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" $(SERVER_CTR) $(JELLYFIN_CTR) 2>/dev/null || echo "Containers not running"

connections: ## Show WebSocket connections (requires wscat or websocat)
	@echo "$(CYAN)Active connections on port 3000:$(RESET)"
	@ss -tn state established '( sport = :3000 )' 2>/dev/null || netstat -tn 2>/dev/null | grep ":3000.*ESTABLISHED" || echo "  No active connections"

# ----------------------------------------------------------------------------
# Testing & Quality
# ----------------------------------------------------------------------------
.PHONY: test test-server lint lint-server lint-client fmt fmt-server check

test: test-server ## Run all tests

test-server: ## Run Rust server tests
	@echo "$(GREEN)▶ Running server tests...$(RESET)"
	@cd $(SERVER_DIR) && cargo test
	@echo "$(GREEN)✓ Tests passed$(RESET)"

lint: lint-server lint-client ## Run all linters

lint-server: ## Lint Rust code
	@echo "$(CYAN)▶ Linting Rust code...$(RESET)"
	@cd $(SERVER_DIR) && cargo clippy -- -D warnings
	@echo "$(GREEN)✓ Rust lint passed$(RESET)"

lint-client: ## Lint JavaScript code (requires eslint)
	@echo "$(CYAN)▶ Linting JavaScript...$(RESET)"
	@if command -v eslint &> /dev/null; then \
		eslint $(CLIENT_DIR)/*.js || true; \
	else \
		echo "$(YELLOW)⚠ eslint not installed, skipping$(RESET)"; \
	fi

fmt: fmt-server ## Format all code

fmt-server: ## Format Rust code
	@echo "$(CYAN)▶ Formatting Rust code...$(RESET)"
	@cd $(SERVER_DIR) && cargo fmt
	@echo "$(GREEN)✓ Code formatted$(RESET)"

check: ## Run cargo check (fast compile check)
	@echo "$(CYAN)▶ Running cargo check...$(RESET)"
	@cd $(SERVER_DIR) && cargo check
	@echo "$(GREEN)✓ Check passed$(RESET)"

# ----------------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------------
.PHONY: clean clean-plugin clean-server clean-docker reset prune fix-permissions

clean: clean-plugin clean-server ## Clean all build artifacts
	@rm -rf dist $(PROJECT_NAME)-release.zip
	@echo "$(GREEN)✓ Cleaned$(RESET)"

clean-plugin: ## Clean plugin build artifacts
	@echo "$(YELLOW)▶ Cleaning plugin artifacts...$(RESET)"
	@rm -rf $(PLUGIN_DIR)/dist $(PLUGIN_DIR)/bin $(PLUGIN_DIR)/obj 2>/dev/null || \
		(echo "$(YELLOW)⚠ Some files owned by root, using sudo...$(RESET)" && \
		 sudo rm -rf $(PLUGIN_DIR)/dist $(PLUGIN_DIR)/bin $(PLUGIN_DIR)/obj)
	@rm -rf $(PLUGIN_DIR)/refs
	@rm -f $(PLUGIN_DIR)/Web/plugin.js $(PLUGIN_DIR)/Web/owp-*.js

fix-permissions: ## Fix ownership of Docker-created files
	@echo "$(YELLOW)▶ Fixing file permissions...$(RESET)"
	@if [ -d "$(PLUGIN_DIR)/dist" ] && [ "$$(stat -c '%u' $(PLUGIN_DIR)/dist 2>/dev/null)" != "$(UID)" ]; then \
		echo "  Fixing $(PLUGIN_DIR)/dist..."; \
		sudo chown -R $(UID):$(GID) $(PLUGIN_DIR)/dist; \
	fi
	@if [ -d "$(PLUGIN_DIR)/obj" ] && [ "$$(stat -c '%u' $(PLUGIN_DIR)/obj 2>/dev/null)" != "$(UID)" ]; then \
		echo "  Fixing $(PLUGIN_DIR)/obj..."; \
		sudo chown -R $(UID):$(GID) $(PLUGIN_DIR)/obj; \
	fi
	@echo "$(GREEN)✓ Permissions fixed$(RESET)"

clean-server: ## Clean server build artifacts
	@echo "$(YELLOW)▶ Cleaning server artifacts...$(RESET)"
	@rm -rf $(SERVER_DIR)/target

clean-docker: ## Remove Docker images and volumes
	@echo "$(RED)▶ Removing Docker resources...$(RESET)"
	@$(COMPOSE) down -v --rmi local
	@echo "$(GREEN)✓ Docker resources removed$(RESET)"

reset: down clean-docker clean ## Full reset (stop, remove containers/volumes, clean artifacts)
	@echo "$(GREEN)✓ Full reset complete$(RESET)"

prune: ## Remove unused Docker resources (system-wide)
	@echo "$(RED)▶ Pruning Docker system...$(RESET)"
	@docker system prune -f
	@echo "$(GREEN)✓ Docker pruned$(RESET)"

# ----------------------------------------------------------------------------
# Utilities
# ----------------------------------------------------------------------------
.PHONY: info env urls tree

info: ## Show project information
	@echo ""
	@echo "$(BOLD)$(PROJECT_NAME)$(RESET)"
	@echo ""
	@echo "$(CYAN)Directories:$(RESET)"
	@echo "  Plugin:  $(PLUGIN_DIR)"
	@echo "  Client:  $(CLIENT_DIR)"
	@echo "  Server:  $(SERVER_DIR)"
	@echo ""
	@echo "$(CYAN)Docker:$(RESET)"
	@echo "  Compose: $(COMPOSE_FILE)"
	@echo ""
	@echo "$(CYAN)Git:$(RESET)"
	@echo "  Branch:  $$(git branch --show-current)"
	@echo "  Status:  $$(git status --short | wc -l) changes"
	@echo ""

env: ## Show environment variables used
	@echo "$(BOLD)Environment Variables:$(RESET)"
	@echo ""
	@echo "  JELLYFIN_PORT      = $${JELLYFIN_PORT:-8096} (default: 8096)"
	@echo "  SESSION_SERVER_PORT = $${SESSION_SERVER_PORT:-3000} (default: 3000)"
	@echo "  MEDIA_DIR          = $${MEDIA_DIR:-$$HOME/Videos/Movies}"
	@echo "  NO_COLOR           = $${NO_COLOR:-} (set to disable colors)"
	@echo ""

urls: ## Show service URLs
	@echo ""
	@echo "$(BOLD)Service URLs:$(RESET)"
	@echo ""
	@echo "  $(CYAN)Jellyfin Web:$(RESET)     http://localhost:$${JELLYFIN_PORT:-8096}"
	@echo "  $(CYAN)Session Server:$(RESET)   http://localhost:$${SESSION_SERVER_PORT:-3000}"
	@echo "  $(CYAN)Health Check:$(RESET)     http://localhost:$${SESSION_SERVER_PORT:-3000}/health"
	@echo "  $(CYAN)WebSocket:$(RESET)        ws://localhost:$${SESSION_SERVER_PORT:-3000}/ws"
	@echo ""

tree: ## Show project structure
	@echo "$(BOLD)Project Structure:$(RESET)"
	@tree -L 2 -I 'target|node_modules|dist|obj|bin|refs|*.dll' --dirsfirst 2>/dev/null || find . -maxdepth 2 -type d | grep -v -E '\.(git|cache)' | head -30

# ----------------------------------------------------------------------------
# Quick aliases
# ----------------------------------------------------------------------------
.PHONY: u d r l s b

u: up      ## Alias: up
d: down    ## Alias: down
r: restart ## Alias: restart
l: logs    ## Alias: logs
s: status  ## Alias: status
b: build   ## Alias: build
