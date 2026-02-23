PHONY_TARGETS += dist\:python dist\:c dist\:node package

dist\:python:
	@if [ ! -d .venv ]; then \
		echo "📦 Creating virtual environment..."; \
		python3 -m venv .venv; \
	fi

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

dist\:c: runtime
	@if [ "$$(uname)" = "Darwin" ]; then \
		bash $(SCRIPT_DIR)/package/package-macos.sh $(ARGS); \
	elif [ "$$(uname)" = "Linux" ]; then \
		bash $(SCRIPT_DIR)/package/package-linux.sh $(ARGS); \
	else \
		echo "❌ Unsupported platform: $$(uname)"; \
		exit 1; \
	fi

# Build Node.js distribution packages (local use)
dist\:node: runtime
	@cd sdks/node && npm install --silent && npm run build:native -- --release && npm run build && npm run artifacts && npm run bundle:runtime && npm run pack:all

package:
	@$(MAKE) dist:c
