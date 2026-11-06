# syntax=docker/dockerfile:1
#
# code-server MicroVM image. Lambda MicroVMs builds this in a build MicroVM, starts it, POSTs
# /aws/lambda-microvms/runtime/v1/ready until it returns 200, then snapshots memory + disk.
# Every RunMicrovm resumes from that snapshot; code-server itself is started by the /run hook.
FROM node:22-bookworm-slim

ARG TARGETARCH
ARG CODE_SERVER_VERSION=4.141.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git procps openssh-client unzip less python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}.tar.gz" \
      -o /tmp/code-server.tgz \
    && mkdir -p /opt/code-server \
    && tar -xzf /tmp/code-server.tgz -C /opt/code-server --strip-components=1 \
    && rm /tmp/code-server.tgz

# AWS CLI v2: Git's credential helper for CodeCommit, using the MicroVM execution role.
RUN case "${TARGETARCH}" in arm64) A=aarch64 ;; *) A=x86_64 ;; esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${A}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip

# Claude Code CLI; the VS Code extension is installed below as the runtime user. Bedrock settings
# arrive as image environment variables (CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_MODEL, ...).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /opt/launcher
COPY server/ ./server/

RUN mkdir -p /home/node/project && chown -R node:node /home/node /opt/launcher
USER node
RUN HOME=/home/node /opt/code-server/bin/code-server --install-extension Anthropic.claude-code
# microvm.extensions, written into the build context by the stack. Sessions may have no route to the
# gallery, so this is the only chance. Checked afterward: a missing extension must fail the build.
COPY extensions.txt /tmp/extensions.txt
RUN while read -r extension; do \
      HOME=/home/node /opt/code-server/bin/code-server --install-extension "$extension" \
        && HOME=/home/node /opt/code-server/bin/code-server --list-extensions | grep -qix "$extension" \
        || { echo "Could not install $extension"; exit 1; }; \
    done < /tmp/extensions.txt
ENV HOME=/home/node
# Scoped to CodeCommit hosts so credentials for other Git hosts stay untouched.
RUN git config --global 'credential.https://git-codecommit.*.amazonaws.com.helper' '!aws codecommit credential-helper $@' \
    && git config --global 'credential.https://git-codecommit.*.amazonaws.com.useHttpPath' true
# Public port (lifecycle hooks + reverse proxy) -- must equal Hooks.port in the stack.
# Not named PORT: code-server reads $PORT and would bind to it, overriding --bind-addr.
ENV LAUNCHER_PORT=8080
ENV CODE_SERVER_PORT=8081

ENTRYPOINT ["node", "server/index.mjs"]
