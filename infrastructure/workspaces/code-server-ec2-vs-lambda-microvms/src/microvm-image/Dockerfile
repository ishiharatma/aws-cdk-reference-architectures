# syntax=docker/dockerfile:1
#
# code-server MicroVM image. Lambda MicroVMs builds this in a build MicroVM, starts it, POSTs
# /aws/lambda-microvms/runtime/v1/ready until it returns 200, then snapshots memory + disk.
# Every RunMicrovm resumes from that snapshot; code-server itself is started by the /run hook
# (server/index.mjs) so the password is fetched per MicroVM and never baked into the snapshot.
FROM node:22-bookworm-slim

ARG TARGETARCH
ARG CODE_SERVER_VERSION=4.141.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git procps openssh-client unzip less \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}.tar.gz" \
      -o /tmp/code-server.tgz \
    && mkdir -p /opt/code-server \
    && tar -xzf /tmp/code-server.tgz -C /opt/code-server --strip-components=1 \
    && rm /tmp/code-server.tgz

# AWS CLI v2 (the EC2 variant gets it from Amazon Linux 2023). It picks up the MicroVM execution
# role's credentials automatically; the role only grants what the stack gives it.
RUN case "${TARGETARCH}" in arm64) A=aarch64 ;; *) A=x86_64 ;; esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${A}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip

# Claude Code CLI; the VS Code extension is installed below as the runtime user. Bedrock settings
# arrive as image environment variables (CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_MODEL, ...).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /opt/launcher
COPY package.json ./
RUN npm install --omit=dev
COPY server/ ./server/

RUN mkdir -p /home/node/project && chown -R node:node /home/node /opt/launcher
USER node
RUN HOME=/home/node /opt/code-server/bin/code-server --install-extension Anthropic.claude-code
ENV HOME=/home/node
# Public port (lifecycle hooks + reverse proxy) -- must equal Hooks.port in the stack.
# Not named PORT: code-server reads $PORT and would bind to it, overriding --bind-addr.
ENV LAUNCHER_PORT=8080
ENV CODE_SERVER_PORT=8081
ENV PASSWORD_SECRET_ARN=""

ENTRYPOINT ["node", "server/index.mjs"]
