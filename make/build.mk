PHONY_TARGETS += guest shim runtime-assets runtime cli skillbox-image build\:apps

BUILD_PROFILE ?= release
export BUILD_PROFILE

guest:
	@bash $(SCRIPT_DIR)/build/build-guest.sh

shim:
	@bash $(SCRIPT_DIR)/build/build-shim.sh

runtime-assets:
	+@bash $(SCRIPT_DIR)/build/build-runtime-assets.sh

runtime: runtime-assets guest shim
	@bash $(SCRIPT_DIR)/build/build-runtime.sh

cli: runtime
	@echo "🔨 Building boxlite CLI ($(BUILD_PROFILE))..."
	@bash $(SCRIPT_DIR)/build/build-cli.sh
	@echo "✅ CLI built: ./target/$(BUILD_PROFILE)/boxlite"

# Build the apps/ workspace (api, dashboard, runner, proxy, libs…) via the
# repo's own blessed script (nx run-many --target=build --all). The webpack
# build runs tsc, so this is the compile gate for apps/ changes.
build\:apps: _ensure-apps-deps
	@echo "🔨 Building apps workspace..."
	@cd apps && yarn build
	@echo "✅ apps workspace built → dist/apps"

# Build SkillBox container image (all-in-one AI CLI with noVNC)
# Usage: make skillbox-image [APT_SOURCE=mirrors.aliyun.com]
skillbox-image:
	@echo "🐳 Building SkillBox container image..."
	@docker build $(if $(APT_SOURCE),--build-arg APT_SOURCE=$(APT_SOURCE)) -t boxlite-skillbox:latest src/boxlite/resources/images/skillbox/
	@echo "✅ SkillBox image built: boxlite-skillbox:latest"
