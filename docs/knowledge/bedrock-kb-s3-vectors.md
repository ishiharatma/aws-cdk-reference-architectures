# Bedrock Knowledge Bases on S3 Vectors — Gotchas Worth Knowing

Verified while deploy-verifying `bedrock-kb-rag-s3-vectors` (ap-northeast-1, aws-cdk-lib 2.270, October 2026).

## S3 Vectors is available in Tokyo and has L1 constructs

`aws-cdk-lib/aws-s3vectors` provides `CfnVectorBucket` and `CfnIndex`; `CfnKnowledgeBase` takes
`storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: { indexArn } }`. A stack with the vector
bucket, index, knowledge base, data source, HTTP API and Lambda deployed in about 2 minutes and destroyed cleanly.

## Declare Bedrock's chunk-text keys as non-filterable on the index

S3 Vectors allows 2 KB of filterable metadata per vector. Bedrock writes the chunk text and its metadata next to the
vector as `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA`. Put both in the index's
`metadataConfiguration.nonFilterableMetadataKeys`; otherwise a chunk over 2 KB fails ingestion. Document metadata
supplied in `<file>.metadata.json` (`{"metadataAttributes": {...}}`) stays filterable and works with an `equals` filter.

## Index dimension and knowledge base dimension must match

Titan Text Embeddings V2 supports 256, 512 and 1024. Set the same value in the index (`dimension`) and in the
knowledge base (`bedrockEmbeddingModelConfiguration.dimensions`, `embeddingDataType: FLOAT32`).

## A document shorter than the chunk size is one chunk

Six documents under 300 tokens produced 6 vectors, so chunking parameters make no visible difference on a small
sample. Judge chunk size with `Retrieve` on real documents.

## The filter is caller-supplied, so it is not access control

`retrievalConfiguration.vectorSearchConfiguration.filter` restricts retrieval to matching metadata, but if the
caller chooses it, the caller can omit it. Derive it from the caller's identity when documents must be separated.

## `RetrieveAndGenerate` needs permissions on the profile and on the model behind it

For a cross-Region inference profile (`jp.anthropic.claude-sonnet-4-6`) the function role needs `bedrock:InvokeModel`
and `bedrock:GetInferenceProfile` on the inference-profile ARN and `bedrock:InvokeModel` on the foundation-model ARN in
each Region the profile may route to (`arn:aws:bedrock:*::foundation-model/<id>`), plus `bedrock:RetrieveAndGenerate`
(no resource-level scope) and `bedrock:Retrieve` on the knowledge base.

## SigV4 with curl against an HTTP API

`curl --aws-sigv4 "aws:amz:<region>:execute-api" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -H "x-amz-security-token: $AWS_SESSION_TOKEN"`
works for an HTTP API with the IAM authorizer (curl 7.75+); credentials from SSO come from
`aws configure export-credentials --format env`. An unsigned request is `403`.
