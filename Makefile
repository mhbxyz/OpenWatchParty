.PHONY: help up down sync-refs build-plugin logs

help:
	@echo "OpenSyncParty targets:"
	@echo "  make up           - start jellyfin stack (and build plugin if needed)"
	@echo "  make down         - stop jellyfin stack"
	@echo "  make sync-refs    - sync Jellyfin DLL refs from container"
	@echo "  make build-plugin - build Jellyfin server plugin"
	@echo "  make logs         - tail Jellyfin container logs"

up: build-plugin
	docker compose -f infra/docker/docker-compose.yml restart jellyfin-dev

down:
	docker compose -f infra/docker/docker-compose.yml down

sync-refs:
	./scripts/sync-jellyfin-refs.sh

start-server:
	docker compose -f infra/docker/docker-compose.yml up -d jellyfin-dev && sleep 5

build-plugin: start-server sync-refs
	docker compose -f infra/docker/docker-compose.yml run --rm plugin-builder

logs:
	docker compose -f infra/docker/docker-compose.yml logs -f jellyfin-dev
