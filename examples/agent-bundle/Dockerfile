# Agent bundle: 10 terminal coding agents in one image, on the boxlite Node base.
# Base already ships Node 22 + npm + python3/pip + git/curl. Boxes run as the
# unprivileged `boxlite` user, so each agent is installed the way it will be run:
#   - npm CLIs: installed as root into the system prefix (/usr/local), run by anyone
#   - native CLIs: installed AS `boxlite` into that user's own ~/.local (their
#     per-user, non-root install path) — no root-owned payloads, no relocation.
FROM ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0

# --- npm-based agent CLIs (system-wide; -g needs root for the /usr/local prefix) ---
USER root
RUN set -eux; \
    for pkg in \
      "@anthropic-ai/claude-code" \
      "@openai/codex" \
      "@google/gemini-cli" \
      "@github/copilot" \
      "opencode-ai" \
      "@botiverse/raft@latest" \
      "@moonshot-ai/kimi-code" \
      "@mariozechner/pi-coding-agent"; do \
      npm install -g --no-fund --no-audit "$pkg"; \
    done; \
    npm cache clean --force; rm -rf /root/.npm /tmp/* /var/tmp/*; \
    # slim node_modules of dev-only weight (source maps, docs, tests, changelogs)
    cd /usr/local/lib/node_modules; \
    find . -type d \( -iname test -o -iname tests -o -iname __tests__ \
        -o -iname docs -o -iname example -o -iname examples -o -iname .github \) \
        -prune -exec rm -rf {} + ; \
    find . -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \
        -o -name 'CHANGELOG*' -o -name '.npmignore' -o -name '.editorconfig' \) -delete

# --- native-binary agents: installed as the box user, into its own ~/.local ----
USER boxlite
ENV HOME=/home/boxlite
ENV PATH=/home/boxlite/.local/bin:$PATH
RUN set -eux; \
    curl -fsS  https://cursor.com/install                | bash; \
    curl -fsSL https://antigravity.google/cli/install.sh | bash

# --- smoke check: every agent CLI resolves on PATH as the box user ------------
RUN set -eu; for c in claude codex gemini copilot opencode raft kimi pi cursor-agent agy; do \
      command -v "$c" >/dev/null || { echo "MISSING: $c"; exit 1; }; \
    done; echo "all 10 agent CLIs present"
