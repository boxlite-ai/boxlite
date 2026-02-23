PHONY_TARGETS += setup

setup:
	@if [ "$$(uname)" = "Darwin" ]; then \
		bash $(SCRIPT_DIR)/setup/setup-macos.sh; \
	elif [ "$$(uname)" = "Linux" ]; then \
		if [ -f /etc/os-release ] && grep -q "manylinux" /etc/os-release 2>/dev/null; then \
			bash $(SCRIPT_DIR)/setup/setup-manylinux.sh; \
		elif [ -f /etc/os-release ] && grep -q "musllinux" /etc/os-release 2>/dev/null; then \
			bash $(SCRIPT_DIR)/setup/setup-musllinux.sh; \
		elif command -v apt-get >/dev/null 2>&1; then \
			bash $(SCRIPT_DIR)/setup/setup-ubuntu.sh; \
		elif command -v apk >/dev/null 2>&1; then \
			bash $(SCRIPT_DIR)/setup/setup-musllinux.sh; \
		elif command -v yum >/dev/null 2>&1; then \
			bash $(SCRIPT_DIR)/setup/setup-manylinux.sh; \
		else \
			echo "❌ Unsupported Linux distribution"; \
			echo "   Supported: Ubuntu/Debian (apt-get), RHEL/CentOS/manylinux (yum), or Alpine/musllinux (apk)"; \
			exit 1; \
		fi; \
	else \
		echo "❌ Unsupported platform: $$(uname)"; \
		exit 1; \
	fi
