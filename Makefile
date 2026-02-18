.PHONY: help clean setup package dev\:python dev\:node dist dist\:python dist\:node test test\:rust test\:python test\:node test\:cli fmt fmt-check guest runtime runtime-debug cli skillbox-image

# Ensure cargo is in PATH (source ~/.cargo/env if it exists and cargo is not found)
SHELL := /bin/bash
export PATH := $(HOME)/.cargo/bin:$(PATH)

PROJECT_ROOT := $(shell pwd)
SCRIPT_DIR := $(PROJECT_ROOT)/scripts


help:
	@echo "BoxLite Build Commands:"
	@echo ""
	@echo "  Setup:"
	@echo "    make setup          - Install all dependencies (auto-detects: macOS/Ubuntu/manylinux/musllinux)"
	@echo ""
	@echo "  Cleanup:"
	@echo "    make clean          - Clean everything (cargo, SDKs, .venv, temp files)"
	@echo "    make clean:dist     - Clean only SDK distribution artifacts"
	@echo ""
	@echo "  Code Quality:"
	@echo "    make fmt            - Format all Rust code"
	@echo "    make fmt-check      - Check Rust formatting without modifying files"
	@echo ""
	@echo "  Build:"
	@echo "    make cli            - Build the CLI (boxlite command)"
	@echo "    make guest          - Build the guest binary (cross-compile for VM)"
	@echo "    make skillbox-image - Build SkillBox Docker image (APT_SOURCE=mirrors.aliyun.com for China)"
	@echo ""
	@echo "  Testing:"
	@echo "    make test           - Run all unit tests (Rust + Python + Node.js)"
	@echo "    make test:rust      - Run Rust unit tests"
	@echo "    make test:ffi       - Run BoxLite FFI unit tests"
	@echo "    make test:python    - Run Python SDK unit tests"
	@echo "    make test:node      - Run Node.js SDK unit tests"
	@echo "    make test:cli       - Run CLI integration tests (prepares runtime first)"
	@echo "    make test:integration - Run Rust integration tests (requires VM environment)"
	@echo ""
	@echo "  Local Development:"
	@echo "    make dev:python     - Build and install Python SDK locally (debug mode)"
	@echo "    make dev:node       - Build and link Node.js SDK locally (debug mode)"
	@echo ""
	@echo "  Python Distribution:"
	@echo "    make dist:python    - Build portable wheel with cibuildwheel (auto-detects platform)"
	@echo ""
	@echo "  Node.js Distribution:"
	@echo "    make dist:node      - Build npm package with napi-rs (auto-detects platform)"
	@echo ""
	@echo "  Library Distribution:"
	@echo "    make package        - Package libboxlite for current platform"
	@echo ""
	@echo "Platform: $$(uname) ($$(uname -m))"
	@echo ""

clean:
	@$(SCRIPT_DIR)/clean.sh --mode all

clean\:dist:
	@$(SCRIPT_DIR)/clean.sh --mode dist

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

guest:
	@bash $(SCRIPT_DIR)/build/build-guest.sh

runtime:
	@bash $(SCRIPT_DIR)/build/build-runtime.sh --profile release

runtime-debug:
	@bash $(SCRIPT_DIR)/build/build-runtime.sh --profile debug

cli: runtime-debug
	@echo "🔨 Building boxlite CLI..."
	@cargo build -p boxlite-cli
	@echo "✅ CLI built: ./target/debug/boxlite"

# Build SkillBox container image (all-in-one AI CLI with noVNC)
# Usage: make skillbox-image [APT_SOURCE=mirrors.aliyun.com]
skillbox-image:
	@echo "🐳 Building SkillBox container image..."
	@docker build $(if $(APT_SOURCE),--build-arg APT_SOURCE=$(APT_SOURCE)) -t boxlite-skillbox:latest boxlite/resources/images/skillbox/
	@echo "✅ SkillBox image built: boxlite-skillbox:latest"

dist\:python:
	@if [ ! -d .venv ]; then \
		echo "📦 Creating virtual environment..."; \
		python3 -m venv .venv; \
	fi

	@echo "📦 Installing cibuildwheel..."
	@. .venv/bin/activate && pip install -q cibuildwheel

	@if [ "$$(uname)" = "Darwin" ]; then \
		source .venv/bin/activate; \
		cibuildwheel --only cp314-macosx_arm64 sdks/python; \
	elif [ "$$(uname)" = "Linux" ]; then \
		source .venv/bin/activate; \
		bash $(SCRIPT_DIR)/build/build-guest.sh; \
		cibuildwheel --platform linux sdks/python; \
	else \
		echo "❌ Unsupported platform: $$(uname)"; \
		exit 1; \
	fi

