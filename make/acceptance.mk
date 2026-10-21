PHONY_TARGETS += dev\:runner-ci test\:runner-ci\:infra test\:runner-ci\:dind
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

PHONY_TARGETS += fmt\:runner-ci
fmt\:runner-ci:
	@.venv/bin/ruff format apps/infra-local/compose/acceptance.py apps/infra-local/compose/kernel.py
