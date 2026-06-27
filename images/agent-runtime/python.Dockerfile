# Python slim provides Python 3.12 while keeping the image smaller than full Debian.
FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b

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
# sudo: allow the boxlite user to escalate inside this disposable runtime image.
# tzdata: UTC timezone data so tools report consistent timestamps.
# unzip/wget/zip: common archive and download utilities for setup workflows.
# The same RUN configures UTC, installs pinned Python packaging tools, creates the runtime user, scopes sudo,
# and removes apt metadata.
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
    sudo \
    tzdata \
    unzip \
    wget \
    zip \
  && ln -fs /usr/share/zoneinfo/$TZ /etc/localtime \
  && dpkg-reconfigure -f noninteractive tzdata \
  && python -m pip install --no-cache-dir pip==25.3 setuptools==80.9.0 wheel==0.45.1 \
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
