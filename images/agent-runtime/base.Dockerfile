# Debian slim keeps the base image small while still supporting apt-managed tools.
FROM debian:bookworm-slim

# Noninteractive apt avoids CI prompts; pip settings let users install Python tools inside the box.
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Install baseline interactive/dev tools expected in every BoxLite runtime image.
# bash: familiar shell for users and scripts.
# ca-certificates: trust store for HTTPS downloads and git remotes.
# curl: common HTTP client for setup scripts and API checks.
# git: clone and inspect source repositories from inside a box.
# jq: inspect JSON responses during debugging.
# less: pager for logs and command output.
# openssh-client: SSH client utilities for git over SSH and remote access.
# procps: ps/top/free process tools used for runtime inspection.
# python3/python3-pip/python3-venv: baseline Python tooling even in the generic base image.
# sudo: allow passwordless privilege escalation inside this disposable runtime image.
# tzdata: UTC timezone data so tools report consistent timestamps.
# unzip/wget/zip: common archive and download utilities for setup workflows.
# The same RUN configures UTC, enables passwordless sudo, and removes apt metadata to keep the image small.
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

# Buildx provides TARGETARCH so each image copies the matching daemon binary.
ARG TARGETARCH
# Embed the Linux daemon that exposes BoxLite toolbox/session APIs inside the box.
COPY apps/dist/apps/daemon-runtime/boxlite-daemon-${TARGETARCH} /boxlite/bin/boxlite-daemon
# Embed the startup wrapper that fills required env fallbacks before launching the daemon.
COPY images/agent-runtime/start-agent-runtime.sh /boxlite/bin/start-agent-runtime
# Make embedded binaries executable and create the default user workspace.
RUN chmod 0755 /boxlite/bin/boxlite-daemon /boxlite/bin/start-agent-runtime \
  && mkdir -p /workspace

# Users and agent commands start in /workspace.
WORKDIR /workspace
# Always start through the wrapper so BOXLITE_BOX_ID fallback is applied.
ENTRYPOINT ["/boxlite/bin/start-agent-runtime"]
# Keep the container alive until the runner asks the daemon to execute work.
CMD ["sleep", "infinity"]
