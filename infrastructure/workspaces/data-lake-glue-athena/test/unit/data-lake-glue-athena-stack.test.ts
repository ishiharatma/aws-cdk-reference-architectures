/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { DataLakeGlueAthenaStack } from 'lib/stacks/data-lake-glue-athena-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (overrides: Partial<typeof envParams> = {}, isAutoDeleteObject = true) => {
  const app = new cdk.App();
  const stack = new DataLakeGlueAthenaStack(app, 'DataLakeGlueAthena', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject,
    env: testEnv,
    params: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
};

describe('DataLakeGlueAthenaStack', () => {
  const template = build();

  describe('zones', () => {
    test('raw, curated and results buckets are private, encrypted and TLS-only', () => {
      const buckets = Object.values(template.findResources('AWS::S3::Bucket')) as any[];
      expect(buckets).toHaveLength(3);
      buckets.forEach((b) => {
        expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
        expect(b.Properties.BucketEncryption).toBeDefined();
      });
      template.resourceCountIs('AWS::S3::BucketPolicy', 3);
    });

    test('only the Athena results bucket expires its objects', () => {
      const expiring = Object.values(template.findResources('AWS::S3::Bucket', { Properties: { LifecycleConfiguration: Match.anyValue() } })) as any[];
      expect(expiring).toHaveLength(1);
      expect(expiring[0].Properties.LifecycleConfiguration.Rules[0].ExpirationInDays).toBe(envParams.athenaResultsExpirationDays);
    });
  });

  describe('catalog and crawlers', () => {
    test('one database and two crawlers with distinct table prefixes over the zone folders', () => {
      template.resourceCountIs('AWS::Glue::Database', 1);
      template.hasResourceProperties('AWS::Glue::Crawler', { TablePrefix: 'raw_', Name: 'test-test-lake-raw' });
      template.hasResourceProperties('AWS::Glue::Crawler', { TablePrefix: 'curated_', Name: 'test-test-lake-curated' });
    });

    test('crawlers update the table in place and only log removed objects, partitions inherit the table schema', () => {
      const crawlers = Object.values(template.findResources('AWS::Glue::Crawler')) as any[];
      crawlers.forEach((c) => {
        expect(c.Properties.SchemaChangePolicy).toEqual({ UpdateBehavior: 'UPDATE_IN_DATABASE', DeleteBehavior: 'LOG' });
        expect(JSON.parse(c.Properties.Configuration).CrawlerOutput.Partitions.AddOrUpdateBehavior).toBe('InheritFromTable');
      });
    });

    test('the database name is a valid Glue identifier', () => {
      const db = Object.values(template.findResources('AWS::Glue::Database'))[0] as any;
      expect(db.Properties.DatabaseInput.Name).toMatch(/^[a-z0-9_]+$/);
    });
  });

  describe('ETL job', () => {
    test('a Spark job with the configured version and capacity, no retries and a timeout', () => {
      template.hasResourceProperties('AWS::Glue::Job', {
        Name: 'test-test-lake-orders-to-parquet',
        GlueVersion: envParams.glueVersion,
        WorkerType: envParams.glueWorkerType,
        NumberOfWorkers: envParams.glueNumberOfWorkers,
        MaxRetries: 0,
        Timeout: 15,
        Command: Match.objectLike({ Name: 'glueetl', PythonVersion: '3' }),
      });
    });

    test('the job reads the raw table and writes under the curated zone', () => {
      const job = Object.values(template.findResources('AWS::Glue::Job'))[0] as any;
      expect(job.Properties.DefaultArguments['--source_table']).toBe('raw_orders');
      expect(JSON.stringify(job.Properties.DefaultArguments['--target_path'])).toContain('CuratedBucket');
    });

    test('the Glue role writes only the curated zone and reads the raw zone', () => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy', { Properties: { PolicyName: Match.stringLikeRegexp('^GlueRole') } })) as any[];
      const statements: any[] = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
      const writes = statements.filter((s) => JSON.stringify(s.Action).includes('s3:PutObject'));
      expect(writes).toHaveLength(1);
      expect(JSON.stringify(writes[0].Resource)).toContain('CuratedBucket');
      expect(JSON.stringify(writes[0].Resource)).not.toContain('RawBucket');
    });
  });

  describe('workflow', () => {
    test('crawl raw, then convert, then crawl curated, each conditional on the previous step', () => {
      template.resourceCountIs('AWS::Glue::Workflow', 1);
      const triggers = Object.values(template.findResources('AWS::Glue::Trigger')) as any[];
      expect(triggers).toHaveLength(3);
      expect(triggers.map((t) => t.Properties.Type).sort()).toEqual(['CONDITIONAL', 'CONDITIONAL', 'ON_DEMAND']);
      const convert = triggers.find((t) => t.Properties.Actions[0].JobName);
      expect(convert.Properties.Predicate.Conditions[0]).toMatchObject({ LogicalOperator: 'EQUALS', CrawlState: 'SUCCEEDED' });
      const catalog = triggers.find((t) => t.Properties.Actions[0].CrawlerName && t.Properties.Type === 'CONDITIONAL');
      expect(catalog.Properties.Predicate.Conditions[0]).toMatchObject({ LogicalOperator: 'EQUALS', State: 'SUCCEEDED' });
    });

    test('a schedule turns the first trigger into a scheduled one', () => {
      const scheduled = build({ workflowSchedule: 'cron(0 18 * * ? *)' });
      scheduled.hasResourceProperties('AWS::Glue::Trigger', { Type: 'SCHEDULED', Schedule: 'cron(0 18 * * ? *)', StartOnCreation: true });
    });
  });

  describe('Athena workgroup', () => {
    test('the workgroup config is enforced, encrypted and capped', () => {
      template.hasResourceProperties('AWS::Athena::WorkGroup', {
        State: 'ENABLED',
        WorkGroupConfiguration: Match.objectLike({
          EnforceWorkGroupConfiguration: true,
          PublishCloudWatchMetricsEnabled: true,
          RequesterPaysEnabled: false,
          BytesScannedCutoffPerQuery: envParams.athenaBytesScannedCutoff,
          ResultConfiguration: Match.objectLike({ EncryptionConfiguration: { EncryptionOption: 'SSE_S3' } }),
        }),
      });
    });

    test('the named query filters on the partition column with a string, the type the crawler gives it', () => {
      template.hasResourceProperties('AWS::Athena::NamedQuery', {
        QueryString: Match.stringLikeRegexp("FROM curated_orders WHERE order_date >= '"),
      });
    });
  });

  describe('removal', () => {
    test('production keeps the zone buckets', () => {
      const prod = build({}, false);
      Object.values(prod.findResources('AWS::S3::Bucket')).forEach((b: any) => expect(b.DeletionPolicy).toBe('Retain'));
    });
  });
});
