#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (remote) environments.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"

# Install Deno if it isn't already present (idempotent).
if ! command -v deno >/dev/null 2>&1; then
  curl -fsSL https://deno.land/install.sh | sh -s -- -y
fi

# Persist Deno on PATH for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export DENO_INSTALL=\"$DENO_INSTALL\"" >> "$CLAUDE_ENV_FILE"
  echo "export PATH=\"$DENO_INSTALL/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# Install project dependencies and configure git hooks.
deno install
git config core.hooksPath .githooks
