import * as cdk from 'aws-cdk-lib';
import * as codeartifact from 'aws-cdk-lib/aws-codeartifact';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { Construct } from 'constructs';
import { codeArtifactDomainName, PACKAGE_REPOSITORY } from 'lib/shared/code-artifact';
import { accessibleRepositoryNames } from 'lib/shared/code-commit';
import { CodeCommitParams } from 'parameters/environments';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly namePrefix: string;
  readonly codeCommit?: CodeCommitParams;
}

/**
 * A network with no route out: sessions reach AWS services through VPC endpoints only.
 *
 * Removing the route is not enough on its own. Someone with a terminal could still send code to an S3
 * bucket or a repository in their own account through the same endpoints, using their own credentials,
 * or encode it in DNS queries. So each endpoint accepts only this account's principals and resources,
 * and the DNS Firewall answers only AWS names.
 */
export class PrivateNetworkStack extends cdk.Stack {
  public readonly connectorArn: string;

  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { namePrefix } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'sessions', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });

    const sessionsGroup = new ec2.SecurityGroup(this, 'SessionsSecurityGroup', {
      vpc,
      description: 'MicroVM sessions: HTTPS to the VPC endpoints only',
      allowAllOutbound: false,
    });
    const endpointsGroup = new ec2.SecurityGroup(this, 'EndpointsSecurityGroup', {
      vpc,
      description: 'VPC endpoints: HTTPS from sessions only',
      allowAllOutbound: false,
    });
    endpointsGroup.addIngressRule(sessionsGroup, ec2.Port.tcp(443), 'HTTPS from sessions');
    sessionsGroup.addEgressRule(endpointsGroup, ec2.Port.tcp(443), 'HTTPS to the VPC endpoints');

    const s3Endpoint = vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    const s3PrefixList = ec2.PrefixList.fromLookup(this, 'S3PrefixList', { prefixListName: `com.amazonaws.${this.region}.s3` });
    sessionsGroup.addEgressRule(ec2.Peer.prefixList(s3PrefixList.prefixListId), ec2.Port.tcp(443), 'HTTPS to S3 through the gateway endpoint');

    // Only this account's objects, plus the AWS-owned bucket CodeArtifact stores packages in. Workspace
    // URLs are signed by a role in this account, so they pass.
    s3Endpoint.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
    }));
    s3Endpoint.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject'],
      resources: [`arn:${this.partition}:s3:::assets-*`],
    }));

    const addEndpoint = (construct: string, service: string, statements?: iam.PolicyStatement[]): void => {
      const endpoint = vpc.addInterfaceEndpoint(construct, {
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.${service}`, 443),
        privateDnsEnabled: true,
        securityGroups: [endpointsGroup],
        open: false,
      });
      for (const statement of statements ?? [this.fromThisAccount()]) endpoint.addToPolicy(statement);
    };

    addEndpoint('BedrockRuntimeEndpoint', 'bedrock-runtime');
    addEndpoint('LambdaEndpoint', 'lambda');
    addEndpoint('LogsEndpoint', 'logs');
    addEndpoint('StsEndpoint', 'sts');
    addEndpoint('CodeArtifactApiEndpoint', 'codeartifact.api');
    addEndpoint('CodeArtifactRepositoriesEndpoint', 'codeartifact.repositories');

    const repositories = accessibleRepositoryNames(props.codeCommit);
    if (repositories.length > 0) {
      addEndpoint('CodeCommitEndpoint', 'git-codecommit', [new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['codecommit:GitPull', 'codecommit:GitPush'],
        resources: repositories.map((name) => this.formatArn({ service: 'codecommit', resource: name })),
      })]);
    }

    // Package installs keep working, through a mirror nobody here can publish to.
    const domainName = codeArtifactDomainName(namePrefix);
    const domain = new codeartifact.CfnDomain(this, 'PackageDomain', { domainName });
    const npm = new codeartifact.CfnRepository(this, 'NpmUpstream', {
      domainName: domain.attrName,
      repositoryName: 'npm-store',
      externalConnections: ['public:npmjs'],
    });
    const pypi = new codeartifact.CfnRepository(this, 'PypiUpstream', {
      domainName: domain.attrName,
      repositoryName: 'pypi-store',
      externalConnections: ['public:pypi'],
    });
    new codeartifact.CfnRepository(this, 'PackageRepository', {
      domainName: domain.attrName,
      repositoryName: PACKAGE_REPOSITORY,
      upstreams: [npm.attrName, pypi.attrName],
    });

    const allowAws = new route53resolver.CfnFirewallDomainList(this, 'AwsDomains', {
      name: `${namePrefix}-aws`,
      domains: ['amazonaws.com', '*.amazonaws.com', '*.internal'],
    });
    const everything = new route53resolver.CfnFirewallDomainList(this, 'AllDomains', {
      name: `${namePrefix}-all`,
      domains: ['*'],
    });
    const dnsRules = new route53resolver.CfnFirewallRuleGroup(this, 'DnsRules', {
      name: `${namePrefix}-dns`,
      firewallRules: [
        { firewallDomainListId: allowAws.attrId, priority: 1, action: 'ALLOW' },
        { firewallDomainListId: everything.attrId, priority: 2, action: 'BLOCK', blockResponse: 'NXDOMAIN' },
      ],
    });
    new route53resolver.CfnFirewallRuleGroupAssociation(this, 'DnsRulesAssociation', {
      firewallRuleGroupId: dnsRules.attrId,
      vpcId: vpc.vpcId,
      priority: 1000,
      name: `${namePrefix}-dns`,
    });

    // Lambda assumes this role to manage the connector's network interfaces.
    const operatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Manages the MicroVM connector network interfaces',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    });
    const connector = new lambda.CfnNetworkConnector(this, 'EgressConnector', {
      name: `${namePrefix}-private`,
      operatorRole: operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
          securityGroupIds: [sessionsGroup.securityGroupId],
          networkProtocol: 'IPv4',
        },
      },
    });
    this.connectorArn = connector.attrArn;

    new cdk.CfnOutput(this, 'EgressConnectorArn', { value: this.connectorArn });
  }

  /** Calls through this endpoint must use credentials from this account. */
  private fromThisAccount(): iam.PolicyStatement {
    return new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['*'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:PrincipalAccount': this.account } },
    });
  }
}
