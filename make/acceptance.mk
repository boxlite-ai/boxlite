PHONY_TARGETS += dev\:runner-ci test\:runner-ci\:infra test\:runner-ci\:dind
PHONY_TARGETS += test\:runner-ci\:fs-local
PHONY_TARGETS += test\:runner-ci\:fs
PHONY_TARGETS += test\:integration\:snapshots
PHONY_TARGETS += fmt\:runner-ci
PHONY_TARGETS += test\:runner-ci\:children test\:runner-ci\:children-local
ACTION ?= up

PHONY_TARGETS += kernel\:dind
kernel\:dind:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.kernel

dev\:runner-ci: dev\:go dev\:python dev\:runner-ci\:proxy
	@PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance build

PHONY_TARGETS += dev\:runner-ci\:proxy
dev\:runner-ci\:proxy:
	@PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance build-proxy

test\:runner-ci\:infra:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance $(ACTION)

test\:runner-ci\:dind:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance dind

PHONY_TARGETS += test\:runner-ci\:swarm
TOPOLOGY ?= single
test\:runner-ci\:swarm:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.swarm_acceptance --topology $(TOPOLOGY)

PHONY_TARGETS += test\:runner-ci\:swarm-diagnose
test\:runner-ci\:swarm-diagnose:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.swarm_acceptance --diagnose

PHONY_TARGETS += test\:runner-ci\:swarm-transport
test\:runner-ci\:swarm-transport:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.swarm_acceptance --diagnose-transport

PHONY_TARGETS += fmt\:swarm lint\:swarm
fmt\:swarm:
	@.venv/bin/ruff format apps/infra-local/compose/swarm_acceptance.py

lint\:swarm:
	@.venv/bin/ruff check apps/infra-local/compose/swarm_acceptance.py

PHONY_TARGETS += test\:runner-ci\:dind-diagnose
test\:runner-ci\:dind-diagnose:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance diagnose-dind

test\:runner-ci\:fs-local:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.snapshot_acceptance

test\:runner-ci\:fs:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.snapshot_acceptance --runner

fmt\:runner-ci:
	@.venv/bin/ruff format apps/infra-local/compose/acceptance.py apps/infra-local/compose/kernel.py apps/infra-local/compose/snapshot_acceptance.py apps/infra-local/compose/snapshot_children_acceptance.py

test\:runner-ci\:children:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.snapshot_children_acceptance

PHONY_TARGETS += test\:runner-ci\:snapshot-copy
test\:runner-ci\:snapshot-copy:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.snapshot_copy_acceptance

PHONY_TARGETS += fmt\:snapshot-copy lint\:snapshot-copy
fmt\:snapshot-copy:
	@.venv/bin/ruff format apps/infra-local/compose/snapshot_copy_acceptance.py
	@gofmt -w apps/runner/pkg/boxlite/snapshots.go apps/runner/pkg/api/controllers/snapshot_transfer.go apps/runner/pkg/api/controllers/boxlite_snapshot_test.go

lint\:snapshot-copy:
	@.venv/bin/ruff check apps/infra-local/compose/snapshot_copy_acceptance.py

test\:runner-ci\:children-local:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.snapshot_children_acceptance --local

test\:integration\:snapshots:
	@BOXLITE_TEST_IMAGE=alpine:3.23 cargo test -p boxlite --features krun,gvproxy --test snapshot --test snapshot_clone_deep -- --test-threads=1 --nocapture snapshot
