PHONY_TARGETS += generate\:runner-client

# Regenerate the client from the committed runner schema without starting the API.
generate\:runner-client: _ensure-apps-deps
	@cd apps && yarn openapi-generator-cli generate --git-repo-id=boxlite --git-user-id=boxlite-ai -i runner/pkg/api/docs/swagger.json -g typescript-axios --additional-properties=supportsES6=true,typescriptThreePlus=true,withSeparateModelsAndApi=true,apiPackage=api,modelPackage=models,useTags=true,enumPropertyNaming=UPPERCASE --type-mappings=DateTime=Date -o libs/runner-api-client/src
	@cd apps && node hack/ts-client/type-request-function.mjs libs/runner-api-client/src

PHONY_TARGETS += guest shim runtime vmm vmm\:boot vmm\:boot\:host cli cli\:release skillbox-image build\:apps build\:apps\:api build\:apps\:dashboard build\:apps\:ci-listener

vmm:
	@cargo build -p boxlite-hypervisor -p boxlite-vmm

# Keep the test init separate from guest binaries assembled into product runtimes.
PHONY_TARGETS += vmm\:guest-mount-init
vmm\:guest-mount-init:
	@bash -ec 'source "$(SCRIPT_DIR)/build/build-libseccomp.sh"; \
	ensure_libseccomp_for_target x86_64-unknown-linux-musl; \
	cargo build -p boxlite-guest --bin boxlite-guest --features integration-test-init --target x86_64-unknown-linux-musl --release --target-dir "$(PROJECT_ROOT)/target/vmm/guest-mount"'

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

build\:apps\:api: _ensure-apps-deps
	@cd apps && yarn nx run api:build --configuration=production --nxBail=true --output-style=stream
	@cd apps && node --check dist/apps/api/main.js
	@cd apps && node --test api/test/production-metadata.cjs

build\:apps\:dashboard: _ensure-apps-deps
	@cd apps && yarn nx run dashboard:build

# Shared TypeScript core; both hosts consume this library.
build\:apps\:ci-listener: _ensure-apps-deps
	@cd apps && yarn nx build ci-listener --nxBail=true --output-style=stream
	@cd apps && node libs/ci-listener/tests/package-entry.cjs dist/libs/ci-listener

PHONY_TARGETS += build\:apps\:github-ci-runner
build\:apps\:github-ci-runner: _ensure-apps-deps
	@cd apps && yarn nx build github-ci-runner --nxBail=true --output-style=stream
	@cd apps && node --check dist/apps/github-ci-runner/main.js

PHONY_TARGETS += github-ci-runner-image
github-ci-runner-image:
	@docker build --platform linux/amd64 -f apps/github-ci-runner/Dockerfile -t boxlite-ci-listener:dev .

# Build SkillBox container image (all-in-one AI CLI with noVNC)
# Usage: make skillbox-image [APT_SOURCE=mirrors.aliyun.com]
skillbox-image:
	@echo "🐳 Building SkillBox container image..."
	@docker build $(if $(APT_SOURCE),--build-arg APT_SOURCE=$(APT_SOURCE)) -t boxlite-skillbox:latest src/boxlite/resources/images/skillbox/
	@echo "✅ SkillBox image built: boxlite-skillbox:latest"
