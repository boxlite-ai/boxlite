PHONY_TARGETS += dev\:runner-ci test\:runner-ci\:infra test\:runner-ci\:dind
PHONY_TARGETS += fmt\:runner-ci
PHONY_TARGETS += test\:runner-ci\:cache
PHONY_TARGETS += test\:runner-ci\:cache-diagnose
ACTION ?= up

PHONY_TARGETS += kernel\:dind
kernel\:dind:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.kernel

PHONY_TARGETS += kernel\:swarm
kernel\:swarm:
	@scripts/build/build-linux-swarm-kernel.sh

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

PHONY_TARGETS += test\:runner-ci\:swarm-stop
test\:runner-ci\:swarm-stop:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.swarm_acceptance --preserve-stop

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

fmt\:runner-ci: fmt\:swarm
	@.venv/bin/ruff format scripts/build/prepare_dind_firmware.py tests/scripts/test_runner_artifact_firmware.py
	@.venv/bin/ruff format apps/infra-local/compose/provision.py tests/scripts/test_runner_provision.py tests/scripts/test_linux_firmware_source.py
	@.venv/bin/ruff format apps/infra-local/compose/acceptance.py apps/infra-local/compose/kernel.py apps/infra-local/compose/cache_acceptance.py apps/infra-local/compose/docker_cache_acceptance.py
	@.venv/bin/ruff format sdks/python/tests/test_cache_volume_contract.py
	@gofmt -w apps/runner/pkg/boxlite/caches.go apps/runner/pkg/boxlite/caches_test.go apps/runner/pkg/boxlite/client.go apps/runner/pkg/boxlite/volumes.go apps/runner/pkg/api/controllers/boxlite_cache.go apps/runner/pkg/api/dto/volume.go apps/runner/pkg/api/server.go

PHONY_TARGETS += lint\:runner-ci
lint\:runner-ci: lint\:swarm
	@.venv/bin/ruff check scripts/build/prepare_dind_firmware.py tests/scripts/test_runner_artifact_firmware.py
	@.venv/bin/ruff check apps/infra-local/compose/acceptance.py apps/infra-local/compose/kernel.py apps/infra-local/compose/provision.py tests/scripts/test_runner_provision.py tests/scripts/test_linux_firmware_source.py
	@.venv/bin/ruff check apps/infra-local/compose/docker_cache_acceptance.py
	@sh -n apps/infra-local/fixtures/docker-cache.sh

test\:runner-ci\:cache:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.cache_acceptance

test\:runner-ci\:cache-diagnose:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.cache_acceptance --diagnose

PHONY_TARGETS += test\:runner-ci\:docker-cache
test\:runner-ci\:docker-cache:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.docker_cache_acceptance

PHONY_TARGETS += test\:runner-ci\:docker-cache-diagnose
test\:runner-ci\:docker-cache-diagnose:
	@PYTHONUNBUFFERED=1 PYTHONPATH=apps/infra-local .venv/bin/python -m compose.docker_cache_acceptance --diagnose
