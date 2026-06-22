dist\:python: _ensure-python-deps
	@echo "📦 Installing cibuildwheel..."
	@. .venv/bin/activate && pip install -q cibuildwheel

	@if [ "$$(uname)" = "Darwin" ]; then \
		source .venv/bin/activate && \
		cibuildwheel --only cp314-macosx_arm64 sdks/python; \
	elif [ "$$(uname)" = "Linux" ]; then \
		source .venv/bin/activate && \
		bash $(SCRIPT_DIR)/build/build-guest.sh && \
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
		cp target/release/libboxlite.dylib sdks/c/dist/lib/ && \
		cp target/release/libboxlite.a sdks/c/dist/lib/; \
	elif [ "$$(uname)" = "Linux" ]; then \
		cp target/release/libboxlite.so sdks/c/dist/lib/ && \
		cp target/release/libboxlite.a sdks/c/dist/lib/; \
	fi
	@echo "✅ C SDK staged in sdks/c/dist/"
	@echo "   sdks/c/dist/lib/     - Libraries"
	@echo "   sdks/c/dist/include/ - Header"

# Build Node.js distribution packages (local use)
dist\:node: runtime
	@cd sdks/node && npm install --silent && npm run build:native -- --release && npm run build && npm run artifacts && npm run bundle:runtime && npm run pack:all

dist\:go:
	@echo "📦 Building Go SDK (release)..."
	@cargo build --release -p boxlite-c
	@bash $(SCRIPT_DIR)/build/fix-go-symbols.sh target/release/libboxlite.a
	@echo "✅ Go SDK release built"

dist\:runner: _ensure-apps-deps
	@set -euo pipefail; \
	VERSION="$${RUNNER_VERSION:-$$(grep -m 1 '^version' Cargo.toml | sed -E 's/^version *= *"([^"]+)".*/\1/')}"; \
	OUT_DIR="$${RUNNER_OUT_DIR:-dist/runner}"; \
	TARBALL="boxlite-runner-v$${VERSION}-linux-amd64.tar.gz"; \
	echo "🔨 Building runner distribution ($${VERSION}, linux/amd64)..."; \
	$(MAKE) --no-print-directory dist:c; \
	bash $(SCRIPT_DIR)/build/fix-go-symbols.sh target/release/libboxlite.a; \
	cp target/release/libboxlite.a sdks/go/libboxlite.a; \
	mkdir -p apps/dist/libs; \
	CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -C apps -o dist/libs/computer-use-amd64 ./libs/computer-use/; \
	( cd apps && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 SKIP_COMPUTER_USE_BUILD=true VERSION="$${VERSION}" yarn nx build runner --configuration=production --nxBail=true ); \
	mkdir -p "$${OUT_DIR}"; \
	tmp="$$(mktemp -d)"; \
	trap 'rm -rf "$${tmp}"' EXIT; \
	install -m 0755 apps/dist/apps/runner-amd64 "$${tmp}/boxlite-runner"; \
	tar -czf "$${OUT_DIR}/$${TARBALL}" -C "$${tmp}" boxlite-runner; \
	( cd "$${OUT_DIR}" && { command -v sha256sum >/dev/null && sha256sum "$${TARBALL}" || shasum -a 256 "$${TARBALL}"; } > "$${TARBALL}.sha256" ); \
	echo "✅ Runner distribution staged: $${OUT_DIR}/$${TARBALL}"
