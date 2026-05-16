PHONY_TARGETS += test

# Mirrors GitHub Actions strategy.fail-fast. Default false: aggregator
# targets run every sub-suite even if an earlier one fails, then exit
# non-zero with a summary of which suites failed. Set FAIL_FAST=true to
# abort at the first failing suite (original behavior).
FAIL_FAST ?= false
export FAIL_FAST

# Scope a run by test name: make <target> FILTER=<pattern>. Empty = full
# suite. Works for every test target. FILTER is mapped to each runner's
# native name selector, so match semantics are per-runner (nextest/ctest/
# go: regex, pytest -k / vitest -t: expression/substring).
export FILTER

NEXTEST_FILTER   = $(if $(FILTER),-E 'test(~$(FILTER))',)
CARGOTEST_FILTER = $(if $(FILTER),$(FILTER),)
PYTEST_FILTER    = $(if $(FILTER),-k '$(FILTER)',)
VITEST_FILTER    = $(if $(FILTER),-t '$(FILTER)',)
CTEST_FILTER     = $(if $(FILTER),-R '$(FILTER)',)
GOTEST_FILTER    = $(if $(FILTER),-run '$(FILTER)',)

# $(call run_suites,<space-separated make targets>)
# Runs each target via a recursive $(MAKE). With FAIL_FAST=false the loop
# continues past failures and exits non-zero at the end listing the
# failed targets; with FAIL_FAST=true it breaks on the first failure.
define run_suites
	@rc=0; failed=""; \
	for t in $(1); do \
		echo ""; \
		if ! $(MAKE) $$t; then \
			rc=1; failed="$$failed $$t"; \
			if [ "$(FAIL_FAST)" = "true" ]; then break; fi; \
		fi; \
	done; \
	echo ""; \
	if [ $$rc -ne 0 ]; then \
		echo "❌ Failed suites:$$failed"; \
		exit 1; \
	fi
endef

# Heavy shared setup (runtime build + Rust image cache) is built ONCE by the
# integration aggregators before they fan out; SETUP_DONE=1 tells the per-suite
# recursive sub-makes (and the dev:* prereqs) to skip rebuilding it. Running a
# leaf directly (SETUP_DONE unset) still builds its own prerequisites.
export SETUP_DONE

# $(call run_integration_suites,<space-separated make targets>)
# Like run_suites, but builds the shared runtime once up front (unless a parent
# already did, signalled by SETUP_DONE) and runs every suite with SETUP_DONE=1
# so no sub-make re-derives the phony runtime:debug / warm-cache prereqs.
define run_integration_suites
	@if [ -z "$(SETUP_DONE)" ]; then \
		echo "🔧 Preparing shared test runtime (once)..."; \
		$(MAKE) runtime:debug || exit 1; \
		if echo "$(1)" | grep -qE 'test:integration:(rust|core)'; then \
			$(MAKE) test:warm-cache:rust SETUP_DONE=1 || exit 1; \
		fi; \
	fi
	@rc=0; failed=""; \
	for t in $(1); do \
		echo ""; \
		if ! $(MAKE) $$t SETUP_DONE=1; then \
			rc=1; failed="$$failed $$t"; \
			if [ "$(FAIL_FAST)" = "true" ]; then break; fi; \
		fi; \
	done; \
	echo ""; \
	if [ $$rc -ne 0 ]; then \
		echo "❌ Failed suites:$$failed"; \
		exit 1; \
	fi
endef

# Default test target runs only changed components.
test:
	@$(MAKE) test:changed

# Smart test: only test components with changes, fall back to full matrix.
test\:changed:
ifeq ($(CHANGED_COMPONENTS),)
	@echo "📋 No changed components detected — skipping tests."
	@echo "   (Use 'make test:all' to run the full test matrix)"
else
	@echo "📋 Changed components: $(CHANGED_COMPONENTS)"
	$(call run_suites,$(addprefix test:changed:,$(sort $(CHANGED_COMPONENTS))))
	@echo ""
	@echo "✅ All changed-component tests passed"
endif

# Per-component test dispatch targets (map component tag → existing test targets).
test\:changed\:rust:
	@$(MAKE) test:unit:rust
	@$(MAKE) test:integration:rust

test\:changed\:cli:
	@$(MAKE) test:integration:cli

