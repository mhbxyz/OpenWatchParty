UV ?= uv
VENV ?= .venv
PY := $(VENV)/bin/python

.PHONY: help venv sync-server sync-mpv sync-tests sync-all server demo mpv-host mpv-join test-harness \
	compose-up compose-down compose-server compose-demo compose-harness

help:
	@echo "OpenSyncParty targets:"
	@echo "  make server        - run session server (uv venv + deps)"
	@echo "  make demo          - serve web demo on :8000"
	@echo "  make mpv-host      - run MPV adapter as host (ROOM=...)"
	@echo "  make mpv-join      - run MPV adapter as joiner (ROOM=...)"
	@echo "  make test-harness  - run protocol harness"
	@echo "  make compose-up    - start docker compose services"
	@echo "  make compose-down  - stop docker compose services"
	@echo "  make compose-demo  - start web demo service"
	@echo "  make compose-server- start session server service"
	@echo "  make compose-harness - run protocol harness service"
	@echo "  make venv          - create uv virtual env"

venv:
	$(UV) venv $(VENV)

sync-server:
	$(UV) sync --group server

sync-mpv:
	$(UV) sync --group mpv

sync-tests:
	$(UV) sync --group tests

sync-all:
	$(UV) sync --group all

server: sync-server
	$(PY) session-server/app.py

demo: venv
	$(PY) -m http.server 8000 --directory clients/web

mpv-host: sync-mpv
	@if [ -z "$(ROOM)" ]; then echo "ROOM is required (e.g. make mpv-host ROOM=my-room)"; exit 1; fi
	$(PY) clients/mpv/opensyncparty.py --room $(ROOM) --host

mpv-join: sync-mpv
	@if [ -z "$(ROOM)" ]; then echo "ROOM is required (e.g. make mpv-join ROOM=my-room)"; exit 1; fi
	$(PY) clients/mpv/opensyncparty.py --room $(ROOM)

test-harness: sync-tests
	$(PY) tests/protocol_harness.py --ws ws://localhost:8999/ws

compose-up:
	docker compose up --build

compose-down:
	docker compose down

compose-server:
	docker compose up --build session-server

compose-demo:
	docker compose up --build web-demo

compose-harness:
	docker compose run --rm protocol-harness
