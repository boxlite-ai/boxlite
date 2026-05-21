# BoxLite-based infra-local orchestrator
#
# All targets are thin wrappers around `python -m boxlite_local`. The Python
# CLI is the source of truth — see `python -m boxlite_local --help` for the
# full surface area. This Makefile exists for muscle memory + tab completion.

PY ?= python

.PHONY: help up down ps doctor logs wipe itest test install

help:                  ## show this help
	@awk -F':.*## ' '/^[a-zA-Z][a-zA-Z0-9_-]*:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install:               ## install the package + test extras
	$(PY) -m pip install -e ".[test]"

up:                    ## bring all services up (runs doctor preflight first)
	$(PY) -m boxlite_local up

down:                  ## stop + remove all services
	$(PY) -m boxlite_local down

wipe:                  ## stop + remove + wipe data dir
	$(PY) -m boxlite_local down --wipe

ps:                    ## list running boxlite-local-* boxes
	$(PY) -m boxlite_local ps

doctor:                ## run preflight checks (SDK + runtime + port conflicts)
	$(PY) -m boxlite_local doctor

test:                  ## run unit tests (no BoxLite required)
	pytest tests/unit -q

itest:                 ## run integration test (requires BoxLite runtime, ~30s)
	BOXLITE_INTEGRATION=1 pytest tests/integration -v -s
