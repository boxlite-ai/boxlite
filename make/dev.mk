PHONY_TARGETS += _ensure-python-deps dev\:python dev\:c dev\:node _ensure-node-deps

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

# Build wheel locally with maturin + embedded runtime
dev\:python: runtime-debug _ensure-python-deps
	@echo "🔨 Building wheel with maturin (embedded-runtime)..."
	@. .venv/bin/activate && pip install -q maturin && cd sdks/python && maturin develop

dev\:c:
	@echo "🔨 Building C SDK (debug)..."
	@cargo build -p boxlite-c
	@echo "✅ C SDK built:"
	@echo "   Library: target/debug/libboxlite.{dylib,so,a}"
	@echo "   Header:  sdks/c/include/boxlite.h"

# Build Node.js SDK locally with napi-rs (debug mode)
dev\:node: runtime-debug
	@cd sdks/node && npm install --silent && npm run build:native && npm run build
	@echo "📦 Linking SDK to examples..."
	@cd examples/node && npm install --silent
	@echo "✅ Node.js SDK built and linked to examples"
