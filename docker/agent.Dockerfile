FROM public.ecr.aws/ubuntu/ubuntu:noble

RUN apt-get update && apt-get install -y
RUN apt-get install -y curl wget

# Robust downloader for install scripts. External endpoints (raw.githubusercontent.com,
# astral.sh, cli.kiro.dev) intermittently throttle build egress IPs and return an HTTP 200
# body containing a rate-limit/ToS notice instead of the script. Piping that straight into
# bash/sh produces a syntax error and fails the build. This helper retries with backoff and
# then VALIDATES the payload (non-trivial size + shell shebang) before it is executed, so a
# throttled/garbage response fails loudly at download time rather than being run.
# Written with printf (not a heredoc) so it parses on both the classic Docker builder
# and BuildKit — a `RUN <<EOF` heredoc requires BuildKit and would fail on a classic build.
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'u="$1"; o="$2"; n=0; d=3' \
  'while :; do' \
  '  n=$((n + 1))' \
  '  if curl -fsSL --connect-timeout 10 --max-time 120 "$u" -o "$o" && [ "$(wc -c < "$o")" -ge 512 ] && head -c 2 "$o" | grep -q "#!"; then' \
  '    echo "fetch-script: OK $u ($(wc -c < "$o") bytes)"; exit 0' \
  '  fi' \
  '  echo "fetch-script: invalid or failed payload from $u (attempt $n/5)" >&2' \
  '  if [ "$n" -ge 5 ]; then echo "fetch-script: giving up on $u" >&2; exit 1; fi' \
  '  sleep "$d"; d=$((d * 2))' \
  'done' \
  > /usr/local/bin/fetch-script && chmod +x /usr/local/bin/fetch-script

RUN fetch-script https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh /tmp/nvm-install.sh && bash /tmp/nvm-install.sh && rm -f /tmp/nvm-install.sh
ENV NODE_VERSION=22.18.0
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION} && nvm use v${NODE_VERSION} && nvm alias default v${NODE_VERSION}
ENV PATH="/root/.local/bin/:/root/.nvm/versions/node/v${NODE_VERSION}/bin/:${PATH}"

# install python
RUN apt-get update && \
  apt-get install -y python3-pip unzip && \
  ln -s -f /usr/bin/pip3 /usr/bin/pip && \
  ln -s -f /usr/bin/python3 /usr/bin/python

# install uv
RUN fetch-script https://astral.sh/uv/install.sh /tmp/uv-install.sh && sh /tmp/uv-install.sh && rm -f /tmp/uv-install.sh

# install aws cli
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" && \
  unzip awscliv2.zip && rm -f awscliv2.zip && \
  ./aws/install

# Install GitHub CLI https://github.com/cli/cli/blob/trunk/docs/install_linux.md
RUN (type -p wget >/dev/null || (apt update && apt-get install wget -y)) && \
  mkdir -p -m 755 /etc/apt/keyrings && \
  out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg && \
  cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
  apt-get update && \
  apt-get install gh -y

# install gh-token
RUN git config --global user.name "remote-swe-app[bot]" && \
  git config --global user.email "123456+remote-swe-app[bot]@users.noreply.github.com"
RUN curl -L "https://github.com/Link-/gh-token/releases/download/v2.0.5/linux-arm64" -o gh-token && \
  chmod +x gh-token && \
  mv gh-token /usr/bin

# Install Kiro CLI
RUN fetch-script https://cli.kiro.dev/install /tmp/kiro-install.sh && bash /tmp/kiro-install.sh && rm -f /tmp/kiro-install.sh

# Install Bun (required for kiro-cli hook scripts from skills like aidlc-workflows)
# Pinned to 1.3.14, fetched from GitHub Releases to avoid Docker Hub rate limits
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip" -o /tmp/bun.zip && \
  echo "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b  /tmp/bun.zip" | sha256sum -c - && \
  unzip -o /tmp/bun.zip -d /tmp/bun-extract && \
  mv /tmp/bun-extract/bun-linux-aarch64/bun /usr/local/bin/bun && \
  chmod +x /usr/local/bin/bun && \
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
  rm -rf /tmp/bun.zip /tmp/bun-extract
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app
COPY package*.json ./
COPY packages/agent-core/package*.json ./packages/agent-core/
COPY packages/worker/package*.json ./packages/worker/
RUN npm ci
COPY ./ ./
RUN cd packages/agent-core && npm run build

# Generate build-time version marker for deployment verification.
# The timestamp correlates with the ECR image push time and confirms
# which code revision is running when checked via CloudWatch logs.
ARG BUILD_HASH=unknown
RUN echo "build-$(date -u +%Y%m%dT%H%M%SZ)-${BUILD_HASH}" > /app/packages/worker/.build-version

WORKDIR /app/packages/worker
EXPOSE 8080
CMD ["./run.sh"]
