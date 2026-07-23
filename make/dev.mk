PHONY_TARGETS += _ensure-python-deps _ensure-node-deps _ensure-apps-deps

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
dev\:python dev\:c dev\:node dev\:go: BUILD_PROFILE := debug
dev\:python: $(if $(SETUP_DONE),,runtime) _ensure-python-deps
	@echo "🔨 Building wheel with maturin (embedded-runtime)..."
	@. .venv/bin/activate && pip install -q maturin && cd sdks/python && maturin develop --uv

dev\:c: $(if $(SETUP_DONE),,runtime)
	@echo "🔨 Building C SDK (debug)..."
	@cargo build -p boxlite-c
	@bash $(SCRIPT_DIR)/build/fix-go-symbols.sh target/debug/libboxlite.a
	@echo "✅ C SDK built:"
	@echo "   Library: target/debug/libboxlite.{dylib,so,a}"
	@echo "   Header:  sdks/c/include/boxlite.h"

# Build Node.js SDK locally with napi-rs (debug mode)
dev\:node: $(if $(SETUP_DONE),,runtime)
	@cd sdks/node && npm install --silent && npm run build:native && npm run build
	@echo "📦 Linking SDK to examples..."
	@cd examples/node && npm install --silent
	@echo "✅ Node.js SDK built and linked to examples"

# Build Go SDK locally (debug mode, static linking)
dev\:go: $(if $(SETUP_DONE),,runtime)
	@echo "🔨 Building Go SDK (debug)..."
	@cargo build -p boxlite-c
	@bash $(SCRIPT_DIR)/build/fix-go-symbols.sh target/debug/libboxlite.a
	@cd sdks/go && go build -tags boxlite_dev ./...
	@echo "✅ Go SDK built. You can now run: cd sdks/go && go test -tags boxlite_dev -v ./..."
