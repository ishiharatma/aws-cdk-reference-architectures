import { SharedParams } from 'lib/types';

/**
 * Parameters shared across every environment (dev/stg/prd).
 *
 * The CodeCommit account ID conceptually belongs here (it never changes per
 * environment — the repository always lives in the dev account), but this is a
 * public repository, so it is intentionally NOT hard-coded. It is read from the
 * `CODECOMMIT_ACCOUNT_ID` environment variable instead, e.g.:
 *
 *   export CODECOMMIT_ACCOUNT_ID=111111111111
 *   npm run stage:deploy:all --project=myproject --env=dev
 */
export const sharedParams: SharedParams = {
  repositoryName: 'sample-app',
  codecommitAccountId: process.env.CODECOMMIT_ACCOUNT_ID,
};
