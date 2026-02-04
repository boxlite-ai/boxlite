# BoxLite Go SDK Makefile

# Path definitions
ROOT_DIR := $(shell git rev-parse --show-toplevel)
RUST_DIR := rust
RUST_TARGET_DIR := $(ROOT_DIR)/target
DEBUG_LIB_DIR := $(RUST_TARGET_DIR)/debug
RELEASE_LIB_DIR := $(RUST_TARGET_DIR)/release

# Library name (Linux: libboxlite_go_bridge.a, macOS: libboxlite_go_bridge.a)
LIB_NAME := boxlite_go_bridge

# OS Detection
UNAME_S := $(shell uname -s)

# Default target
.PHONY: all
all: build-rust build-go

# 1. Build Rust
.PHONY: build-rust
build-rust:
	@echo "🦀 Building Rust side..."
	cd $(RUST_DIR) && cargo build

.PHONY: build-rust-release
build-rust-release:
	@echo "🦀 Building Rust side (release)..."
	cd $(RUST_DIR) && cargo build --release

# 2. Run Go (Dev Mode)
.PHONY: run
run: build-rust
	@echo "🐹 Running Go example..."
	go run ./cmd/boxlite

# 3. Test
.PHONY: test
test: build-rust
	@echo "🧪 Running Go tests..."
ifeq ($(UNAME_S),Darwin)
	@# --- macOS Specific ---
	@echo "🍎 macOS detected - configuring dynamic link paths..."
	@# Find and copy libkrun dylibs (dynamically find version)
	@find $(RUST_TARGET_DIR)/debug/build -name "libkrun.*.dylib" -print0 | xargs -0 ls -t | head -1 | xargs -I {} cp {} $(DEBUG_LIB_DIR)/
	@find $(RUST_TARGET_DIR)/debug/build -name "libkrunfw.*.dylib" -print0 | xargs -0 ls -t | head -1 | xargs -I {} cp {} $(DEBUG_LIB_DIR)/
	@# Find and copy libgvproxy dylib
	@find $(RUST_TARGET_DIR)/debug/build -name "libgvproxy.dylib" -print0 | xargs -0 ls -t | head -1 | xargs -I {} cp {} $(DEBUG_LIB_DIR)/
	@# Create symlinks for linker
	@ln -sf $$(ls $(DEBUG_LIB_DIR)/libkrun.*.dylib | grep -v "libkrun.dylib" | head -1) $(DEBUG_LIB_DIR)/libkrun.dylib
	
	@# Run tests with macOS flags
	CGO_LDFLAGS="$(DEBUG_LIB_DIR)/lib$(LIB_NAME).a -L$(DEBUG_LIB_DIR) -lkrun -lgvproxy -framework CoreFoundation -framework Security -framework IOKit -Wl,-rpath,$(DEBUG_LIB_DIR)" \
	go test -v ./...
else
	@# --- Linux Specific ---
	@echo "🐧 Linux detected - configuring LD_LIBRARY_PATH..."
	@# Find directories containing libkrun.so and libgvproxy.so
	@LIBKRUN_DIR=$$(find $(RUST_TARGET_DIR)/debug/build -name "libkrun-sys-*" -type d 2>/dev/null | head -1)/out/libkrun/lib && \
	LIBGVPROXY_DIR=$$(find $(RUST_TARGET_DIR)/debug/build -name "libgvproxy-sys-*" -type d 2>/dev/null | head -1)/out && \
	LD_LIBRARY_PATH="$(DEBUG_LIB_DIR):$$LIBKRUN_DIR:$$LIBGVPROXY_DIR" \
	CGO_LDFLAGS="$(DEBUG_LIB_DIR)/lib$(LIB_NAME).a -L$(DEBUG_LIB_DIR) -L$$LIBKRUN_DIR -L$$LIBGVPROXY_DIR -lkrun -lgvproxy -lpthread -ldl" \
	go test -v ./...
endif

# 4. Lint and Format
.PHONY: fmt
fmt:
	cd $(RUST_DIR) && cargo fmt
	go fmt ./...

.PHONY: clean
clean:
	cd $(RUST_DIR) && cargo clean
	rm -f boxlite-go tests/client


