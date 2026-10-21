PHONY_TARGETS += dev\:runner-ci test\:runner-ci\:infra test\:runner-ci\:dind
ACTION ?= up

PHONY_TARGETS += kernel\:dind
kernel\:dind:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.kernel

dev\:runner-ci: dev\:go dev\:python
	@PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance build

test\:runner-ci\:infra:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance $(ACTION)

test\:runner-ci\:dind:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance dind

PHONY_TARGETS += test\:runner-ci\:dind-diagnose
test\:runner-ci\:dind-diagnose:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.acceptance diagnose-dind

PHONY_TARGETS += fmt\:runner-ci
fmt\:runner-ci:
	@.venv/bin/ruff format apps/infra-local/compose/acceptance.py apps/infra-local/compose/kernel.py
