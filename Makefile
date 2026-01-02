.PHONY: help up down restart sync-refs build-plugin rebuild-all clean logs status

COMPOSE = docker compose -f infra/docker/docker-compose.yml
COMPOSE_TOOLS = docker compose --profile tools -f infra/docker/docker-compose.yml

help:
	@echo "OpenSyncParty targets:"
	@echo "  make up           - start jellyfin stack (and build plugin if needed)"
	@echo "  make down         - stop jellyfin stack"
	@echo "  make restart      - restart jellyfin stack"
	@echo "  make sync-refs    - sync Jellyfin DLL refs from container"
	@echo "  make build-plugin - build Jellyfin server plugin"
	@echo "  make rebuild-all  - rebuild plugin, images, and restart containers"
	@echo "  make clean        - remove local build artifacts"
	@echo "  make logs         - tail Jellyfin container logs"
	@echo "  make status       - show compose status"

up: build-plugin
	$(COMPOSE) up -d session-server jellyfin-dev

down:
	$(COMPOSE) down

sync-refs:
	./scripts/sync-jellyfin-refs.sh

start-server:
	$(COMPOSE) up -d session-server jellyfin-dev && sleep 5

build-plugin: start-server sync-refs
	cp clients/web-plugin/plugin.js plugins/jellyfin/OpenSyncParty/Web/plugin.js
	$(COMPOSE_TOOLS) run --rm plugin-builder

restart:
	$(COMPOSE) restart session-server jellyfin-dev

rebuild-all: build-plugin
	$(COMPOSE) build
	$(COMPOSE) up -d --force-recreate

clean:
	rm -rf plugins/jellyfin/OpenSyncParty/dist plugins/jellyfin/OpenSyncParty/refs plugins/jellyfin/OpenSyncParty/Web/plugin.js session-server-rust/target

logs:
	$(COMPOSE) logs -f --tail=200 jellyfin-dev session-server

status:
	$(COMPOSE) ps
