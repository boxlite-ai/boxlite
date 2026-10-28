# syntax=docker/dockerfile:1.7

# Local escape hatch for the same Linux AMD64 artifact CI builds.
#
# This is deliberately separate from apps/runner/Dockerfile. That image consumes a prebuilt
# libboxlite.a and produces a runtime container; this target builds the embedded runtime from the
# current checkout and exports only the two files the EC2 updater accepts.
FROM ubuntu:24.04 AS build

ENV CI=true
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.cargo/bin:/usr/local/go/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git make libx11-dev libxtst-dev libxinerama-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Copy compiler inputs explicitly. In particular, never copy apps/infra/.env (gitignored stage
# secrets) into a Docker cache layer merely because the build context is the repository root.
COPY Cargo.toml Cargo.lock Makefile rust-toolchain.toml rustfmt.toml .gitmodules LICENSE NOTICE ./
COPY .cargo/ .cargo/
COPY make/ make/
COPY scripts/ scripts/
COPY src/ src/
COPY sdks/ sdks/
COPY apps/go.work apps/go.work.sum apps/
COPY apps/runner/ apps/runner/
COPY apps/libs/common-go/ apps/libs/common-go/
COPY apps/libs/api-client-go/ apps/libs/api-client-go/

# Docker intentionally excludes the host's .git metadata. setup:build only needs a repository to
# decide that the already-populated submodules need no mutation, so give it a local one. The build
# command checks those directories before invoking Docker and the tests below fail loudly if a
# caller bypasses it with an uninitialized checkout.
RUN test -f src/deps/libkrun-sys/vendor/libkrun/Cargo.toml \
  && test -f src/deps/libkrun-sys/vendor/libkrunfw/Makefile \
  && test -f src/deps/e2fsprogs-sys/vendor/e2fsprogs/configure \
  && test -f src/deps/bubblewrap-sys/vendor/bubblewrap/meson.build \
  && git init -q

RUN make setup:build guest
RUN SKIP_GUEST_BUILD=1 make runtime \
  && cargo build --release -p boxlite-c \
  && bash scripts/build/fix-go-symbols.sh target/release/libboxlite.a \
  && cp target/release/libboxlite.a sdks/go/libboxlite.a

# Keep the production Runner's deliberately small Go workspace rather than making its build depend
# on every Go module in apps/.
RUN printf 'go 1.25.4\n\nuse (\n\t./runner\n\t./libs/common-go\n\t./libs/api-client-go\n\t../sdks/go\n)\n' > apps/go.work \
  && go -C apps/runner mod download \
  && go -C apps/libs/common-go mod download \
  && go -C apps/libs/api-client-go mod download

ARG BUILD_REF
ARG VERSION
ARG VERSION_IDENTITY
RUN test -n "${BUILD_REF}" \
  && test -n "${VERSION}" \
  && test -n "${VERSION_IDENTITY}" \
  && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -C apps \
    -ldflags "-X 'github.com/boxlite-ai/runner/internal.Version=${VERSION_IDENTITY}'" \
    -o /tmp/boxlite-runner \
    ./runner/cmd/runner/ \
  && mkdir -p /out \
  && archive="boxlite-runner-v${VERSION}-${BUILD_REF}-linux-amd64.tar.gz" \
  && tar czf "/out/${archive}" -C /tmp boxlite-runner \
  && cd /out \
  && sha256sum "${archive}" > "${archive}.sha256"

FROM scratch AS artifact
COPY --from=build /out/ /
