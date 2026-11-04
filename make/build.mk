PHONY_TARGETS += guest shim runtime vmm vmm\:boot vmm\:boot\:host cli cli\:release skillbox-image build\:apps build\:apps\:dashboard

vmm:
	@cargo build -p boxlite-hypervisor -p boxlite-vmm

vmm\:boot: export _BOXLITE_BOOT_OUTPUT_ARG := $(value BOOT_OUTPUT)
vmm\:boot: export _BOXLITE_BOOT_JOBS_ARG := $(value BOOT_JOBS)
vmm\:boot:
	@bash "$(SCRIPT_DIR)/build/build-vmm-boot-in-box.sh"

vmm\:boot\:host: export _BOXLITE_BOOT_OUTPUT_ARG := $(value BOOT_OUTPUT)
vmm\:boot\:host: export _BOXLITE_BOOT_JOBS_ARG := $(value BOOT_JOBS)
vmm\:boot\:host:
	@bash "$(SCRIPT_DIR)/build/build-vmm-boot.sh"

guest: export _BOXLITE_GUEST_TARGET_ARG := $(value GUEST_TARGET)
guest: export _BOXLITE_PROFILE_ARG := $(value PROFILE)
guest:
	@target="$${_BOXLITE_GUEST_TARGET_ARG:-$$(bash "$$PWD/scripts/util.sh" --target)}"; \
	profile="$${_BOXLITE_PROFILE_ARG:-release}"; \
	bash "$$PWD/scripts/build/build-guest.sh" --target "$$target" --profile "$$profile" && \
	bash "$$PWD/scripts/build/build-guest-deps.sh" --target "$$target" --profile "$$profile"

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

# Build the apps/ workspace (api, dashboard, runner, proxy, libs…) via the
# repo's own blessed script (nx run-many --target=build --all). The webpack
# build runs tsc, so this is the compile gate for apps/ changes.
build\:apps: _ensure-apps-deps
	@echo "🔨 Building apps workspace..."
	@cd apps && yarn build
	@echo "✅ apps workspace built → dist/apps"

build\:apps\:dashboard: _ensure-apps-deps
	@cd apps && yarn nx run dashboard:build

.PHONY: build\:apps\:api
build\:apps\:api: _ensure-apps-deps
	@cd apps && yarn nx run api:build

.PHONY: build\:apps\:api-production
build\:apps\:api-production: _ensure-apps-deps
	@cd apps && yarn nx run api:build --configuration=production

.PHONY: typecheck\:apps\:api
typecheck\:apps\:api: _ensure-apps-deps
	@cd apps && yarn tsc --noEmit -p api/tsconfig.app.json

.PHONY: check\:apps\:api-bootstrap
check\:apps\:api-bootstrap:
	@$(MAKE) build:apps:api-production
	@cd apps && node dist/apps/api/bootstrap-check.js api/.env.example
	@cd apps && node dist/apps/api/bootstrap-check.js api/.env.example --openapi

# Build SkillBox container image (all-in-one AI CLI with noVNC)
# Usage: make skillbox-image [APT_SOURCE=mirrors.aliyun.com]
skillbox-image:
	@echo "🐳 Building SkillBox container image..."
	@docker build $(if $(APT_SOURCE),--build-arg APT_SOURCE=$(APT_SOURCE)) -t boxlite-skillbox:latest src/boxlite/resources/images/skillbox/
	@echo "✅ SkillBox image built: boxlite-skillbox:latest"

PHONY_TARGETS += build\:apps\:cloud-app-cli build\:apps\:cloud-app-supervisor build\:apps\:cloud-app-artifacts

build\:apps\:cloud-app-cli: _ensure-apps-deps
	@cd apps/cloud-app-cli && ../node_modules/.bin/esbuild ../libs/cloud-app-shared/src/index.ts --bundle --platform=node --target=node20 --format=esm --packages=external --outfile=dist/shared.mjs --log-level=warning
	@cd apps/cloud-app-cli && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx scripts/gen-reference.ts
	@cd apps/cloud-app-cli && ../node_modules/.bin/esbuild src/bin.ts --bundle --platform=node --target=node20 --format=cjs --tsconfig=tsconfig.json --outfile=dist/boxlite-app.cjs --banner:js='#!/usr/bin/env node' --log-level=warning
	@chmod +x apps/cloud-app-cli/dist/boxlite-app.cjs
	@node apps/cloud-app-cli/scripts/package.mjs

build\:apps\:cloud-app-supervisor:
	@$(MAKE) -C apps/cloud-app-supervisor build
	@mkdir -p apps/dist/apps/cloud-app-artifacts
	@cp apps/cloud-app-supervisor/bin/supervisor-linux-* apps/dist/apps/cloud-app-artifacts/

build\:apps\:cloud-app-artifacts:
	@$(MAKE) build:apps:cloud-app-cli
	@$(MAKE) build:apps:cloud-app-supervisor
