# yayapms
#   make setup            install pinned deps (first time only)
#   make dev              run the app -> http://localhost:5173
#   make data             finish any missing states + rebuild map files
#   make data S="TX NC"   recompute specific states
#   make audit            supply-chain checks

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
NVM_DIR ?= $(HOME)/.nvm
NODE := . "$(NVM_DIR)/nvm.sh" >/dev/null && nvm use --silent >/dev/null && cd web &&
PY := .venv/bin/python

.PHONY: help setup dev data audit

help:
	@sed -n '2,6p' Makefile | sed 's/^#/ /'

setup:
	@[ -x $(PY) ] || python3 -m venv .venv
	.venv/bin/pip install -q --no-deps --only-binary=:all: -r pipeline/requirements.lock
	@. "$(NVM_DIR)/nvm.sh" >/dev/null && (nvm ls "$$(cat .nvmrc)" >/dev/null 2>&1 || nvm install "$$(cat .nvmrc)")
	$(NODE) npm ci

dev:
	$(NODE) npm run dev

data:
	pipeline/run_all.sh $(if $(S),--force $(S))

audit:
	$(NODE) npm audit signatures
	@tmp=$$(mktemp -d) && trap 'rm -rf "$$tmp"' EXIT && \
	.venv/bin/pip install -q --dry-run --ignore-installed --no-deps --only-binary=:all: \
	  --report "$$tmp/r.json" -r pipeline/requirements.lock && \
	$(PY) tools/pypi_age_check.py "$$tmp/r.json" 14 | grep -v '^OK' || echo "all Python packages >= 14 days old"
