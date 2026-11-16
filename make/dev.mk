PHONY_TARGETS += _ensure-python-deps _ensure-node-deps _ensure-apps-deps
PHONY_TARGETS += build\:e2e\:drivers
PHONY_TARGETS += build\:e2e\:release-drivers

# Ensure Python venv exists (lightweight, no package install).
_ensure-python-deps:
	@if [ ! -d .venv ]; then \
		echo "📦 Creating virtual environment..."; \
		python3 -m venv .venv || { echo "❌ Failed to create virtual environment"; exit 1; }; \
	fi
	@. .venv/bin/activate && pip install -q uv && (cd sdks/python && uv pip install --group dev --group sync)

# Ensure Node SDK dependencies are installed (lightweight, no build).
_ensure-node-deps:
	@if [ ! -d sdks/node/node_modules ]; then \
		echo "📦 Installing Node SDK dependencies..."; \
		cd sdks/node && npm install --silent; \
	fi

# Ensure the apps/ yarn workspace (NestJS control plane etc.) is installed.
# apps/yarn.lock is gitignored, so a fresh tree has none — and Yarn 4 then
# walks up to the repo-root package.json and refuses ("not part of the
# project"). Seeding an empty apps/yarn.lock makes Yarn treat apps/ as its
# own project (per Yarn's own guidance), then a plain install populates it.
# Plain install (not --immutable) mirrors _ensure-node/python-deps and
# bootstraps the lockfile.
_ensure-apps-deps:
	@if [ ! -d apps/node_modules ] || [ ! -f apps/yarn.lock ]; then \
		echo "📦 Installing apps workspace dependencies (yarn)..."; \
		cd apps && { [ -f yarn.lock ] || : > yarn.lock; } && yarn install; \
	fi

# Build wheel locally with maturin + embedded runtime
dev\:python: $(if $(SETUP_DONE),,runtime\:debug) _ensure-python-deps
	@echo "🔨 Building wheel with maturin (embedded-runtime)..."
	@. .venv/bin/activate && pip install -q maturin && cd sdks/python && maturin develop --uv

dev\:c: $(if $(SETUP_DONE),,runtime\:debug)
	@echo "🔨 Building C SDK (debug)..."
	@cargo build -p boxlite-c
	@echo "✅ C SDK built:"
	@echo "   Library: target/debug/libboxlite.{dylib,so,a}"
	@echo "   Header:  sdks/c/include/boxlite.h"

# Build Node.js SDK locally with napi-rs (debug mode)
dev\:node: $(if $(SETUP_DONE),,runtime\:debug)
	@cd sdks/node && npm install --silent && npm run build:native && npm run build
	@echo "📦 Linking SDK to examples..."
	@cd examples/node && npm install --silent
	@echo "✅ Node.js SDK built and linked to examples"

# Build Go SDK locally (debug mode, static linking)
dev\:go: $(if $(SETUP_DONE),,runtime\:debug)
	@echo "🔨 Building Go SDK (debug)..."
	@cargo build -p boxlite-c
	@bash $(SCRIPT_DIR)/build/fix-go-symbols.sh target/debug/libboxlite.a
	@cd sdks/go && go build -tags boxlite_dev ./...
	@echo "✅ Go SDK built. You can now run: cd sdks/go && go test -tags boxlite_dev -v ./..."

# Native REST acceptance clients. SETUP_DONE=1 with BOXLITE_DEPS_STUB=1
# uses the same cloud-only build mode as e2e-cloud; no local VM is needed.
build\:e2e\:drivers: dev\:go
	@mkdir -p target/e2e
	$(CC) -std=c11 -Wall -Wextra -Werror -Isdks/c/include apps/e2e/sdks/c/e2e_domains.c -Ltarget/debug -lboxlite -Wl,-rpath,$(PROJECT_ROOT)/target/debug -o target/e2e/domain-c
	@cd sdks/go && go build -tags boxlite_dev -o ../../target/e2e/domain-go ../../apps/e2e/sdks/go/e2e_domains.go
	@cargo build --locked -p boxlite-e2e-rust --bin domain-rust

# The workflow checks out the selected release separately. Driver sources stay
# current, while headers, native libraries and SDK implementations come from it.
E2E_RELEASE_ROOT := $(PROJECT_ROOT)/target/e2e-release
E2E_RELEASE_C_SDK := $(PROJECT_ROOT)/target/e2e-c-sdk
build\:e2e\:release-drivers:
	@mkdir -p target/e2e target/debug "$(E2E_RELEASE_ROOT)/sdks/go/include" "$(E2E_RELEASE_ROOT)/apps/e2e/sdks/rust"
	@cp "$(E2E_RELEASE_C_SDK)/lib/libboxlite.a" "$(E2E_RELEASE_ROOT)/sdks/go/"
	@cp "$(E2E_RELEASE_C_SDK)/include/boxlite.h" "$(E2E_RELEASE_ROOT)/sdks/go/include/"
	$(CC) -std=c11 -Wall -Wextra -Werror -I"$(E2E_RELEASE_C_SDK)/include" apps/e2e/sdks/c/e2e_domains.c -L"$(E2E_RELEASE_C_SDK)/lib" -lboxlite -Wl,-rpath,"$(E2E_RELEASE_C_SDK)/lib" -o target/e2e/domain-c
	@cd "$(E2E_RELEASE_ROOT)/sdks/go" && go build -o "$(PROJECT_ROOT)/target/e2e/domain-go" "$(PROJECT_ROOT)/apps/e2e/sdks/go/e2e_domains.go"
	@cp apps/e2e/sdks/rust/Cargo.toml apps/e2e/sdks/rust/e2e_domains.rs "$(E2E_RELEASE_ROOT)/apps/e2e/sdks/rust/"
	@cd "$(E2E_RELEASE_ROOT)" && CARGO_TARGET_DIR="$(PROJECT_ROOT)/target/e2e-release-rust" cargo build --locked -p boxlite-e2e-rust --bin domain-rust
	@cp target/e2e-release-rust/debug/domain-rust target/debug/domain-rust
