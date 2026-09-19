// CDK bakes a content-derived SHA256 hex digest into the S3 key of every
// bundled asset (Lambda code, Docker images, zipped file assets such as a
// CodeCommit seed). Editing any file inside that asset's source directory
// changes the digest and therefore the key, which breaks a plain
// `toMatchSnapshot()` on the synthesized template even though nothing about
// the stack's logical shape changed. Strip the digest out before comparing.
const ASSET_HASH_PATTERN = /[0-9a-f]{64}(?=\.(?:zip|json))/g;
const ASSET_HASH_PLACEHOLDER = '0'.repeat(64);

export function normalizeAssetHashes<T>(template: T): T {
  const json = JSON.stringify(template);
  const normalized = json.replace(ASSET_HASH_PATTERN, ASSET_HASH_PLACEHOLDER);
  return JSON.parse(normalized) as T;
}
