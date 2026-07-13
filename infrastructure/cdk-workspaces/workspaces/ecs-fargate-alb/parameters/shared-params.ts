import { CodeCommitConfig } from '@common/types';
import { Environment } from "@common/parameters/environments";

export const codecommitParams: CodeCommitConfig = {
  codecommitAccountId: '111111111111',
  repositories: [
    `example-infra`,
  ],
  forwardTargets: [
    { environment: Environment.PRODUCTION, accountId: '333333333333' },
    { environment: Environment.STAGING, accountId: '222222222222' },
    { environment: Environment.DEVELOPMENT, accountId: '111111111111' },
  ],
};