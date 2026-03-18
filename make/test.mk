PHONY_TARGETS += test

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
	@echo ""
	@$(foreach comp,$(sort $(CHANGED_COMPONENTS)), \
		$(MAKE) test:changed:$(comp) && \
	) true
	@echo ""
	@echo "✅ All changed-component tests passed"
endif

# Per-component test dispatch targets (map component tag → existing test targets).
test\:changed\:rust:
	@$(MAKE) test:unit:rust
	@$(MAKE) test:integration:rust

test\:changed\:server:
	@$(MAKE) test:unit:server

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

# Full matrix: all unit suites + all integration suites.
test\:all:
	@echo "📋 Running full test matrix (unit → integration)"
	@echo ""
	$(MAKE) test:unit
	@echo ""
	$(MAKE) test:integration
	@echo ""
	@echo "✅ All tests passed (full matrix)"

# Unit matrix.
test\:unit:
	@echo "── Unit tests (core, sdk) ──"
	@echo ""
	$(MAKE) test:unit:core
	@echo ""
	$(MAKE) test:unit:sdk
	@echo ""
	@echo "✅ Unit test matrix passed"

# Integration matrix.
test\:integration:
	@echo "── Integration tests (core, sdk) ──"
	@echo ""
	$(MAKE) test:integration:core
	@echo ""
	$(MAKE) test:integration:sdk
	@echo ""
	@echo "✅ Integration test matrix passed"

# Core unit suites: Rust unit + FFI unit.
test\:unit\:core:
	@echo "── Core unit suites (rust, ffi) ──"
	@echo ""
	$(MAKE) test:unit:rust
	@echo ""
	$(MAKE) test:unit:ffi

# Core integration suites: Rust integration + CLI integration.
test\:integration\:core:
	@echo "── Core integration suites (rust, cli) ──"
	@echo ""
	$(MAKE) test:integration:rust
	@echo ""
	$(MAKE) test:integration:cli

# SDK unit suites: Python unit + Node unit + C unit + Go unit.
test\:unit\:sdk:
	@echo "── SDK unit suites (python, node, c, go) ──"
	@echo ""
	$(MAKE) test:unit:python
	@echo ""
	$(MAKE) test:unit:node
	@echo ""
	$(MAKE) test:unit:c
	@echo ""
	$(MAKE) test:unit:go

# SDK integration suites: Python integration + Node integration + C SDK test suite.
test\:integration\:sdk:
	@echo "── SDK integration suites (python, node, c) ──"
	@echo ""
	$(MAKE) test:integration:python
	@echo ""
	$(MAKE) test:integration:node
	@echo ""
	$(MAKE) test:integration:c

# Rust unit tests (parallel via nextest, fallback to serial cargo test).
# --no-default-features disables gvproxy to avoid Go runtime link issues.
test\:unit\:rust:
	@echo "🧪 Running Rust unit tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite --no-default-features --lib; \
		cargo nextest run -p boxlite-shared --lib; \
		cargo nextest run -p boxlite-server --lib; \
	else \
		cargo test -p boxlite --no-default-features --lib -- --test-threads=1; \
		cargo test -p boxlite-shared --lib -- --test-threads=1; \
		cargo test -p boxlite-server --lib -- --test-threads=1; \
	fi

# BoxLite server unit tests.
test\:unit\:server:
	@echo "🧪 Running boxlite-server unit tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite-server; \
	else \
		cargo test -p boxlite-server; \
	fi

# Pre-warm Rust integration test image cache (internal helper, still callable).
test\:warm-cache\:rust: runtime\:debug
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
# Pass FILTER=<pattern> to run a subset, e.g. make test:integration:rust FILTER=copy
test\:integration\:rust: runtime\:debug test\:warm-cache\:rust
	@echo "🧪 Running Rust integration tests (requires VM)..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite --features krun,gvproxy --test '*' --no-fail-fast --profile vm \
			$(if $(FILTER),-E 'test(~$(FILTER))',); \
	else \
		cargo test -p boxlite --features krun,gvproxy --test '*' --no-fail-fast -- --test-threads=1 --nocapture \
			$(if $(FILTER),$(FILTER),); \
	fi

# BoxLite FFI unit tests.
test\:unit\:ffi:
	@echo "🧪 Running BoxLite FFI unit tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite-ffi; \
	else \
		cargo test -p boxlite-ffi; \
	fi

# CLI integration tests.
# Pass FILTER=<pattern> to run a subset.
test\:integration\:cli: runtime\:debug
	@echo "🧪 Running CLI integration tests..."
	@if command -v cargo-nextest >/dev/null 2>&1; then \
		cargo nextest run -p boxlite-cli --tests --no-fail-fast \
		$(if $(FILTER),-E 'test($(FILTER))',); \
	else \
		cargo test -p boxlite-cli --tests --no-fail-fast -- \
		$(if $(FILTER),$(FILTER),); \
	fi

# Python SDK unit tests.
test\:unit\:python: _ensure-python-deps
	@echo "🧪 Running Python SDK unit tests..."
	@. .venv/bin/activate && cd sdks/python && python -m pytest tests/ -v -m "not integration"

# Python SDK integration tests.
test\:integration\:python:
	@$(MAKE) dev:python
	@echo "🧪 Running Python SDK integration tests..."
	@BOXLITE_HOME=$$(mktemp -d /tmp/boxlite-test-python-XXXXXX) && \
	 trap "rm -rf $$BOXLITE_HOME" EXIT && \
	 . .venv/bin/activate && cd sdks/python && BOXLITE_HOME=$$BOXLITE_HOME python -m pytest tests/ -v -m "integration"

# Python SDK full suite.
test\:all\:python:
	@$(MAKE) test:unit:python
	@$(MAKE) test:integration:python

# Node.js SDK unit tests.
test\:unit\:node: _ensure-node-deps
	@echo "🧪 Running Node.js SDK unit tests..."
	@cd sdks/node && npm test

# Node.js SDK integration tests (requires VM environment).
test\:integration\:node:
	@$(MAKE) dev:node
	@echo "🧪 Running Node.js SDK integration tests (requires VM)..."
	@cd sdks/node && npm run test:integration

# Node.js SDK full suite.
test\:all\:node:
	@$(MAKE) test:unit:node
	@$(MAKE) test:integration:node

# C SDK unit tests (no VM required).
test\:unit\:c:
	@echo "🧪 Running C SDK unit tests..."
	@$(MAKE) dev:c
	@mkdir -p sdks/c/tests/build
	@cd sdks/c/tests/build && cmake ..
	@cd sdks/c/tests/build && cmake --build . -j
	@cd sdks/c/tests/build && ctest --verbose --output-on-failure -L unit

# C SDK integration tests (requires VM environment).
test\:integration\:c:
	@echo "🧪 Running C SDK integration tests (requires VM)..."
	@$(MAKE) dev:c
	@mkdir -p sdks/c/tests/build
	@cd sdks/c/tests/build && cmake ..
	@cd sdks/c/tests/build && cmake --build . -j
	@cd sdks/c/tests/build && ctest --verbose --output-on-failure -L integration

# C SDK full suite.
test\:all\:c:
	@$(MAKE) test:unit:c
	@$(MAKE) test:integration:c

# Go SDK unit tests.
test\:unit\:go:
	@echo "🧪 Running Go SDK unit tests..."
	@$(MAKE) dev:go
	@cd sdks/go && go test -tags boxlite_dev -v ./...

# Go SDK full suite.
test\:all\:go:
	@$(MAKE) test:unit:go
