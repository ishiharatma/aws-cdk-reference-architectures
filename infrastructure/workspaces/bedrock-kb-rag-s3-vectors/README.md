# Bedrock Knowledge Base RAG on Amazon S3 Vectors - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

A **retrieval-augmented generation (RAG)** question-answering API on **Amazon Bedrock Knowledge Bases**, with **Amazon S3 Vectors** as the vector store. Documents in S3 are chunked and embedded by an ingestion job; a SigV4-signed HTTP API answers questions with **citations**, can **filter by a metadata attribute**, keeps a **conversation** through a session ID, and exposes **retrieval alone** so you can inspect and tune what the model is shown. It is the managed-RAG counterpart of [`dynamodb-vector-search-semantic-api`](../dynamodb-vector-search-semantic-api/), where you build the embedding pipeline yourself.

| Endpoint | Does |
|---|---|
| `POST /ask` | `RetrieveAndGenerate`: retrieves the best chunks, asks Claude to answer from them, returns the answer, the cited chunks and a `sessionId` |
| `POST /search` | `Retrieve`: returns the chunks with scores and metadata, without generation |

Request body: `{"question": "...", "filter": "finance", "sessionId": "...", "maxResults": 4}` (only `question` is required).

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Well-Architected Alignment](#️-well-architected-alignment)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Operational Check Script](#-operational-check-script)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **Data bucket** — private, TLS-only S3 bucket for the source documents. `sample-docs/` holds six short policy documents of a fictional company, each with a `.metadata.json` file that sets `department`.
- **S3 Vectors bucket and index** — float32, cosine, 1024 dimensions. The two keys Bedrock writes next to each vector (`AMAZON_BEDROCK_TEXT`, `AMAZON_BEDROCK_METADATA`) are declared **non-filterable**.
- **Knowledge base** — Titan Text Embeddings V2 (1024 dimensions), `S3_VECTORS` storage, and a service role assumable by Bedrock for this account's knowledge bases only.
- **Data source** — the data bucket, fixed-size chunking (300 tokens, 20% overlap by default), indexed data deleted with the data source in development.
- **HTTP API and Lambda** (Node.js 24, ARM64) — IAM authorization on both routes, stage throttling, access logs. The function validates input, calls the knowledge base and shapes the response.
- **`test-rag.sh`** — ingests the sample documents and asks questions through the signed API.

## 🎯 Design Decisions & Best Practices

### 1. S3 Vectors as the vector store

OpenSearch Serverless needs a collection with a minimum capacity that is billed while idle. S3 Vectors bills storage, requests and queried data, so a reference or a small workload costs almost nothing when nobody asks questions. The trade-offs are fewer features (no hybrid keyword search, a smaller filter language, a metadata size limit) and higher query latency than an in-memory index. For a knowledge base of internal documents queried a few times a minute, that is a good deal.

### 2. Make the chunk text non-filterable, or longer chunks fail

S3 Vectors allows 2 KB of **filterable** metadata per vector. Bedrock stores the chunk text and its own metadata in `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA`. If they count as filterable, any chunk larger than 2 KB breaks ingestion. The index declares both as `nonFilterableMetadataKeys`. Your own document metadata (here `department`) stays filterable.

### 3. Metadata filtering is access control you must enforce, not a UI feature

Each document carries `department`. The API turns `filter` into an `equals` filter on the retrieval, so a filtered question never sees other departments' chunks: the check script asks a finance question with `filter=infrastructure`, gets only infrastructure chunks from `/search`, and the finance answer is not produced. The filter is, however, **caller-supplied**. Anyone who may call the API can omit it. If departments must not read each other's documents, derive the filter from the caller's identity (for example a Cognito group claim or the IAM principal) instead of accepting it from the request body.

### 4. Citations and a retrieval-only endpoint

`/ask` returns the chunks the answer was built from, with their S3 source. `/search` returns chunks with scores and no generation. When an answer is wrong, call `/search` first: if the right chunk is not in the results the problem is chunking, embedding or filtering; if it is, the problem is the prompt or the model.

### 5. The model is told to answer from the documents, and says so when it cannot

An out-of-corpus question ("What is the password of the office guest Wi-Fi?") is declined ("I could not find an answer... the search results do not contain any information"). The default knowledge base prompt does this; the check script asserts it. For stricter control add a Bedrock Guardrail with contextual grounding checks.

### 6. Conversation through the session ID

`/ask` returns a `sessionId`. Sending it back lets the follow-up "And what if it is 300,000 JPY?" resolve "it" to the refund from the previous turn. Bedrock keeps the session; the API stays stateless.

### 7. The API role can read but not manage

The function may `Retrieve`, `RetrieveAndGenerate` and invoke the one generation model and its inference profile. It cannot start ingestion, change the knowledge base or touch S3; a test asserts it. Ingestion is an operator action (`test-rag.sh` or `aws bedrock-agent start-ingestion-job`).

### 8. A cross-Region inference profile for the model

The generation model is invoked through the `jp.` inference profile, which routes within Japan. The invoke permission covers the profile and the underlying foundation model in every Region it may route to.

### 9. Chunking is a parameter, but the sample is too small to show it

`chunking.maxTokens` and `overlapPercentage` control how documents are split. Every sample document is shorter than 300 tokens, so each becomes one chunk (6 vectors in total); chunking becomes visible with real documents. Smaller chunks retrieve more precisely and cost more vectors; larger chunks carry more context. Measure with `/search` on your own questions.

### 10. Environment-specific parameters

`parameters/<env>-params.ts` sets the embedding model and its dimension, the generation inference profile, chunking, the number of retrieved chunks, the filter attribute and the throttling.

## 🏛️ Well-Architected Alignment

| Pillar | How this architecture addresses it |
|---|---|
| Operational Excellence | `test-rag.sh` verifies ingestion and answer quality end to end; `/search` makes retrieval inspectable; CloudFormation-managed |
| Security | IAM (SigV4) authorization, least-privilege function role, a service role scoped to this account and its knowledge bases, private TLS-only bucket, validated input |
| Reliability | Managed ingestion, vector store and model; bounded input (question length, result count); throttled stage |
| Performance Efficiency | A retrieval of about 0.5 s and an answer of about 1.8 s were measured; the result count and chunk size are parameters |
| Cost Optimization | No idle vector cluster; pay per request and per token (see below) |
| Sustainability | Serverless components that cost and consume nothing while idle |

## 💰 Cost Optimization

Approximate costs in `ap-northeast-1` (verify against the pricing pages):

| Item | Approx. |
|---|---|
| S3 Vectors | Storage, put and query charges; cents for a few thousand vectors |
| Titan Text Embeddings V2 | Per input token at ingestion and per query; a fraction of a cent for the sample |
| Claude Sonnet 4.6 | Per input and output token for each `/ask`; a few cents per hundred questions at this context size |
| HTTP API, Lambda, logs | Per request; negligible for testing |

A verification run of about 30 minutes cost cents. There is no always-on component, which is the point of choosing S3 Vectors over OpenSearch Serverless for this workload.

## 🔒 Security Considerations

### Implemented

- Both routes require IAM (SigV4) authorization; an unsigned request is refused with 403.
- The function role can retrieve, answer and invoke one generation model; no ingestion, no S3, no knowledge-base changes.
- The service role is assumable by `bedrock.amazonaws.com` for this account and its knowledge bases only, and reads the data bucket under an `aws:ResourceAccount` condition.
- Input is validated: question length, result count, a plain-value filter, string session ID.
- The data bucket is private, TLS-only and encrypted; the stage is throttled.

### CDK Nag suppressions (with reasons)

| Rule | Reason |
|---|---|
| AwsSolutions-S1 | The data bucket holds a reference's source documents; server access logs would need another bucket |
| AwsSolutions-IAM4 | AWS-managed policies for Lambda logging and the S3 auto-delete provider |
| AwsSolutions-IAM5 | `bedrock:RetrieveAndGenerate` has no resource-level scope; the object wildcard is the bucket's documents; the model wildcard is the Regions an inference profile routes to |
| AwsSolutions-L1 | Latest supported Node.js at authoring time; the auto-delete provider is managed by CDK |
| AwsSolutions-APIG1 / APIG4 | Access logging and IAM authorization are in place; the rules do not recognise the HTTP API v2 form |

### Out of scope (add per environment)

Deriving the filter from the caller's identity (see design decision 3), a Bedrock Guardrail, a WAF, a custom domain, encryption of the vector bucket with a customer managed key, and a scheduled ingestion for changing documents.

## 📋 Prerequisites

- Node.js 24+, AWS CDK v2, an AWS account with CDK bootstrapped
- Model access in the Region for Titan Text Embeddings V2 and the generation model (`aws bedrock-runtime converse` with the inference profile ID is a quick test)
- Amazon S3 Vectors available in the Region
- `aws`, `curl` (7.75+ for `--aws-sigv4`) and `jq` for `test-rag.sh`

## 🚀 Deployment Guide

```bash
export PROJECT=<project> ENV=dev
npm install
npm run stage:deploy:all -w workspaces/bedrock-kb-rag-s3-vectors   # about 2 minutes
./workspaces/bedrock-kb-rag-s3-vectors/test-rag.sh --project $PROJECT --env $ENV   # ingests the sample documents and asks questions
```

The documents are not part of the stack: `test-rag.sh` (or your own pipeline) uploads them and starts the ingestion job.

## 🧪 Operational Check Script

`./test-rag.sh --project <project> --env <env>` syncs `sample-docs/`, runs the ingestion job (6 documents scanned and indexed, 0 failed) and then checks, through the signed API:

1. six questions whose answers are stated in exactly one document: the answer contains the fact and the citations include that document
2. an out-of-corpus question is declined
3. `filter=infrastructure` returns only infrastructure chunks from `/search`, and a finance question with that filter is not answered
4. `/search` ranks the right document first and returns scores
5. a follow-up question with the session ID resolves "it" from the previous turn
6. an empty question and a filter containing a quote are rejected with 400, and an unsigned request is refused

Verified on 2026-10-10 in `ap-northeast-1`: all checks passed. Measured: `/search` about 0.5 s, `/ask` about 1.8 s per request.

## 🧪 Testing Strategy

```bash
npm test -w workspaces/bedrock-kb-rag-s3-vectors
```

- **Snapshot**: the full template and resource counts.
- **Unit**: the S3 Vectors index (type, dimension, metric, non-filterable keys), dimension agreement between index and knowledge base, chunking from the parameters, data deletion policy per environment, the service role's trust and permissions, IAM authorization and throttling on the API, the function role's permissions (and what it lacks), and the request handling against a fake Bedrock client (validation, the filter, sessions, citations, retrieval-only).
- **Compliance**: CDK Nag `AwsSolutionsChecks` with the reasons above.

## ⚙️ Customization

| Parameter | Meaning |
|---|---|
| `embeddingModelId`, `vectorDimension` | The embedding model and its output size; changing them needs a new index |
| `generationInferenceProfileId`, `generationFoundationModelId` | The answering model |
| `chunking.maxTokens`, `chunking.overlapPercentage` | Chunk size and overlap |
| `numberOfResults` | Chunks retrieved per question |
| `filterAttribute` | The metadata attribute the API may filter on |
| `apiRateLimit`, `apiBurstLimit` | Stage throttling |

To use your own documents, put them (with `.metadata.json` files for any attribute you filter on) in the data bucket and start an ingestion job.

## 🔧 Troubleshooting

### Ingestion fails on longer chunks

The chunk text or Bedrock metadata is counted as filterable. Declare `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` as non-filterable on the index (the stack does).

### `/ask` returns 502

The function logged the underlying error. Common causes: no model access for the inference profile in this account (`converse` with the profile ID shows it), or an ingestion that has not run yet.

### `AccessDeniedException` on the generation model

A model can be listed as active yet not available to an account. Test it with `aws bedrock-runtime converse` before deploying, and set `generationInferenceProfileId` to one that works.

### The answer ignores the filter

The filter works only on attributes that exist in the `.metadata.json` of the ingested documents. Re-run ingestion after adding or changing metadata.

### `curl: option --aws-sigv4: is unknown`

Use curl 7.75 or later, or sign requests with `awscurl` or an AWS SDK.

## 🧹 Clean-up

```bash
npm run stage:destroy:all -w workspaces/bedrock-kb-rag-s3-vectors
```

The data source deletes its vectors with it in development; the data bucket is emptied automatically.

## 📚 References

- [Amazon S3 Vectors](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html)
- [Use S3 Vectors with Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html)
- [Retrieve data and generate AI responses with Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)
- [Include metadata in a data source to improve knowledge base queries](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-metadata.html)
- [How content chunking works for knowledge bases](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking.html)
