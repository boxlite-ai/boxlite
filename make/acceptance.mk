PHONY_TARGETS += kernel\:dind test\:docker\:dind fmt\:docker lint\:docker
PHONY_TARGETS += test\:docker\:swarm

DIND_FIRMWARE_DIR ?= $(PROJECT_ROOT)/.apps-local/firmware-dind
DIND_BUILD_ARGS ?=
DOCKER_ACCEPTANCE_ARGS ?=
DOCKER_PYTHON ?= .venv/bin/python
DOCKER_RUFF ?= .venv/bin/ruff

kernel\:dind: _ensure-python-deps
	@.venv/bin/python scripts/build/prepare_dind_firmware.py "$(DIND_FIRMWARE_DIR)" $(DIND_BUILD_ARGS)

test\:docker\:dind:
	@$(DOCKER_PYTHON) tests/docker/acceptance.py $(DOCKER_ACCEPTANCE_ARGS)

test\:docker\:swarm:
	@$(DOCKER_PYTHON) tests/docker/swarm.py $(DOCKER_ACCEPTANCE_ARGS)

fmt\:docker:
	@$(DOCKER_RUFF) format scripts/build/prepare_dind_firmware.py tests/scripts/test_linux_firmware_source.py tests/scripts/test_macos_firmware_source.py tests/docker

lint\:docker:
	@$(DOCKER_RUFF) check scripts/build/prepare_dind_firmware.py tests/scripts/test_linux_firmware_source.py tests/scripts/test_macos_firmware_source.py tests/docker
	@bash -n scripts/build/build-dind-kernel.sh
