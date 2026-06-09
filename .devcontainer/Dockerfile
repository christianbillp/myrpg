FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    lsof \
    psmisc \
    && rm -rf /var/lib/apt/lists/*

# Install global dev tools
RUN npm install -g typescript@latest vite@latest

WORKDIR /workspace

# Pre-create the directories that will be mounted as named volumes
# and chown them to `node` BEFORE the volumes are first mounted.
#
# When a Docker named volume is first attached to a path that exists
# in the image, the volume inherits the image directory's content
# AND its ownership / permissions. By creating these as `node:node`
# here, the volumes come up writable by the unprivileged `node` user
# the container actually runs as. Without this step, the volumes
# default to root:root and `npm install` (run via the
# postCreateCommand under `node`) fails with EACCES.
RUN mkdir -p \
      /workspace/node_modules \
      /workspace/client/node_modules \
      /workspace/server/node_modules \
    && chown -R node:node /workspace

USER node

# Install the Claude Code CLI via the official native installer, as `node` so
# the install under ~/.local is owned by the runtime user and can auto-update
# itself at runtime (the npm global package cannot self-update cleanly).
# Install from a small WORKDIR — the installer can hang when the current
# directory is a large tree.
WORKDIR /tmp
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && /home/node/.local/bin/claude --version
ENV PATH="/home/node/.local/bin:${PATH}"

WORKDIR /workspace
