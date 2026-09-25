/**
 * Values the check script flips (via a CodeCommit commit) to prove two different behaviours:
 *
 *  - APP_VERSION            changes the *application* -> the pipeline deploys it (Dev, then Prod after approval).
 *  - ENABLE_SECURITY_CHECK  changes the *pipeline itself* -> the UpdatePipeline stage self-mutates the pipeline.
 */
export const APP_VERSION = '1.0.0';
export const ENABLE_SECURITY_CHECK = false;

/** Branch the pipeline watches. */
export const SOURCE_BRANCH = 'main';
