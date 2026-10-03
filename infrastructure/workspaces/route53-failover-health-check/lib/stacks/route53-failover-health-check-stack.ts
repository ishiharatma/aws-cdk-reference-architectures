import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface Route53FailoverHealthCheckStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Handler shared by both endpoints. `ROLE` names the endpoint; `FAIL=true` makes `/health` return 503,
 * which is how the check script takes the primary down without touching the stack.
 */
const HANDLER_CODE = `
exports.handler = async (event) => {
  const path = event.rawPath || '/';
  const body = JSON.stringify({ role: process.env.ROLE, path });
  if (path === '/health' && process.env.FAIL === 'true') {
    return { statusCode: 503, headers: { 'content-type': 'application/json' }, body };
  }
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body };
};
`;

/** Runs inside the VPC and resolves the record through the VPC resolver, the same path real clients use. */
const RESOLVER_CODE = `
const dns = require('dns').promises;
exports.handler = async () => {
  const cname = await dns.resolveCname(process.env.RECORD_NAME);
  return { record: process.env.RECORD_NAME, cname };
};
`;

/**
 * DNS failover with Route 53 health checks.
 *
 *   app.<zone>  PRIMARY    -> primary endpoint    (health check: HTTPS /health every 10 s, 2 failures)
 *               SECONDARY  -> secondary endpoint  (answered only while the primary is unhealthy)
 *
 * Both endpoints are Lambda function URLs so the pattern runs without a domain name or load balancer.
 * The records live in a private hosted zone, so only clients in the associated VPC resolve them. A resolver
 * Lambda inside the VPC stands in for such a client (`test-dns-answer` does not accept private zones).
 */
export class Route53FailoverHealthCheckStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Route53FailoverHealthCheckStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-failover`;

    // ---------------------------------------------------------------------------------------------
    // Two endpoints
    // ---------------------------------------------------------------------------------------------
    const endpoint = (role: 'primary' | 'secondary') => {
      const fn = new lambda.Function(this, `${role === 'primary' ? 'Primary' : 'Secondary'}Function`, {
        functionName: `${namePrefix}-${role}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromInline(HANDLER_CODE),
        environment: { ROLE: role, FAIL: 'false' },
        timeout: cdk.Duration.seconds(3),
        logGroup: new logs.LogGroup(this, `${role === 'primary' ? 'Primary' : 'Secondary'}LogGroup`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy,
        }),
      });
      // Route 53 health checkers are outside AWS auth, so the URL is public. It serves a fixed JSON document only.
      const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      return { fn, host: cdk.Fn.parseDomainName(url.url), url };
    };
    const primary = endpoint('primary');
    const secondary = endpoint('secondary');

    // ---------------------------------------------------------------------------------------------
    // Health check on the primary: HTTPS /health, 10 s interval, unhealthy after 2 consecutive failures
    // ---------------------------------------------------------------------------------------------
    const healthCheck = new route53.CfnHealthCheck(this, 'PrimaryHealthCheck', {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: primary.host,
        port: 443,
        resourcePath: '/health',
        requestInterval: params.healthCheckIntervalSeconds,
        failureThreshold: params.healthCheckFailureThreshold,
        enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: `${namePrefix}-primary` }],
    });

    // ---------------------------------------------------------------------------------------------
    // Private hosted zone (needs a VPC association; an empty VPC costs nothing) and the failover records
    // ---------------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.30.0.0/24'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 }],
      restrictDefaultSecurityGroup: true,
    });
    const zone = new route53.PrivateHostedZone(this, 'Zone', { zoneName: params.zoneName, vpc });
    const recordName = `${params.recordName}.${params.zoneName}`;

    new route53.CfnRecordSet(this, 'PrimaryRecord', {
      hostedZoneId: zone.hostedZoneId,
      name: recordName,
      type: 'CNAME',
      ttl: String(params.recordTtl),
      setIdentifier: 'primary',
      failover: 'PRIMARY',
      healthCheckId: healthCheck.attrHealthCheckId,
      resourceRecords: [primary.host],
    });
    new route53.CfnRecordSet(this, 'SecondaryRecord', {
      hostedZoneId: zone.hostedZoneId,
      name: recordName,
      type: 'CNAME',
      ttl: String(params.recordTtl),
      setIdentifier: 'secondary',
      failover: 'SECONDARY',
      resourceRecords: [secondary.host],
    });

    // ---------------------------------------------------------------------------------------------
    // Resolver probe: a Lambda in the VPC that resolves the record
    // ---------------------------------------------------------------------------------------------
    const resolver = new lambda.Function(this, 'ResolverFunction', {
      functionName: `${namePrefix}-resolver`,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(RESOLVER_CODE),
      environment: { RECORD_NAME: recordName },
      timeout: cdk.Duration.seconds(5),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      allowPublicSubnet: false,
      logGroup: new logs.LogGroup(this, 'ResolverLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
    });
    resolver.node.addDependency(zone);

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by test-failover.sh)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'HostedZoneId', { value: zone.hostedZoneId });
    new cdk.CfnOutput(this, 'ResolverFunctionName', { value: resolver.functionName });
    new cdk.CfnOutput(this, 'RecordName', { value: recordName });
    new cdk.CfnOutput(this, 'HealthCheckId', { value: healthCheck.attrHealthCheckId });
    new cdk.CfnOutput(this, 'PrimaryFunctionName', { value: primary.fn.functionName });
    new cdk.CfnOutput(this, 'PrimaryUrl', { value: primary.url.url });
    new cdk.CfnOutput(this, 'SecondaryUrl', { value: secondary.url.url });
  }
}
