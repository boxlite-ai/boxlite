PHONY_TARGETS += fmt lint clippy

# Smart format: only format changed components.
fmt:
ifeq ($(FMT_COMPONENTS),)
	@echo "📋 No changed components — skipping formatting."
	@echo "   (Use 'make fmt:all' to format everything)"
else
	@echo "📋 Formatting changed components: $(FMT_COMPONENTS)"
	@$(foreach comp,$(FMT_COMPONENTS),$(MAKE) fmt:$(comp) &&) true
	@echo "✅ Formatting complete"
endif

# Format all supported language surfaces unconditionally.
fmt\:all:
	@$(MAKE) fmt:rust
	@$(MAKE) fmt:python
	@$(MAKE) fmt:node
	@$(MAKE) fmt:c
	@$(MAKE) fmt:go
	@echo "✅ Formatting complete"

# Smart format check: only check changed components.
fmt\:check:
ifeq ($(FMT_COMPONENTS),)
	@echo "📋 No changed components — skipping format checks."
	@echo "   (Use 'make fmt:check:all' to check everything)"
else
	@echo "📋 Checking formatting for changed components: $(FMT_COMPONENTS)"
	@$(foreach comp,$(FMT_COMPONENTS),$(MAKE) fmt:check:$(comp) &&) true
	@echo "✅ Formatting checks passed"
endif

# Check formatting for all supported language surfaces unconditionally.
fmt\:check\:all:
	@$(MAKE) fmt:check:rust
	@$(MAKE) fmt:check:python
	@$(MAKE) fmt:check:node
	@$(MAKE) fmt:check:c
	@$(MAKE) fmt:check:go
	@echo "✅ Formatting checks passed"

fmt\:rust:
	@echo "🔧 Formatting Rust code..."
	@cargo fmt --all

fmt\:check\:rust:
	@echo "🔍 Checking Rust formatting..."
	@cargo fmt --all -- --check

fmt\:python: _ensure-python-deps
	@echo "🔧 Formatting Python SDK..."
	@. .venv/bin/activate && cd sdks/python && ruff format .

fmt\:check\:python: _ensure-python-deps
	@echo "🔍 Checking Python SDK formatting..."
	@. .venv/bin/activate && cd sdks/python && ruff format --check .

fmt\:node: _ensure-node-deps
	@echo "🔧 Formatting Node SDK..."
	@cd sdks/node && npm run format

fmt\:check\:node: _ensure-node-deps
	@echo "🔍 Checking Node SDK formatting..."
	@cd sdks/node && npm run format:check

