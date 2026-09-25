# DynamoDB Native Vector Search — Gotchas Worth Knowing

Verified while building and deploy-verifying `dynamodb-vector-search-semantic-api`
(ap-northeast-1, aws-cdk-lib 2.270, AWS CLI 2.36, September 2026, Titan Text Embeddings V2
at 256 dimensions).

## CloudFormation accepts `VectorIndexes`, but the L2 `Table` has no property for it

`aws cloudformation describe-type --type-name AWS::DynamoDB::Table` did not list a
`VectorIndexes` property in the registry schema, and `aws-cdk-lib`'s `dynamodb.Table` /
`CfnTable` typings have no such field. A throw-away stack with the property still reached
`CREATE_COMPLETE` and `aws dynamodb describe-table` showed the index as `ACTIVE`. Do not
conclude "unsupported" from the schema; probe with a tiny stack. In CDK use the escape hatch:

```typescript
const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
cfnTable.addPropertyOverride('VectorIndexes', [{
  IndexName: 'embedding-idx',
  VectorAttribute: { AttributeName: 'embedding' },
  Dimensions: 256,
  DistanceFunction: 'COSINE',            // COSINE | EUCLIDEAN | DOT_PRODUCT
  SearchSchema: [{ AttributeName: 'category', SearchSchemaElementType: 'INLINE_FILTER' }],
  Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['title', 'category'] },
}]);
```

## Every `SearchSchema` attribute must be in `AttributeDefinitions`

`CreateTable` fails with `One element in SearchSchema is not defined in attribute definitions`
otherwise. The L2 construct only emits key/GSI attributes, so override the whole list:
`cfnTable.addPropertyOverride('AttributeDefinitions', [{ docId, S }, { category, S }])`.
Vector indexes also require an on-demand (`PAY_PER_REQUEST`) table.

## `SearchVectors` request shape

- `--search-vector` / `SearchVector` is a **list of `{N: "..."}` values, not `{L: [...]}`**.
  Wrapping it in `L` fails with `Search vector contains invalid values. All values in the search
  vector must be a 32-bit floating-point number attribute`, which reads like a value problem.
- The stored attribute is a plain DynamoDB list of numbers (`L` of `N`); pass `Math.fround(v)`
  values.
- IAM: `dynamodb:SearchVectors` on the **index ARN** (`table/<name>/index/<index>`) is enough.
- `INLINE_FILTER` attributes are applied inside the vector search (`--search-condition-expression
  '#c = :c'`), so top-k stays exact under a filter instead of being post-filtered.
- COSINE `Score` is a distance (0 identical … 2 opposite); an identical vector returned
  `2.98e-08`.

## A vector written by `PutItem` was not searchable; rewriting it with `UpdateItem` fixed it

Observed repeatedly on a 256-dimension index (a 3-dimension index behaved correctly): an item
created by a single `PutItem` that already contained the vector was **not returned for its own
vector** (or returned with a distance near 1) even minutes later. Re-issuing
`UpdateItem SET embedding = :v` with the same vector made it immediately return at distance ~0.
Items created without the vector and given it by a later `UpdateItem` always worked. Cause not
identified (not a lag: polled for 3 minutes). Practical rule: write the vector with `UpdateItem`
(as the Streams -> embed Lambda pipeline does) and verify a new index with a **self-query** (the
stored vector must come back at distance ~0) before trusting it.

## Lambda event filters: `exists: false` only works on leaf nodes

Stream records carry the vector in `NewImage.embedding` as `{"L": [...]}`. A filter
`{"dynamodb":{"NewImage":{"embedding":[{"exists":false}]}}}` matched **every** record,
including the function's own write-back `MODIFY`, so each document was embedded twice (the
conditional update masked it). Filter on a scalar leaf instead:
`NewImage: { embeddedAt: { S: FilterRule.notExists() } }`. Confirmed by counting the function's
`embedded`/`skipped` log lines before and after (20 + 10 -> 10 + 0 for 10 documents).

## Metering fields

`--return-consumed-capacity INDEXES` reports `VectorIndexes.<index>.VectorWriteRequestBytes` on
writes (1,061 bytes for one 256-dimension vector) and `VectorSearchRequestBytes` on
`SearchVectors` (6,914 bytes for a top-5 search on a tiny table). Use them to size cost from real
traffic rather than guessing.
