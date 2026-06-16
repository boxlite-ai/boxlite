# Python slim provides Python 3.12 while keeping the image smaller than full Debian.
FROM python:3.12-slim-bookworm

# Noninteractive apt avoids CI prompts; pip settings support system-level package installs in boxes.
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Install Python-focused runtime and build tools expected by agent workloads.
# bash: familiar shell for users and scripts.
# build-essential: gcc/make toolchain for Python packages with native extensions.
# ca-certificates: trust store for HTTPS downloads and git remotes.
# curl: common HTTP client for setup scripts and API checks.
# git: clone and inspect source repositories from inside a box.
# jq: inspect JSON responses during debugging.
# less: pager for logs and command output.
# openssh-client: SSH client utilities for git over SSH and remote access.
# pkg-config: locate native libraries when building Python wheels.
# procps: ps/top/free process tools used for runtime inspection.
# python3/python3-pip/python3-venv: Debian Python tools for compatibility with apt packages.
# sudo: allow passwordless privilege escalation inside this disposable runtime image.
# tzdata: UTC timezone data so tools report consistent timestamps.
# unzip/wget/zip: common archive and download utilities for setup workflows.
# The same RUN configures UTC, upgrades Python packaging tools, enables sudo, and removes apt metadata.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    less \
    openssh-client \
    pkg-config \
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
  && python -m pip install --upgrade pip setuptools wheel \
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
