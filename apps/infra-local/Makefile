# infra-local — thin aliases over `python -m compose <cmd>`.
# The Python CLI is the source of truth: `python -m compose --help`.
# This Makefile exists for muscle memory + tab completion.

# Repo-local venv so `make up` works with zero manual setup — no activate, no
# global pip, no PEP-668 hassle. Created on first use (see the venv target).
# Override PY to use your own interpreter instead.
VENV ?= ../../.venv-infra
PY ?= $(VENV)/bin/python

READY := $(VENV)/.infra-local-installed

.PHONY: help install up down status logs restart reset nuke test test-storage test-storage-client

help:      ## show this help
	@awk -F':.*## ' '/^[a-zA-Z][a-zA-Z0-9_-]*:.*## / { printf "  %-9s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# Keep environment creation separate from a successful package installation:
# an interrupted pip invocation must be retried even if Python already exists.
$(VENV)/bin/python:
	python3 -m venv $(VENV)

$(READY): pyproject.toml $(VENV)/bin/python
	$(VENV)/bin/python -m pip install -q -e .
	touch $(READY)

install: $(READY)   ## create the venv + install the package (editable)

up: $(READY)   ## ensure L1 boxes + start L2 (COMPONENTS="api runner")
	$(PY) -m compose up $(COMPONENTS)

down: $(READY)   ## stop L2 procs (ARGS=--all also stops L1 boxes)
	$(PY) -m compose down $(ARGS) $(COMPONENTS)

status: $(READY)   ## one-screen L1 + L2 health
	$(PY) -m compose status

logs: $(READY)   ## tail a component log (COMPONENT=api|all)
	$(PY) -m compose logs $(COMPONENT)

restart: $(READY)   ## restart L2 proc(s) / recreate L1 box(es) (COMPONENTS="runner dex")
	$(PY) -m compose restart $(COMPONENTS)

reset: $(READY)   ## wipe L2 runtime state (ARGS=--hard also rebuilds the schema)
	$(PY) -m compose reset $(ARGS)

nuke: $(READY)   ## tear down EVERYTHING (L1 boxes + data + logs)
	$(PY) -m compose nuke

test: $(READY)   ## run deterministic startup regressions (no VMs)
	$(PY) -m unittest discover -s tests -p 'test_*.py' -v $(if $(FILTER),-k '$(FILTER)',)

test-storage: $(READY)   ## isolated real S3 VM: CRUD + recreate + persistence
	$(PY) tests/smoke_storage.py

test-storage-client: $(READY)   ## verify signed CRUD using a temporary object on local S3
	$(PY) tests/smoke_storage.py --client-only
