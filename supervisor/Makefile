# BoxLite Micro-cloud supervisor.
#
#   make build   → bin/supervisor-linux-amd64, bin/supervisor-linux-arm64
#                  (+ uname -m aliases x86_64/aarch64 for the bootstrap curl)
#   make test    → go test ./...
#   make check   → vet + cross-compile check for linux/amd64
#   make test-linux → the whole suite in golang:1.26 (Linux), plus the root-only
#                  privilege tests (-tags roottest): real sudo, a boxlite user
#                  (uid 1001) with the image's NOPASSWD sudo, and the Box cmd
#                  read from control-plane/src/platform.ts. SYS_PTRACE only lets the
#                  root test inspect the (non-dumpable) supervisor process.
#   make run     → run locally against a control plane on :8787
#   make release-key → create the release signing key (once, on the build machine)
#
# When RELEASE_KEY exists, build compiles its public key into the supervisor and
# writes <binary>.sig next to each binary; the launcher in a Box then refuses
# any update that the key did not sign (internal/privilege/releasesig.go).

GO        ?= go
BIN       ?= bin
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
RELEASE_KEY ?= $(HOME)/.config/microcloud/release-ed25519
RELEASE_PUB := $(shell [ -f $(RELEASE_KEY) ] && $(GO) run ./cmd/releasesign -key $(RELEASE_KEY) -pub)
LDFLAGS   := -s -w -X main.version=$(VERSION) $(if $(RELEASE_PUB),-X github.com/boxlite-ai/microcloud/supervisor/internal/privilege.ReleasePublicKey=$(RELEASE_PUB))
GOFLAGS   := -trimpath

.PHONY: build test test-linux check run clean release-key

build: $(BIN)/supervisor-linux-amd64 $(BIN)/supervisor-linux-arm64
ifneq ($(RELEASE_PUB),)
	$(GO) run ./cmd/releasesign -key $(RELEASE_KEY) $(BIN)/supervisor-linux-amd64 $(BIN)/supervisor-linux-arm64
	ln -sf supervisor-linux-amd64.sig $(BIN)/supervisor-linux-x86_64.sig
	ln -sf supervisor-linux-arm64.sig $(BIN)/supervisor-linux-aarch64.sig
endif

release-key:
	$(GO) run ./cmd/releasesign -key $(RELEASE_KEY) -gen

$(BIN)/supervisor-linux-amd64: $(shell find . -name '*.go') go.mod
	@mkdir -p $(BIN)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $@ .
	ln -sf supervisor-linux-amd64 $(BIN)/supervisor-linux-x86_64

$(BIN)/supervisor-linux-arm64: $(shell find . -name '*.go') go.mod
	@mkdir -p $(BIN)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $@ .
	ln -sf supervisor-linux-arm64 $(BIN)/supervisor-linux-aarch64

test:
	$(GO) test ./...

GOIMAGE   ?= golang:1.26
ROOTTEST_SETUP := apt-get update -qq >/dev/null && apt-get install -y -qq sudo procps >/dev/null && \
	useradd -m -u 1001 -U -s /bin/bash boxlite && usermod -aG sudo boxlite && \
	echo 'boxlite ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/boxlite && chmod 440 /etc/sudoers.d/boxlite

test-linux:
	docker run --rm --cap-add SYS_PTRACE -v "$(CURDIR)/..":/repo -w /repo/supervisor \
		-v microcloud-gocache:/root/.cache/go-build -v microcloud-gomod:/go/pkg/mod $(GOIMAGE) \
		sh -c "$(ROOTTEST_SETUP) && go test -count=1 ./... && go test -tags roottest -count=1 -v ./internal/privilege/"

check:
	$(GO) vet ./...
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build $(GOFLAGS) ./...

run:
	BOXLITE_CP_URL=$${BOXLITE_CP_URL:-http://localhost:8787} \
	BOXLITE_BOX_TOKEN=$${BOXLITE_BOX_TOKEN:-bxt_dev} \
	BOXLITE_ENV_ID=$${BOXLITE_ENV_ID:-env_dev} \
	SV_STATE_DIR=$${SV_STATE_DIR:-/tmp/boxlite-sv} \
	SV_LISTEN=$${SV_LISTEN:-:8080} \
	$(GO) run -ldflags "$(LDFLAGS)" .

clean:
	rm -rf $(BIN)
