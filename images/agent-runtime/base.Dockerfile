FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    less \
    openssh-client \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    sudo \
    tzdata \
    unzip \
    wget \
    zip \
  && ln -fs /usr/share/zoneinfo/$TZ /etc/localtime \
  && dpkg-reconfigure -f noninteractive tzdata \
  && echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/boxlite \
  && chmod 0440 /etc/sudoers.d/boxlite \
  && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY apps/dist/apps/daemon-runtime/boxlite-daemon-${TARGETARCH} /boxlite/bin/boxlite-daemon
COPY images/agent-runtime/start-agent-runtime.sh /boxlite/bin/start-agent-runtime
RUN chmod 0755 /boxlite/bin/boxlite-daemon /boxlite/bin/start-agent-runtime \
  && mkdir -p /workspace

WORKDIR /workspace
ENTRYPOINT ["/boxlite/bin/start-agent-runtime"]
CMD ["sleep", "infinity"]
