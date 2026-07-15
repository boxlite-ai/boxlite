# Debian slim keeps the base image small while still supporting apt-managed tools.
FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

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
# sudo: allow the boxlite user to escalate inside this disposable runtime image.
# tzdata: UTC timezone data so tools report consistent timestamps.
# unzip/wget/zip: common archive and download utilities for setup workflows.
# The same RUN configures UTC, creates the runtime user, scopes sudo, and removes apt metadata to keep the image small.
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
