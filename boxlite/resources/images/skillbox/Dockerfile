# SkillBox - AI CLI Container with noVNC Desktop
#
# Provides Claude Code with computer_use tools (screenshot, mouse, keyboard)
# inside a sandboxed desktop environment accessible via noVNC.
#
# Based on linuxserver/webtop (Ubuntu + XFCE desktop + noVNC).
# Runs as user 'abc' with HOME=/config.

FROM lscr.io/linuxserver/webtop:ubuntu-xfce

# === ROOT OPERATIONS ===

# Configurable APT mirror (use --build-arg APT_SOURCE=mirrors.aliyun.com for China)
ARG APT_SOURCE=
RUN if [ -n "${APT_SOURCE}" ]; then \
        find /etc/apt -name "*.sources" -o -name "sources.list" 2>/dev/null | xargs -I{} sed -i "s|ports.ubuntu.com/ubuntu-ports|${APT_SOURCE}/ubuntu-ports|g" {} 2>/dev/null || true; \
        find /etc/apt -name "*.sources" -o -name "sources.list" 2>/dev/null | xargs -I{} sed -i "s|archive.ubuntu.com/ubuntu|${APT_SOURCE}/ubuntu|g" {} 2>/dev/null || true; \
        find /etc/apt -name "*.sources" -o -name "sources.list" 2>/dev/null | xargs -I{} sed -i "s|security.ubuntu.com/ubuntu|${APT_SOURCE}/ubuntu|g" {} 2>/dev/null || true; \
    fi

# Install Node.js 20.x and screen capture tools, then purge build-only deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    scrot \
    xdotool \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# Prepare user directories (webtop creates /config at runtime)
RUN mkdir -p /config/.local/bin \
    && chown -R abc:abc /config

# === SWITCH TO ABC USER ===
USER abc

ENV PATH="/config/.local/bin:$PATH"
ENV HOME="/config"

# Install MCP server dependencies + Claude Code CLI + cleanup in one layer
RUN pip3 install --user --no-cache-dir mcp anyio \
    && curl -fsSL https://claude.ai/install.sh | bash \
    && rm -rf /config/.cache /config/.npm

# Switch back to root for final setup
# IMPORTANT: s6-overlay /init must run as root to create SSL certs, configure nginx, etc.
# It drops privileges to 'abc' for actual services via s6-setuidgid.
USER root

# Copy MCP server and create config
COPY --chown=abc:abc local_computer_mcp.py /config/.local/bin/local_computer_mcp.py
RUN chmod +x /config/.local/bin/local_computer_mcp.py \
    && echo '{"mcpServers":{"computer":{"command":"python3","args":["/config/.local/bin/local_computer_mcp.py"]}}}' > /config/.claude.json \
    && chown abc:abc /config/.claude.json

# NOTE: Do NOT add "USER abc" here - s6-overlay needs root for init.

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD /config/.local/bin/claude --version || exit 1
