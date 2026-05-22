# BoxLite-based infra-local orchestrator
#
# All targets are thin wrappers around `python -m boxlite_local`. The Python
# CLI is the source of truth — see `python -m boxlite_local --help` for the
# full surface area. This Makefile exists for muscle memory + tab completion.

PY ?= python

.PHONY: help up down ps doctor logs wipe itest test install load-schema up-with-schema e2e itest-all \
        stack-build stack-up stack-down stack-restart stack-status stack-logs stack-reset stack-reset-hard stack-nuke \
        seed-init-data

help:                  ## show this help
	@awk -F':.*## ' '/^[a-zA-Z][a-zA-Z0-9_-]*:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

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

itest:                 ## run integration smoke test (requires BoxLite runtime, ~30s)
	BOXLITE_INTEGRATION=1 pytest tests/integration/test_multi_service.py -v -s

e2e:                   ## run comprehensive E2E suite (~60s, ~90s with smoke)
	BOXLITE_INTEGRATION=1 pytest tests/integration/test_e2e_full.py -v -s

itest-all:             ## run BOTH integration suites (~90s)
	BOXLITE_INTEGRATION=1 pytest tests/integration -v

load-schema:           ## load apps/infra-local/sql/schema-baseline.sql into local pg (run after `make up`)
	./scripts/apply-schema.sh

up-with-schema:        ## make up + make load-schema (one-shot for a fresh stack)
	$(MAKE) up
	$(MAKE) load-schema

seed-init-data:        ## ensure dashboard-required base data (admin org, default region, wait snapshot)
	./scripts/seed-init-data.sh

# ── L2 stack wrappers (L1 + native API/Runner/Proxy/Dashboard) ───────────────

stack-build:           ## build native runner + proxy binaries
	./scripts/stack-build.sh

stack-up:              ## ensure L1 up + start all L2 native processes (idempotent)
	./scripts/stack-up.sh $(COMPONENTS)

stack-down:            ## stop all L2 native processes (L1 stays up; add ARGS=--all to stop L1 too)
	./scripts/stack-down.sh $(ARGS) $(COMPONENTS)

stack-restart:         ## restart one or more L2 components (runner = also rebuild)
	./scripts/stack-restart.sh $(COMPONENTS)

stack-status:          ## one-screen health check across L1 + L2
	./scripts/stack-status.sh

stack-logs:            ## tail logs (COMPONENT=api|runner|proxy|dashboard|all)
	./scripts/stack-logs.sh $(COMPONENT)

stack-reset:           ## wipe L2 runtime state (PG user data + runner home; L1 + schema preserved)
	./scripts/stack-reset.sh

stack-reset-hard:      ## like stack-reset, but also re-applies prod schema baseline
	./scripts/stack-reset.sh --hard

stack-nuke:            ## ABSOLUTE NUKE: L1 boxes destroyed + data wiped + logs cleared
	./scripts/stack-reset.sh --nuke
