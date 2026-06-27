# Node slim provides Node 22 while keeping the image smaller than full Debian.
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4

# Noninteractive apt avoids CI prompts; pip settings support Python tooling often used by Node projects.
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Install Node-oriented runtime tools plus Python helpers needed by many JS build chains.
# bash: familiar shell for users and scripts.
# ca-certificates: trust store for HTTPS downloads and git remotes.
# curl: common HTTP client for setup scripts and API checks.
# git: clone and inspect source repositories from inside a box.
# jq: inspect JSON responses during debugging.
# less: pager for logs and command output.
# openssh-client: SSH client utilities for git over SSH and remote access.
# procps: ps/top/free process tools used for runtime inspection.
# python3/python3-pip/python3-venv: Python tooling needed by many npm packages and scripts.
# sudo: allow the boxlite user to escalate inside this disposable runtime image.
# tzdata: UTC timezone data so tools report consistent timestamps.
# unzip/wget/zip: common archive and download utilities for setup workflows.
# The same RUN configures UTC, enables Corepack, creates the runtime user, scopes sudo, and removes apt metadata.
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
  && corepack enable \
  && useradd --create-home --shell /bin/bash boxlite \
  && echo 'boxlite ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/boxlite \
  && chmod 0440 /etc/sudoers.d/boxlite \
  && rm -rf /var/lib/apt/lists/*

# Create the default workspace for user and agent workloads.
RUN mkdir -p /workspace && chown boxlite:boxlite /workspace

# Users and agent commands start in /workspace.
WORKDIR /workspace
# Run workloads as an unprivileged user by default; sudo remains available when needed.
USER boxlite
# Keep the box alive when the runner does not override the image command.
CMD ["sleep", "infinity"]
