# Copyright 2026 BoxLite AI
# SPDX-License-Identifier: Apache-2.0
#
# Built from the repository root:
#   docker build -f apps/proxy-rs/Dockerfile .

FROM rust:1-bookworm AS build

WORKDIR /boxlite/apps/proxy-rs

COPY apps/proxy-rs/ ./

ARG VERSION=0.0.1

# The target directory and the registry are cache mounts, so the binary is
# copied out of them before the layer ends.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/boxlite/apps/proxy-rs/target \
    VERSION=$VERSION cargo build --release --locked \
    && cp target/release/boxlite-proxy /usr/local/bin/boxlite-proxy

FROM debian:bookworm-slim AS proxy

# ca-certificates: TLS to the control-plane API and to runners.
# curl: the health check below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/boxlite-proxy /usr/local/bin/boxlite-proxy

HEALTHCHECK CMD [ "curl", "-f", "http://localhost:4000/health" ]

ENTRYPOINT ["boxlite-proxy"]
