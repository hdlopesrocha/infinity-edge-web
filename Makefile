# Infinity Edge — developer entry points.
#
# The npm scripts stay the source of truth; this file is the discoverable front
# door (run `make` for the list) and adds the source-only line count.
#
#   make            # help
#   make cloc       # lines of source code (no assets, JSON, docs, build trees)

SHELL := /bin/bash
.DEFAULT_GOAL := help

NPM   ?= npm
CMAKE ?= cmake
CLOC  ?= cloc
JOBS  ?= $(shell nproc 2>/dev/null || echo 2)

DIST      := dist
CXX_BUILD := build/server

# Dependencies, generated assets, build trees and prose never count as source.
CLOC_EXCLUDE_DIRS := node_modules,dist,build,public,certs,.git,docs
# Only the languages this project writes: JSON levels, Markdown, lockfiles and
# binaries are filtered out by cloc itself.
CLOC_LANGS := TypeScript,JavaScript,Vuejs Component,C++,C/C++ Header,CSS,HTML,Python,CMake,GLSL

.PHONY: help install dev build preview typecheck test test-watch verify \
        cxx cxx-test serve relay mp-server e2e boot-e2e mp-e2e room-e2e server-e2e ui-e2e \
        cloc cloc-files clean clean-server distclean

help: ## show this help
	@echo "Infinity Edge — developer targets"
	@echo
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "Browser e2e needs 'make relay' + 'make serve' (server-e2e is self-contained);"
	@echo "see docs/multiplayer.md for the full verification matrix."

install: ## install exact dependencies from package-lock.json
	$(NPM) ci

dev: ## Vite dev server on :5173
	$(NPM) run dev

build: ## type-check + production build into dist/
	$(NPM) run build

preview: ## serve the production build with Vite
	$(NPM) run preview

typecheck: ## vue-tsc --noEmit
	$(NPM) run typecheck

test: ## Vitest unit/integration tests
	$(NPM) test

test-watch: ## Vitest in watch mode
	$(NPM) run test:watch

verify: ## typecheck + unit tests + C++ tests (no browser)
	$(MAKE) typecheck test cxx-test

cxx: ## build the C++ server -> build/server/ie-server
	$(CMAKE) -S server -B $(CXX_BUILD)
	$(CMAKE) --build $(CXX_BUILD) -j $(JOBS)

cxx-test: cxx ## run the C++ tests (ctest)
	ctest --test-dir $(CXX_BUILD) --output-on-failure

serve: build cxx ## build both, then serve dist/ + WebSocket game on :8091
	$(NPM) run server:run

relay: ## local Nostr relay for multiplayer on ws://127.0.0.1:7777
	$(NPM) run mp:relay

mp-server: build cxx ## dedicated C++ room on :8097 (hosts, does not play)
	$(NPM) run mp:server

e2e: boot-e2e mp-e2e room-e2e server-e2e ui-e2e ## all browser suites (relay + serve must be up)

boot-e2e: ## boot sequence ends on the painted main menu (serve up)
	$(NPM) run boot:e2e

mp-e2e: ## browser host + guests over WebRTC (relay + serve up)
	$(NPM) run mp:e2e

room-e2e: ## waiting room: chat/voice/teams/PLAY with real input (relay + serve up)
	$(NPM) run room:e2e

server-e2e: ## self-contained dedicated server + two browser guests
	$(NPM) run mp:server-e2e

ui-e2e: ## real-mouse menus/lobby/pause run (serve up)
	$(NPM) run ui:e2e

cloc: ## count source code only (no assets, JSON, docs or build trees)
	@$(CLOC) --quiet --exclude-dir=$(CLOC_EXCLUDE_DIRS) --include-lang="$(CLOC_LANGS)" .

cloc-files: ## per-file source line count (same filter as cloc)
	@$(CLOC) --quiet --by-file --exclude-dir=$(CLOC_EXCLUDE_DIRS) --include-lang="$(CLOC_LANGS)" .

clean: ## remove the web build output (dist/)
	rm -rf $(DIST)

clean-server: ## remove the C++ build tree (next build re-fetches libdatachannel)
	rm -rf $(CXX_BUILD)

distclean: clean clean-server ## clean + clean-server (node_modules is kept)
	@:
