# infra-local — thin aliases over `python -m compose <cmd>`.
# The Python CLI is the source of truth: `python -m compose --help`.
# This Makefile exists for muscle memory + tab completion.

PY ?= python

.PHONY: help install up down status logs restart reset nuke

help:      ## show this help
	@awk -F':.*## ' '/^[a-zA-Z][a-zA-Z0-9_-]*:.*## / { printf "  %-9s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install:   ## install the package (editable; pulls the boxlite SDK)
	$(PY) -m pip install -e .

up:        ## ensure L1 boxes + start L2 (COMPONENTS="api runner")
	$(PY) -m compose up $(COMPONENTS)

down:      ## stop L2 procs (ARGS=--all also stops L1 boxes)
	$(PY) -m compose down $(ARGS) $(COMPONENTS)

status:    ## one-screen L1 + L2 health
	$(PY) -m compose status

logs:      ## tail a component log (COMPONENT=api|all)
	$(PY) -m compose logs $(COMPONENT)

restart:   ## restart L2 proc(s) / recreate L1 box(es) (COMPONENTS="runner dex")
	$(PY) -m compose restart $(COMPONENTS)

reset:     ## wipe L2 runtime state (ARGS=--hard also rebuilds the schema)
	$(PY) -m compose reset $(ARGS)

nuke:      ## tear down EVERYTHING (L1 boxes + data + logs)
	$(PY) -m compose nuke
