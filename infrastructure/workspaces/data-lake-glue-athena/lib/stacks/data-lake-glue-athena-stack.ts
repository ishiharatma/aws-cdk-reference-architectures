import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface DataLakeGlueAthenaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * A small data lake: raw CSV, a Glue workflow that catalogs and converts it, curated Parquet, and Athena on top.
 *
 *   raw zone (CSV, dt=... folders) --crawler--> Data Catalog (raw_orders, partitions found)
 *     --Glue ETL job: clean, de-duplicate, type, partition--> curated zone (Parquet, order_date=... folders)
 *     --crawler--> Data Catalog (curated_orders) --> Athena workgroup (scan limit, enforced encrypted results)
 */
export class DataLakeGlueAthenaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataLakeGlueAthenaStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-lake`;
    const dbName = `${project}_${environment}_lake`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // ---------------------------------------------------------------------------------------------
    // Zones: raw, curated and Athena results are separate buckets so each has its own permissions and lifecycle
    // ---------------------------------------------------------------------------------------------
    const bucket = (id: string, expirationDays?: number) => new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: isAutoDeleteObject,
      lifecycleRules: expirationDays ? [{ expiration: cdk.Duration.days(expirationDays) }] : undefined,
    });
    const rawBucket = bucket('RawBucket');
    const curatedBucket = bucket('CuratedBucket');
    const resultsBucket = bucket('AthenaResultsBucket', params.athenaResultsExpirationDays);

    // ---------------------------------------------------------------------------------------------
    // Data Catalog and the roles Glue runs as
    // ---------------------------------------------------------------------------------------------
    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: this.account,
      databaseInput: { name: dbName, description: 'Raw and curated orders' },
    });

    const glueRole = new iam.Role(this, 'GlueRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
    });
    rawBucket.grantRead(glueRole);
    curatedBucket.grantReadWrite(glueRole);

    // ---------------------------------------------------------------------------------------------
    // Crawlers: discover the schema and the dt=... / order_date=... partitions
    // ---------------------------------------------------------------------------------------------
    const crawlerConfig = JSON.stringify({ Version: 1.0, CrawlerOutput: { Partitions: { AddOrUpdateBehavior: 'InheritFromTable' } } });
    const crawler = (id: string, name: string, target: s3.IBucket, prefix: string) => new glue.CfnCrawler(this, id, {
      name,
      role: glueRole.roleArn,
      databaseName: dbName,
      tablePrefix: prefix,
      targets: { s3Targets: [{ path: `s3://${target.bucketName}/orders/` }] },
      schemaChangePolicy: { updateBehavior: 'UPDATE_IN_DATABASE', deleteBehavior: 'LOG' },
      configuration: crawlerConfig,
    });
    const rawCrawler = crawler('RawCrawler', `${namePrefix}-raw`, rawBucket, 'raw_');
    const curatedCrawler = crawler('CuratedCrawler', `${namePrefix}-curated`, curatedBucket, 'curated_');
    [rawCrawler, curatedCrawler].forEach((c) => c.node.addDependency(database));

    // ---------------------------------------------------------------------------------------------
    // ETL job: CSV -> cleaned, de-duplicated, typed Parquet partitioned by order date
    // ---------------------------------------------------------------------------------------------
    const script = new s3assets.Asset(this, 'EtlScript', { path: path.join(__dirname, '../../glue-jobs/orders_to_parquet.py') });
    script.grantRead(glueRole);
    const jobName = `${namePrefix}-orders-to-parquet`;
    const job = new glue.CfnJob(this, 'EtlJob', {
      name: jobName,
      role: glueRole.roleArn,
      glueVersion: params.glueVersion,
      workerType: params.glueWorkerType,
      numberOfWorkers: params.glueNumberOfWorkers,
      maxRetries: 0,
      timeout: 15,
      command: { name: 'glueetl', pythonVersion: '3', scriptLocation: script.s3ObjectUrl },
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-job-insights': 'false',
        '--source_database': dbName,
        '--source_table': 'raw_orders',
        '--target_path': `s3://${curatedBucket.bucketName}/orders/`,
      },
    });

    // ---------------------------------------------------------------------------------------------
    // Workflow: crawl raw -> convert -> crawl curated, each step starting only when the previous one succeeded
    // ---------------------------------------------------------------------------------------------
    const workflowName = `${namePrefix}-workflow`;
    const workflow = new glue.CfnWorkflow(this, 'Workflow', { name: workflowName, description: 'Raw CSV to curated Parquet' });
    const trigger = (id: string, props: Omit<glue.CfnTriggerProps, 'workflowName' | 'name'>) => {
      const t = new glue.CfnTrigger(this, id, { ...props, name: `${namePrefix}-${id.toLowerCase()}`, workflowName });
      t.node.addDependency(workflow);
      return t;
    };
    const start = trigger('StartTrigger', {
      type: params.workflowSchedule ? 'SCHEDULED' : 'ON_DEMAND',
      schedule: params.workflowSchedule,
      startOnCreation: params.workflowSchedule ? true : undefined,
      actions: [{ crawlerName: rawCrawler.name }],
    });
    const convert = trigger('ConvertTrigger', {
      type: 'CONDITIONAL',
      startOnCreation: true,
      predicate: { conditions: [{ logicalOperator: 'EQUALS', crawlerName: rawCrawler.name, crawlState: 'SUCCEEDED' }] },
      actions: [{ jobName }],
    });
    const catalogCurated = trigger('CatalogCuratedTrigger', {
      type: 'CONDITIONAL',
      startOnCreation: true,
      predicate: { conditions: [{ logicalOperator: 'EQUALS', jobName, state: 'SUCCEEDED' }] },
      actions: [{ crawlerName: curatedCrawler.name }],
    });
    [start, convert, catalogCurated].forEach((t) => {
      t.node.addDependency(rawCrawler);
      t.node.addDependency(curatedCrawler);
      t.node.addDependency(job);
    });

    // ---------------------------------------------------------------------------------------------
    // Athena: a workgroup that enforces the result location and encryption and caps the data a query may scan
    // ---------------------------------------------------------------------------------------------
    const workGroupName = `${namePrefix}-analysts`;
    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: workGroupName,
      description: 'Analysts: results are encrypted in one bucket and a query may scan at most a fixed number of bytes',
      state: 'ENABLED',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        requesterPaysEnabled: false,
        bytesScannedCutoffPerQuery: params.athenaBytesScannedCutoff,
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${resultsBucket.bucketName}/results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    new athena.CfnNamedQuery(this, 'DailyRevenueQuery', {
      name: `${namePrefix}-daily-revenue`,
      database: dbName,
      workGroup: workGroupName,
      // The crawler types a partition key as string, so the filter compares strings (a DATE literal fails with TYPE_MISMATCH).
      description: 'Revenue and order count per day from the curated Parquet table (reads two columns, prunes partitions)',
      queryString: `SELECT order_date, count(*) AS orders, sum(amount) AS revenue FROM curated_orders WHERE order_date >= '2026-10-01' GROUP BY order_date ORDER BY order_date`,
    }).addDependency(workGroup);

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by test-datalake.sh)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'RawBucketName', { value: rawBucket.bucketName });
    new cdk.CfnOutput(this, 'CuratedBucketName', { value: curatedBucket.bucketName });
    new cdk.CfnOutput(this, 'DatabaseName', { value: dbName });
    new cdk.CfnOutput(this, 'WorkflowName', { value: workflowName });
    new cdk.CfnOutput(this, 'WorkGroupName', { value: workGroupName });
    new cdk.CfnOutput(this, 'EtlJobName', { value: jobName });
  }
}
