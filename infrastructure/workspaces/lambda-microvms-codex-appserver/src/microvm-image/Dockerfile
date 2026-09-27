# syntax=docker/dockerfile:1
#
# MicroVM image for the "Serverless Codex App Server" reference architecture.
#
# AWS Lambda MicroVMs builds this Dockerfile inside a clean build MicroVM,
# starts the resulting container (server/index.mjs, below), and POSTs to
# /aws/lambda-microvms/runtime/v1/ready until it returns 200 (all lifecycle
# hooks are POST requests under that exact path prefix -- see the AWS Lambda
# MicroVMs Developer Guide's "Lifecycle hooks" OpenAPI spec; a server that
# only answers bare paths like "/ready" gets a silent 404 on every hook call
# and the build just times out). Once ready, Lambda takes a Firecracker
# snapshot of the running memory + disk state. Every later RunMicrovm call
# resumes a fresh MicroVM from that snapshot -- so codex app-server is
# already spawned and this server is already listening by the time a
# session's MicroVM finishes launching; the /run hook (POST, called at that
# point with { microvmId, runHookPayload } as its body) only needs to bind
# the resumed process to its session id.
#
# NOTE: the base image tag below is a placeholder. Pin it to the OS/runtime
# your Lambda MicroVMs "base image" (baseImageArn/baseImageVersion in
# CfnMicrovmImage) requires -- see README.md "MicroVM base image" section.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/codex-app-server

COPY package.json ./
RUN npm install --omit=dev

COPY server/ ./server/

# Port the in-VM HTTP server (server/index.mjs) listens on: it serves both
# the platform's lifecycle hook calls (/ready, /run, /suspend, /resume,
# /terminate) and the application's /rpc endpoint external clients reach
# through the MicroVM's own HTTPS proxy endpoint. Must match
# Hooks.port in the CfnMicrovmImage definition (see
# lib/stacks/lambda-microvms-codex-appserver-stack.ts) and the
# allowedPorts scoped into CreateMicrovmAuthToken.
ENV CODEX_APP_SERVER_PORT=8080
ENV CODEX_HOME=/opt/codex-app-server/.codex
# codex app-server refuses to start if CODEX_HOME doesn't already exist
# ("CODEX_HOME points to ... but that path does not exist") -- confirmed by
# a real image build: the process exited immediately with that error since
# nothing had ever created this directory.
RUN mkdir -p "$CODEX_HOME"

# ARN of the Secrets Manager secret holding the OpenAI API key. Set as a
# fixed CfnMicrovmImage.environmentVariables entry by the stack (same value
# for every session); the MicroVM's execution role is granted
# secretsmanager:GetSecretValue on exactly this ARN. See server/secret.mjs.
ENV OPENAI_API_KEY_SECRET_ARN=""

# Name of the DynamoDB table the in-VM Event Handler writes codex
# app-server's JSON-RPC output to. Also a fixed environmentVariables entry;
# the execution role is granted dynamodb:PutItem on exactly this table. See
# server/event-handler.mjs.
ENV EVENTS_TABLE_NAME=""

ENTRYPOINT ["node", "server/index.mjs"]