dist\:c: runtime
	@if [ "$$(uname)" = "Darwin" ]; then \
		bash $(SCRIPT_DIR)/package/package-macos.sh $(ARGS); \
	elif [ "$$(uname)" = "Linux" ]; then \
		bash $(SCRIPT_DIR)/package/package-linux.sh $(ARGS); \
	else \
		echo "❌ Unsupported platform: $$(uname)"; \
		exit 1; \
	fi

# Build Node.js distribution packages (local use)
dist\:node: runtime
	@cd sdks/node && npm install --silent && npm run build:native -- --release && npm run build && npm run artifacts && npm run bundle:runtime && npm run pack:all


# Build wheel locally with maturin + platform-specific repair tool
dev\:python: runtime-debug
	@echo "📦 Building wheel locally with maturin..."
	@if [ ! -d .venv ]; then \
		echo "📦 Creating virtual environment..."; \
		python3 -m venv .venv; \
	fi

	echo "📦 Installing maturin..."; \
	. .venv/bin/activate && pip install -q maturin; \

	@echo "📦 Copying runtime to Python module..."
	@rm -rf $(CURDIR)/sdks/python/boxlite/runtime
	@cp -a $(CURDIR)/target/boxlite-runtime $(CURDIR)/sdks/python/boxlite/runtime

	@echo "🔨 Building wheel with maturin..."
	@. .venv/bin/activate && cd sdks/python && maturin develop

dev\:c: runtime
	@if [ "$$(uname)" = "Darwin" ]; then \
		bash $(SCRIPT_DIR)/package/package-macos.sh $(ARGS); \
	elif [ "$$(uname)" = "Linux" ]; then \
		bash $(SCRIPT_DIR)/package/package-linux.sh $(ARGS); \
	else \
		echo "❌ Unsupported platform: $$(uname)"; \
		exit 1; \
	fi

# Build Node.js SDK locally with napi-rs (debug mode)
dev\:node: runtime-debug
	@cd sdks/node && npm install --silent && npm run build:native && npm run build
	@ln -sfn ../../../target/boxlite-runtime sdks/node/native/runtime
	@echo "📦 Linking SDK to examples..."
	@cd examples/node && npm install --silent
	@echo "✅ Node.js SDK built and linked to examples"

# Run all unit tests (excludes integration tests that require VMs)
test:
	@$(MAKE) test:rust
	@$(MAKE) test:ffi
	@$(MAKE) test:python
	@$(MAKE) test:node
	@$(MAKE) test:c
	@echo "✅ All tests passed"

# Run Rust unit tests (single-threaded, without gvproxy to avoid Go runtime issues)
test\:rust:
	@echo "🧪 Running Rust unit tests..."
	@cargo test -p boxlite --no-default-features --lib -- --test-threads=1
	@cargo test -p boxlite-shared --lib -- --test-threads=1

# Run BoxLite FFI unit tests
test\:ffi:
	@echo "🧪 Running BoxLite FFI unit tests..."
	@cargo test -p boxlite-ffi


# Run Python SDK unit tests (excludes integration tests)
test\:python:
	@echo "🧪 Running Python SDK unit tests..."
	@cd sdks/python && python -m pytest tests/ -v -m "not integration"

# Run Node.js SDK unit tests
test\:node:
	@echo "🧪 Running Node.js SDK unit tests..."
	@cd sdks/node && npm test

# Run CLI integration tests (requires runtime environment)
test\:cli: runtime-debug
	@echo "🧪 Running CLI integration tests..."
	@cargo test -p boxlite-cli --tests --no-fail-fast -- --test-threads=1

# Run Rust integration tests (requires VM environment)
test\:integration: runtime-debug
	@echo "🧪 Running Rust integration tests (requires VM)..."
	@BOXLITE_RUNTIME_DIR=$(PROJECT_ROOT)/target/boxlite-runtime \
		cargo test -p boxlite --test '*' --no-fail-fast -- --test-threads=1 --nocapture

# Format all Rust code
fmt:
	@echo "🔧 Formatting all Rust code..."
	@cargo fmt --all
	@echo "✅ Formatting complete"

# Check Rust formatting without modifying files
fmt-check:
	@echo "🔍 Checking Rust formatting..."
	@cargo fmt --all -- --check
	@echo "✅ Formatting check passed"