fmt\:c:
	@echo "🔧 Formatting C SDK..."
	@CLANG_FORMAT="$$(command -v clang-format || true)"; \
	if [ -z "$$CLANG_FORMAT" ] && [ -x "/opt/homebrew/opt/llvm/bin/clang-format" ]; then \
		CLANG_FORMAT="/opt/homebrew/opt/llvm/bin/clang-format"; \
	fi; \
	if [ -z "$$CLANG_FORMAT" ]; then \
		echo "❌ clang-format not found. Install LLVM/clang-format to format C SDK files."; \
		exit 1; \
	fi; \
	"$$CLANG_FORMAT" -i sdks/c/tests/*.c

fmt\:check\:c:
	@echo "🔍 Checking C SDK formatting..."
	@CLANG_FORMAT="$$(command -v clang-format || true)"; \
	if [ -z "$$CLANG_FORMAT" ] && [ -x "/opt/homebrew/opt/llvm/bin/clang-format" ]; then \
		CLANG_FORMAT="/opt/homebrew/opt/llvm/bin/clang-format"; \
	fi; \
	if [ -z "$$CLANG_FORMAT" ]; then \
		echo "❌ clang-format not found. Install LLVM/clang-format to check C SDK formatting."; \
		exit 1; \
	fi; \
	"$$CLANG_FORMAT" --dry-run --Werror sdks/c/tests/*.c

# Smart lint: only lint changed components.
lint:
ifeq ($(FMT_COMPONENTS),)
	@echo "📋 No changed components — skipping lint checks."
	@echo "   (Use 'make lint:all' to lint everything)"
else
	@echo "📋 Linting changed components: $(FMT_COMPONENTS)"
	@$(foreach comp,$(FMT_COMPONENTS),$(MAKE) lint:$(comp) &&) true
	@echo "✅ Lint checks passed"
endif

# Lint all supported language surfaces unconditionally.
lint\:all:
	@$(MAKE) lint:rust
	@$(MAKE) lint:python
	@$(MAKE) lint:node
	@$(MAKE) lint:c
	@$(MAKE) lint:go
	@echo "✅ Lint checks passed"

# Safe autofix path: format first, fix Python lint, then verify all lint checks.
lint\:fix:
	@$(MAKE) fmt
	@if echo "$(FMT_COMPONENTS)" | grep -q 'python'; then \
		echo "🔧 Autofixing Python SDK lint issues..."; \
		. .venv/bin/activate && cd sdks/python && ruff check --fix .; \
	fi
	@$(MAKE) lint

lint\:rust:
	@$(MAKE) clippy

lint\:python: _ensure-python-deps
	@echo "🔍 Linting Python SDK..."
	@. .venv/bin/activate && cd sdks/python && ruff check .
	@echo "🔍 Checking Python SDK dependency policy..."
	@. .venv/bin/activate && cd sdks/python && python -c "import tomllib; config=tomllib.load(open('pyproject.toml','rb')); deps=config.get('project',{}).get('dependencies',[]); import sys; (print(f'ERROR: pyproject.toml has required dependencies: {deps}') or print('Move dependencies to [project.optional-dependencies] instead.') or sys.exit(1)) if deps else print('✓ No required dependencies')"

lint\:node: _ensure-node-deps
	@echo "🔍 Linting Node SDK (TypeScript type check)..."
	@cd sdks/node && npx tsc --noEmit

lint\:c:
	@echo "🔍 Linting C SDK..."
	@# Banned unsafe C functions — platform-independent check.
	@# macOS clang-tidy skips DeprecatedOrUnsafeBufferHandling (no Annex K),
	@# so this grep catches memcpy/sprintf/strcpy etc. on all platforms.
	@if grep -rn 'memcpy\|memmove\|sprintf\b\|strcat\|strcpy\|gets\b\|strtok' \
		--include='*.c' sdks/c/tests/ sdks/c/src/ 2>/dev/null | \
		grep -v '// NOLINT' ; then \
		echo ""; \
		echo "❌ Banned unsafe C functions found above."; \
		echo "   Use bounded alternatives (char loops, strlcpy, snprintf)."; \
		echo "   Add '// NOLINT' comment to suppress if intentional."; \
		exit 1; \
	fi
	@CLANG_TIDY="$$(command -v clang-tidy || true)"; \
	if [ -z "$$CLANG_TIDY" ] && [ -x "/opt/homebrew/opt/llvm/bin/clang-tidy" ]; then \
		CLANG_TIDY="/opt/homebrew/opt/llvm/bin/clang-tidy"; \
	fi; \
	if [ -z "$$CLANG_TIDY" ]; then \
		echo "❌ clang-tidy not found. Install LLVM/clang-tidy to lint C SDK files."; \
		exit 1; \
	fi; \
	for file in sdks/c/tests/*.c; do \
		"$$CLANG_TIDY" --warnings-as-errors='*' "$$file" -- -std=c11 -Isdks/c/include || exit 1; \
	done

fmt\:go:
	@echo "🔧 Formatting Go SDK..."
	@cd sdks/go && go fmt ./...

fmt\:check\:go:
	@echo "🔍 Checking Go SDK formatting..."
	@cd sdks/go && test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

lint\:go:
	@echo "🔍 Linting Go SDK (vet)..."
	@cd sdks/go && go vet -tags boxlite_dev ./...

clippy: _ensure-python-deps
	@echo "🔍 Running Rust clippy checks..."
	@if [ "$$(uname)" = "Darwin" ]; then \
		BOXLITE_DEPS_STUB=1 cargo clippy --workspace --all-targets --all-features --exclude boxlite-guest -- -D warnings && \
		BOXLITE_DEPS_STUB=1 cargo clippy -p boxlite-guest --target "$$(bash scripts/util.sh --target)" --all-targets --all-features -- -D warnings; \
	else \
		BOXLITE_DEPS_STUB=1 cargo clippy --workspace --all-targets --all-features -- -D warnings; \
	fi
