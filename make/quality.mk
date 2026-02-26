PHONY_TARGETS += fmt fmt\:all fmt\:check fmt\:check\:all
PHONY_TARGETS += fmt\:rust fmt\:python fmt\:node fmt\:c
PHONY_TARGETS += fmt\:check\:rust fmt\:check\:python fmt\:check\:node fmt\:check\:c
PHONY_TARGETS += lint lint\:all lint\:fix lint\:rust lint\:python lint\:node lint\:c clippy

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
	@echo "✅ Formatting checks passed"

fmt\:rust:
	@echo "🔧 Formatting Rust code..."
	@cargo fmt --all

fmt\:check\:rust:
	@echo "🔍 Checking Rust formatting..."
	@cargo fmt --all -- --check

fmt\:python:
	@echo "🔧 Formatting Python SDK..."
	@cd sdks/python && python3 -m ruff format .

fmt\:check\:python:
	@echo "🔍 Checking Python SDK formatting..."
	@cd sdks/python && python3 -m ruff format --check .

fmt\:node:
	@echo "🔧 Formatting Node SDK..."
	@if [ ! -x sdks/node/node_modules/.bin/prettier ]; then \
		echo "❌ prettier not found. Run 'npm install' in sdks/node/ or run 'make setup'."; \
		exit 1; \
	fi
	@cd sdks/node && npm run format

fmt\:check\:node:
	@echo "🔍 Checking Node SDK formatting..."
	@if [ ! -x sdks/node/node_modules/.bin/prettier ]; then \
		echo "❌ prettier not found. Run 'npm install' in sdks/node/ or run 'make setup'."; \
		exit 1; \
	fi
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
	"$$CLANG_FORMAT" -i sdks/c/include/boxlite.h sdks/c/tests/*.c

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
	"$$CLANG_FORMAT" --dry-run --Werror sdks/c/include/boxlite.h sdks/c/tests/*.c

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
	@echo "✅ Lint checks passed"

# Safe autofix path: format first, fix Python lint, then verify all lint checks.
lint\:fix:
	@$(MAKE) fmt
	@if echo "$(FMT_COMPONENTS)" | grep -q 'python'; then \
		echo "🔧 Autofixing Python SDK lint issues..."; \
		cd sdks/python && python3 -m ruff check --fix .; \
	fi
	@$(MAKE) lint

lint\:rust:
	@$(MAKE) clippy

lint\:python:
	@echo "🔍 Linting Python SDK..."
	@cd sdks/python && python3 -m ruff check .
	@echo "🔍 Checking Python SDK dependency policy..."
	@cd sdks/python && python -c "import tomllib; config=tomllib.load(open('pyproject.toml','rb')); deps=config.get('project',{}).get('dependencies',[]); import sys; (print(f'ERROR: pyproject.toml has required dependencies: {deps}') or print('Move dependencies to [project.optional-dependencies] instead.') or sys.exit(1)) if deps else print('✓ No required dependencies')"

lint\:node:
	@echo "🔍 Linting Node SDK (TypeScript type check)..."
	@if [ ! -d sdks/node/node_modules ]; then \
		echo "❌ Node SDK dependencies not installed. Run 'npm install' in sdks/node/ or run 'make setup'."; \
		exit 1; \
	fi
	@cd sdks/node && npx tsc --noEmit

lint\:c:
	@echo "🔍 Linting C SDK..."
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

clippy:
	@echo "🔍 Running Rust clippy checks..."
	@if [ "$$(uname)" = "Darwin" ]; then \
		BOXLITE_DEPS_STUB=1 cargo clippy --workspace --all-targets --all-features --exclude boxlite-guest -- -D warnings; \
		BOXLITE_DEPS_STUB=1 cargo clippy -p boxlite-guest --target "$$(bash scripts/util.sh --target)" --all-targets --all-features -- -D warnings; \
	else \
		BOXLITE_DEPS_STUB=1 cargo clippy --workspace --all-targets --all-features -- -D warnings; \
	fi
