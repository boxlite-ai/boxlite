PHONY_TARGETS += venv\:python dev\:python dev\:c dev\:node

# Ensure Python venv exists with dev dependencies (lightweight, no runtime build).
venv\:python:
	@if [ ! -d .venv ]; then \
		echo "📦 Creating virtual environment..."; \
		python3 -m venv .venv || { echo "❌ Failed to create virtual environment"; exit 1; }; \
	fi
	@. .venv/bin/activate && pip install -q -e "sdks/python[dev,sync]"

# Build wheel locally with maturin + platform-specific repair tool
dev\:python: runtime-debug
	@$(MAKE) venv:python
	@echo "📦 Copying runtime to Python module..."
	@rm -rf $(CURDIR)/sdks/python/boxlite/runtime
	@cp -a $(CURDIR)/target/boxlite-runtime $(CURDIR)/sdks/python/boxlite/runtime

	@echo "🔨 Building wheel with maturin..."
	@. .venv/bin/activate && pip install -q maturin && cd sdks/python && maturin develop

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
