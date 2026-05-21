PHONY_TARGETS += guest shim runtime cli cli\:release skillbox-image build\:apps libkrunfw-dind

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

# Build the apps/ workspace (api, dashboard, runner, proxy, libs…) via the
# repo's own blessed script (nx run-many --target=build --all). The webpack
# build runs tsc, so this is the compile gate for apps/ changes.
build\:apps: _ensure-apps-deps
	@echo "🔨 Building apps workspace..."
	@cd apps && yarn build
	@echo "✅ apps workspace built → dist/apps"

# Build the "fat" libkrunfw variant required by `boxlite run --support-docker`
# (issue #276): the lean default kernel lacks CONFIG_BRIDGE/NETFILTER/NF_NAT/
# IPTABLE_*/NF_TABLES, which docker / docker-compose need for bridge networks,
# NAT and iptables rule installation. This target builds a second libkrunfw
# blob with those configs added on top of the lean config, and copies it to
#
#     target/dind-kernel/lib64/libkrunfw-dind.so.5
#
# Wire-up: the libkrun-sys build.rs picks this blob up via the
# BOXLITE_LIBKRUNFW_DIND_PATH environment variable (set automatically by this
# target when invoking downstream builds in the same shell). Without this
# target ever being run, `--support-docker` still applies the userspace
# changes (cgroup rw + full caps) but the kernel stays lean, so bridge /
# iptables-dependent features keep failing. With it run + the env var set,
# the dind blob is staged alongside the lean one and the runtime picks the
# right blob per-box.
#
# Heavy target (~10–20 min, downloads kernel source). Only run when actively
# iterating on the dind feature; not in any other target's dep chain.
libkrunfw-dind:
	@bash $(SCRIPT_DIR)/build/build-libkrunfw-dind.sh

# Build SkillBox container image (all-in-one AI CLI with noVNC)
# Usage: make skillbox-image [APT_SOURCE=mirrors.aliyun.com]
skillbox-image:
	@echo "🐳 Building SkillBox container image..."
	@docker build $(if $(APT_SOURCE),--build-arg APT_SOURCE=$(APT_SOURCE)) -t boxlite-skillbox:latest src/boxlite/resources/images/skillbox/
	@echo "✅ SkillBox image built: boxlite-skillbox:latest"
