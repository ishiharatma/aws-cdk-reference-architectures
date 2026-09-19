# syntax=docker/dockerfile:1
#
# MicroVM image for the "Serverless Codex App Server" reference architecture.
#
# AWS Lambda MicroVMs builds this Dockerfile inside a clean build MicroVM,
# runs the image-build hooks (hooks/ready.sh, then hooks/validate.sh), and
# once both succeed takes a Firecracker snapshot of the running memory +
# disk state. Every `RunMicrovm` call afterwards resumes a fresh MicroVM
# from that snapshot (running hooks/run.sh, hooks/suspend.sh,
# hooks/resume.sh and hooks/terminate.sh over its lifecycle) instead of
# booting cold, so `codex app-server` is already initialized and listening
# by the time a session is handed to a client.
#
# NOTE: the base image tag below is a placeholder. Pin it to the OS/runtime
# your Lambda MicroVMs "base image" (baseImageArn/baseImageVersion in
# CfnMicrovmImage) requires -- see README.md "MicroVM base image" section.
FROM node:22-bookworm-slim

# The OpenAI Codex CLI ships the `codex` binary, including the
# `codex app-server` sub-command (JSON-RPC over stdio / WebSocket / Unix
# socket -- see https://github.com/openai/codex).
RUN npm install --global @openai/codex@0.155.1 @aws-sdk/client-secrets-manager@3 \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/codex-app-server

COPY hooks/ /opt/hooks/
RUN chmod +x /opt/hooks/*.sh

# Port the `run` hook binds the app-server's WebSocket transport to. Must
# match `hooks.port` in the CfnMicrovmImage definition (see
# lib/stacks/lambda-microvms-codex-appserver-stack.ts).
ENV CODEX_APP_SERVER_PORT=8080
ENV CODEX_HOME=/opt/codex-app-server/.codex

# ARN of the Secrets Manager secret holding the OpenAI API key. Set as a
# fixed CfnMicrovmImage.environmentVariables entry by the stack (same value
# for every session); the MicroVM's execution role is granted
# secretsmanager:GetSecretValue on exactly this ARN. See hooks/run.sh.
ENV OPENAI_API_KEY_SECRET_ARN=""

ENTRYPOINT ["/bin/sh"]
