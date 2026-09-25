import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';

const rdsData = new RDSDataClient({});
const { CLUSTER_ARN = '', SECRET_ARN = '', DATABASE_NAME = '' } = process.env;

/**
 * Runs `SELECT current_user` through the RDS Data API using the application secret.
 *
 * The consumer pattern this demonstrates: the function never sees or caches a password. The Data
 * API resolves the secret's AWSCURRENT version on every call, so credential rotation needs no
 * redeploy, no restart and no cache invalidation. With alternating-user rotation the answer flips
 * between `appuser` and `appuser_clone` after each rotation.
 */
export const handler = async (): Promise<{ currentUser: string }> => {
  const res = await rdsData.send(
    new ExecuteStatementCommand({ resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: DATABASE_NAME, sql: 'SELECT current_user' }),
  );
  return { currentUser: res.records?.[0]?.[0]?.stringValue ?? '' };
};
