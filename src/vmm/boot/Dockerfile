FROM debian:bookworm-20260918-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS toolchain

# Freeze package resolution as well as the base image. A dated tag alone does
# not pin the compiler installed by apt.
RUN rm /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260919T000000Z bookworm main' > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 update \
    && for attempt in 1 2 3; do \
        apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 install -y --no-install-recommends \
        bc bison ca-certificates curl flex gcc gcc-x86-64-linux-gnu \
        libc6-dev libc6-dev-amd64-cross libelf-dev libssl-dev make xz-utils && break; \
        [ "$attempt" -lt 3 ] || exit 1; \
    done \
    && rm -rf /var/lib/apt/lists/*

FROM toolchain AS source
WORKDIR /kernel
COPY kernel.lock /input/kernel.lock
RUN . /input/kernel.lock \
    && curl --fail --location --retry 3 --connect-timeout 30 --max-time 600 \
        "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz" -o /kernel.tar.xz \
    && printf '%s  %s\n' "$KERNEL_SHA256" /kernel.tar.xz | sha256sum --check --strict \
    && tar -xJf /kernel.tar.xz --strip-components=1 \
    && rm /kernel.tar.xz

FROM source AS build
COPY kernel.config init.c build.sh Dockerfile /input/
RUN bash /input/build.sh

FROM scratch AS artifacts
COPY --from=build /artifacts/ /
