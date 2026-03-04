PHONY_TARGETS += dist\:python dist\:c dist\:node

dist\:python: _ensure-python-deps
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

dist\:c:
	@echo "🔨 Building C SDK (release)..."
	@cargo build --release -p boxlite-c
	@mkdir -p sdks/c/dist/lib sdks/c/dist/include
	@cp sdks/c/include/boxlite.h sdks/c/dist/include/
	@if [ "$$(uname)" = "Darwin" ]; then \
		cp target/release/libboxlite.dylib sdks/c/dist/lib/; \
		cp target/release/libboxlite.a sdks/c/dist/lib/; \
	elif [ "$$(uname)" = "Linux" ]; then \
		cp target/release/libboxlite.so sdks/c/dist/lib/; \
		cp target/release/libboxlite.a sdks/c/dist/lib/; \
	fi
	@echo "✅ C SDK staged in sdks/c/dist/"
	@echo "   sdks/c/dist/lib/     - Libraries"
	@echo "   sdks/c/dist/include/ - Header"

# Build Node.js distribution packages (local use)
dist\:node: runtime
	@cd sdks/node && npm install --silent && npm run build:native -- --release && npm run build && npm run artifacts && npm run bundle:runtime && npm run pack:all