test\:changed\:ffi:
	@$(MAKE) test:unit:ffi

test\:changed\:python:
	@$(MAKE) test:all:python

test\:changed\:node:
	@$(MAKE) test:all:node

test\:changed\:c:
	@$(MAKE) test:unit:c
	@$(MAKE) test:integration:c

test\:changed\:go:
	@$(MAKE) test:unit:go

# Integration-only for changed components (used by E2E CI on PRs).
test\:integration\:changed:
ifeq ($(CHANGED_COMPONENTS),)
	@echo "📋 No changed components detected — skipping integration tests."
else
	@echo "📋 Running integration tests for changed components: $(CHANGED_COMPONENTS)"
	$(call run_integration_suites,$(strip \
		$(if $(filter rust,$(CHANGED_COMPONENTS)),test:integration:rust) \
		$(if $(filter cli,$(CHANGED_COMPONENTS)),test:integration:cli) \
		$(if $(filter python,$(CHANGED_COMPONENTS)),test:integration:python) \
		$(if $(filter node,$(CHANGED_COMPONENTS)),test:integration:node) \
		$(if $(filter c,$(CHANGED_COMPONENTS)),test:integration:c)))
	@echo ""
	@echo "✅ Changed-component integration tests passed"
endif

# Full matrix: all unit suites + all integration suites.
test\:all:
	@echo "📋 Running full test matrix (unit → integration)"
	$(call run_suites,test:unit test:integration)
	@echo ""
	@echo "✅ All tests passed (full matrix)"

# Unit matrix.
test\:unit:
	@echo "── Unit tests (core, sdk) ──"
	$(call run_suites,test:unit:core test:unit:sdk)
	@echo ""
	@echo "✅ Unit test matrix passed"

# Integration matrix.
test\:integration:
	@echo "── Integration tests (core, sdk) ──"
	$(call run_integration_suites,test:integration:core test:integration:sdk)
	@echo ""
	@echo "✅ Integration test matrix passed"

# Core unit suites: Rust unit + FFI unit.
test\:unit\:core:
	@echo "── Core unit suites (rust, ffi) ──"
	$(call run_suites,test:unit:rust test:unit:ffi)

# Core integration suites: Rust integration + CLI integration.
test\:integration\:core:
	@echo "── Core integration suites (rust, cli) ──"
	$(call run_integration_suites,test:integration:rust test:integration:cli)

# SDK unit suites: Python unit + Node unit + C unit + Go unit.
test\:unit\:sdk:
	@echo "── SDK unit suites (python, node, c, go) ──"
	$(call run_suites,test:unit:python test:unit:node test:unit:c test:unit:go)

# SDK integration suites: Python integration + Node integration + C SDK test suite.
test\:integration\:sdk:
	@echo "── SDK integration suites (python, node, c) ──"
	$(call run_integration_suites,test:integration:python test:integration:node test:integration:c)

# Rust unit tests (parallel via nextest, fallback to serial cargo test).
# --no-default-features disables gvproxy to avoid Go runtime link issues.
test\:unit\:rust:
	@echo "🧪 Running Rust unit tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite --no-default-features --lib $(NEXTEST_FILTER); \
		cargo nextest run -p boxlite-shared --lib $(NEXTEST_FILTER); \
	else \
		cargo test -p boxlite --no-default-features --lib -- --test-threads=1 $(CARGOTEST_FILTER); \
		cargo test -p boxlite-shared --lib -- --test-threads=1 $(CARGOTEST_FILTER); \
	fi

# Pre-warm Rust integration test image cache (internal helper, still callable).
test\:warm-cache\:rust: $(if $(SETUP_DONE),,runtime\:debug)
	@echo "🔥 Warming Rust integration test image cache..."
	@mkdir -p /tmp/boxlite-test
	@./target/debug/boxlite --home /tmp/boxlite-test \
		--registry docker.m.daocloud.io \
		--registry docker.xuanyuan.me \
		--registry docker.1ms.run \
		--registry docker.io \
		pull alpine:latest 2>/dev/null || \
		echo "  ⚠️ Pre-warm skipped (pull failed, tests will pull on-demand)"
	@echo "✅ Rust integration image cache ready"

