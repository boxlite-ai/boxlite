PHONY_TARGETS += guest shim runtime cli cli\:release server server\:release skillbox-image

guest:
	@bash $(SCRIPT_DIR)/build/build-guest.sh

shim:
	@bash $(SCRIPT_DIR)/build/build-shim.sh

runtime:
	@bash $(SCRIPT_DIR)/build/build-runtime.sh --profile release

runtime\:debug:
	@bash $(SCRIPT_DIR)/build/build-runtime.sh --profile debug

cli: runtime\:debug
	@echo "🔨 Building boxlite CLI..."
	@cargo build -p boxlite-cli
	@echo "✅ CLI built: ./target/debug/boxlite"

cli\:release: runtime
	@echo "🔨 Building boxlite CLI (release)..."
	@cargo build -p boxlite-cli --release
	@echo "✅ CLI built: ./target/release/boxlite"

server: runtime\:debug
	@echo "🔨 Building boxlite-server..."
	@cargo build -p boxlite-server
	@echo "✅ Server built: ./target/debug/boxlite-server"

server\:release: runtime
	@echo "🔨 Building boxlite-server (release)..."
	@cargo build -p boxlite-server --release
	@echo "✅ Server built: ./target/release/boxlite-server"

# Build SkillBox container image (all-in-one AI CLI with noVNC)
# Usage: make skillbox-image [APT_SOURCE=mirrors.aliyun.com]
skillbox-image:
	@echo "🐳 Building SkillBox container image..."
	@docker build $(if $(APT_SOURCE),--build-arg APT_SOURCE=$(APT_SOURCE)) -t boxlite-skillbox:latest src/boxlite/resources/images/skillbox/
	@echo "✅ SkillBox image built: boxlite-skillbox:latest"
