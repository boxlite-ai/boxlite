PHONY_TARGETS += fmt lint clippy lint\:apps fmt\:apps fmt\:check\:apps

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
	@$(MAKE) fmt:apps
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
	@$(MAKE) fmt:check:apps
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

# Format the apps/ workspace via the repo's own blessed script
# (nx run-many format + root-level prettier over TS/JSON/YAML).
fmt\:apps: _ensure-apps-deps
	@echo "🔧 Formatting apps workspace..."
	@cd apps && yarn format

# apps/ has no `format:check` script; prettier --check over the same TS globs
# `lint:ts` uses is the check counterpart.
fmt\:check\:apps: _ensure-apps-deps
	@echo "🔍 Checking apps workspace formatting..."
	@cd apps && yarn prettier --check "{apps,libs,test}/**/*.{ts,tsx}"

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
	@$(MAKE) lint:apps
	@echo "✅ Lint checks passed"

# Safe autofix path: format first, fix Python lint, then verify all lint checks.
lint\:fix:
	@$(MAKE) fmt
	@if echo "$(FMT_COMPONENTS)" | grep -q 'python'; then \
		echo "🔧 Autofixing Python SDK lint issues..."; \
		. .venv/bin/activate && cd sdks/python && ruff check --fix .; \
	fi
	@$(MAKE) lint

# Lint the apps/ workspace TypeScript via the repo's own blessed script
# (eslint "{apps,libs,test}/**/*.{ts,tsx}").
lint\:apps: _ensure-apps-deps
	@echo "🔍 Linting apps workspace (TypeScript)..."
	@cd apps && yarn lint:ts
	@echo "✅ apps workspace lint passed"

lint\:rust:
	@$(MAKE) clippy

lint\:python: _ensure-python-deps
	@echo "🔍 Linting Python SDK..."
	@. .venv/bin/activate && cd sdks/python && ruff check .
	@echo "🔍 Checking Python SDK dependency policy..."
	@. .venv/bin/activate && cd sdks/python && python -c "import sys; tomllib = __import__('tomllib') if sys.version_info >= (3, 11) else __import__('tomli'); config=tomllib.load(open('pyproject.toml','rb')); deps=config.get('project',{}).get('dependencies',[]); (print(f'ERROR: pyproject.toml has required dependencies: {deps}') or print('Move dependencies to [project.optional-dependencies] instead.') or sys.exit(1)) if deps else print('✓ No required dependencies')"

lint\:node: _ensure-node-deps
	@echo "🔍 Checking Node SDK native import boundary..."
	@if rg -n "from ['\"]\\.\\./native/|import\\(['\"]\\.\\./native/" \
		sdks/node/lib --glob '*.ts' --glob '!native.ts'; then \
		echo ""; \
		echo "❌ Checked-in Node TypeScript must not import ../native/ outside lib/native.ts."; \
		exit 1; \
	fi
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
		"$$CLANG_TIDY" --warnings-as-errors='*' "$$file" -- -std=c11 -D_XOPEN_SOURCE=500 -Isdks/c/include || exit 1; \
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

# Linting the guest from macOS means cross-compiling to musl, and clippy still
# runs build scripts — so any C-backed dependency needs a musl cross-compiler.
# `boxlite-guest` has one since russh (its only crypto backends, `ring` and
# `aws-lc-rs`, are both C). `make setup` installs musl-cross, so developer
# machines run this check; the lint workflow's macOS clippy job installs only
# the Rust target, because building musl-cross-make from source takes ~15
# minutes (see the note in .github/workflows/build-runtime.yml).
#
# What still covers the guest when this is skipped, stated precisely:
#   - Lints: fully covered pre-merge. Linux CI runs the unexcluded
#     `--workspace` branch below, and nothing under src/guest/ is gated on
#     target_env/target_arch — only target_os = "linux" — so linux-gnu lints
#     the same cfg set as linux-musl.
#   - musl *compilation*: only partly covered pre-merge. test.yml's Go job
#     builds the guest for musl, but is gated on `sdks/go/**` changes;
#     build-runtime.yml also builds it but runs post-merge (workflow_run on
#     main / release), not on pull_request. So a guest-only PR can reach merge
#     without a musl build signal. That gap predates this skip, but do not
#     widen it: if a guest C dependency changes, build the guest locally
#     (`make guest`) or run the Go job.
clippy: _ensure-python-deps
	@echo "🔍 Running Rust clippy checks..."
	@if [ "$$(uname)" = "Darwin" ]; then \
		BOXLITE_DEPS_STUB=1 cargo clippy --workspace --all-targets --all-features --exclude boxlite-guest -- -D warnings || exit 1; \
		guest_target="$$(bash scripts/util.sh --target)"; \
		guest_cc="$$(echo "$$guest_target" | cut -d'-' -f1)-linux-musl-gcc"; \
		if command -v "$$guest_cc" >/dev/null 2>&1; then \
			BOXLITE_DEPS_STUB=1 cargo clippy -p boxlite-guest --target "$$guest_target" --all-targets --all-features -- -D warnings || exit 1; \
		else \
			echo "⏭️  Skipping boxlite-guest clippy: $$guest_cc not found (run 'make setup' to install musl-cross). Linux CI lints the guest natively."; \
		fi; \
	else \
		BOXLITE_DEPS_STUB=1 cargo clippy --workspace --all-targets --all-features -- -D warnings; \
	fi
