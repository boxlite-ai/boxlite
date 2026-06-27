# infra-local — thin aliases over `python -m compose <cmd>`.
# The Python CLI is the source of truth: `python -m compose --help`.
# This Makefile exists for muscle memory + tab completion.

# Repo-local venv so `make up` works with zero manual setup — no activate, no
# global pip, no PEP-668 hassle. Created on first use (see the venv target).
# Override PY to use your own interpreter instead.
VENV ?= ../../.venv-infra
PY ?= $(VENV)/bin/python

.PHONY: help install up down status logs restart reset nuke

help:      ## show this help
	@awk -F':.*## ' '/^[a-zA-Z][a-zA-Z0-9_-]*:.*## / { printf "  %-9s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# Create the repo-local venv + install the compose package. A file target, so
# it runs only when the venv's python is missing (idempotent). Everything below
# depends on it, so a fresh checkout's first `make <anything>` bootstraps once.
$(VENV)/bin/python:
	@echo "[infra-local] creating repo-local venv + installing compose package (first run only)..."
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -e .

install: $(VENV)/bin/python   ## create the venv + install the package (editable)

up: $(VENV)/bin/python   ## ensure L1 boxes + start L2 (COMPONENTS="api runner")
	$(PY) -m compose up $(COMPONENTS)

down: $(VENV)/bin/python   ## stop L2 procs (ARGS=--all also stops L1 boxes)
	$(PY) -m compose down $(ARGS) $(COMPONENTS)

status: $(VENV)/bin/python   ## one-screen L1 + L2 health
	$(PY) -m compose status

logs: $(VENV)/bin/python   ## tail a component log (COMPONENT=api|all)
	$(PY) -m compose logs $(COMPONENT)

restart: $(VENV)/bin/python   ## restart L2 proc(s) / recreate L1 box(es) (COMPONENTS="runner dex")
	$(PY) -m compose restart $(COMPONENTS)

reset: $(VENV)/bin/python   ## wipe L2 runtime state (ARGS=--hard also rebuilds the schema)
	$(PY) -m compose reset $(ARGS)

nuke: $(VENV)/bin/python   ## tear down EVERYTHING (L1 boxes + data + logs)
	$(PY) -m compose nuke