# Rust integration tests (requires VM environment).
# FILTER works here and on every test target, e.g. make test:integration:rust FILTER=copy
test\:integration\:rust: $(if $(SETUP_DONE),,runtime\:debug test\:warm-cache\:rust)
	@echo "🧪 Running Rust integration tests (requires VM)..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite --features krun,gvproxy --test '*' --no-fail-fast --profile vm \
			$(NEXTEST_FILTER); \
	else \
		cargo test -p boxlite --features krun,gvproxy --test '*' --no-fail-fast -- --test-threads=1 --nocapture \
			$(CARGOTEST_FILTER); \
	fi

# BoxLite C SDK unit tests.
test\:unit\:ffi:
	@echo "🧪 Running BoxLite C SDK unit tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite-c $(NEXTEST_FILTER); \
	else \
		cargo test -p boxlite-c $(CARGOTEST_FILTER); \
	fi

# CLI integration tests.
test\:integration\:cli: $(if $(SETUP_DONE),,runtime\:debug)
	@echo "🧪 Running CLI integration tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite-cli --tests --profile vm --no-fail-fast \
		$(NEXTEST_FILTER); \
	else \
		cargo test -p boxlite-cli --tests --no-fail-fast -- --test-threads=4 \
		$(CARGOTEST_FILTER); \
	fi

# Python SDK unit tests.
test\:unit\:python: _ensure-python-deps
	@echo "🧪 Running Python SDK unit tests..."
	@. .venv/bin/activate && cd sdks/python && python -m pytest tests/ -v -m "not integration" $(PYTEST_FILTER)

# Python SDK integration tests.
test\:integration\:python:
	@$(MAKE) dev:python
	@echo "🧪 Running Python SDK integration tests..."
	@BOXLITE_HOME=$$(mktemp -d /tmp/boxlite-test-python-XXXXXX) && \
	 trap "rm -rf $$BOXLITE_HOME" EXIT && \
	 . .venv/bin/activate && cd sdks/python && BOXLITE_HOME=$$BOXLITE_HOME python -m pytest tests/ -v -m "integration" $(PYTEST_FILTER)

# Python SDK full suite.
test\:all\:python:
	$(call run_suites,test:unit:python test:integration:python)

# Node.js SDK unit tests.
test\:unit\:node: _ensure-node-deps
	@echo "🧪 Running Node.js SDK unit tests..."
	@cd sdks/node && npm test -- $(VITEST_FILTER)

# Node.js SDK integration tests (requires VM environment).
test\:integration\:node:
	@$(MAKE) dev:node
	@echo "🧪 Running Node.js SDK integration tests (requires VM)..."
	@cd sdks/node && npm run test:integration -- $(VITEST_FILTER)

# Node.js SDK full suite.
test\:all\:node:
	$(call run_suites,test:unit:node test:integration:node)

# C SDK unit tests (no VM required).
test\:unit\:c:
	@echo "🧪 Running C SDK unit tests..."
	@$(MAKE) dev:c
	@mkdir -p sdks/c/tests/build
	@cd sdks/c/tests/build && cmake ..
	@cd sdks/c/tests/build && cmake --build . -j
	@cd sdks/c/tests/build && ctest --verbose --output-on-failure -L unit $(CTEST_FILTER)

# C SDK integration tests (requires VM environment).
test\:integration\:c:
	@echo "🧪 Running C SDK integration tests (requires VM)..."
	@$(MAKE) dev:c
	@mkdir -p sdks/c/tests/build
	@cd sdks/c/tests/build && cmake ..
	@cd sdks/c/tests/build && cmake --build . -j
	@cd sdks/c/tests/build && ctest --verbose --output-on-failure -L integration $(CTEST_FILTER)

# C SDK full suite.
test\:all\:c:
	$(call run_suites,test:unit:c test:integration:c)

# Go SDK unit tests.
test\:unit\:go:
	@echo "🧪 Running Go SDK unit tests..."
	@$(MAKE) dev:go
	@cd sdks/go && go test -tags boxlite_dev -v $(GOTEST_FILTER) ./...

# Go SDK full suite.
test\:all\:go:
	@$(MAKE) test:unit:go

# Installer-script smoke test: structural assertions on the rendered
# install.sh (atomic replace, integrity envelope, pinned-install trust
# tiers). Runs in a couple of seconds, no toolchain required beyond sh.
test\:install-script:
	@echo "🧪 Running installer script smoke test..."
	@bash scripts/release/test_install.sh
