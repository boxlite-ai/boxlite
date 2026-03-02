PHONY_TARGETS += setup setup\:build setup\:test setup\:dev

# Local-dev default: same as before (build + test/dev extras)
setup: setup\:dev

setup\:dev: setup\:build setup\:test

# Build-only setup (preferred for CI)
setup\:build:
	@if [ "$$(uname)" = "Darwin" ]; then \
		BOXLITE_SETUP_MODE=build bash $(SCRIPT_DIR)/setup/setup-macos.sh; \
	elif [ "$$(uname)" = "Linux" ]; then \
		if [ -f /etc/os-release ] && grep -q "manylinux" /etc/os-release 2>/dev/null; then \
			BOXLITE_SETUP_MODE=build bash $(SCRIPT_DIR)/setup/setup-manylinux.sh; \
		elif [ -f /etc/os-release ] && grep -q "musllinux" /etc/os-release 2>/dev/null; then \
			BOXLITE_SETUP_MODE=build bash $(SCRIPT_DIR)/setup/setup-musllinux.sh; \
		elif command -v apt-get >/dev/null 2>&1; then \
			BOXLITE_SETUP_MODE=build bash $(SCRIPT_DIR)/setup/setup-ubuntu.sh; \
		elif command -v apk >/dev/null 2>&1; then \
			BOXLITE_SETUP_MODE=build bash $(SCRIPT_DIR)/setup/setup-musllinux.sh; \
		elif command -v yum >/dev/null 2>&1; then \
			BOXLITE_SETUP_MODE=build bash $(SCRIPT_DIR)/setup/setup-manylinux.sh; \
		else \
			echo "❌ Unsupported Linux distribution"; \
			echo "   Supported: Ubuntu/Debian (apt-get), RHEL/CentOS/manylinux (yum), or Alpine/musllinux (apk)"; \
			exit 1; \
		fi; \
	else \
		echo "❌ Unsupported platform: $$(uname)"; \
		exit 1; \
	fi

# Test/dev extras setup
setup\:test:
	@bash $(SCRIPT_DIR)/setup/setup-test.sh
	@$(MAKE) _ensure-python-deps
