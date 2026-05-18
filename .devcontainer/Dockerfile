FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install global dev tools
RUN npm install -g typescript@latest vite@latest

WORKDIR /workspace

USER node
