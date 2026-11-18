import * as cdk from 'aws-cdk-lib';
import * as directoryservice from 'aws-cdk-lib/aws-directoryservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { DirectoryParams } from 'lib/types';

/** Properties of {@link ManagedAd}. */
export interface ManagedAdProps {
  readonly namePrefix: string;
  readonly directory: DirectoryParams;
  readonly vpc: ec2.IVpc;
  /** Two subnets in different AZs for the domain controllers. */
  readonly subnets: ec2.ISubnet[];
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * AWS Managed Microsoft AD with the admin password generated in Secrets Manager and
 * AWS Directory Service Data (ds-data) enabled, so users can be managed through the API
 * (requirement 4) without a domain-joined instance.
 */
export class ManagedAd extends Construct {
  public readonly directoryId: string;
  public readonly directoryArn: string;
  /** Domain controller IPs (comma-separated). */
  public readonly dnsIpAddresses: string;
  public readonly adminSecret: secretsmanager.ISecret;
  /** `DC=...` form of the domain name. */
  public readonly domainDn: string;
  /** `OU=<NetBIOS>,DC=...`: the OU Managed AD delegates to the customer. */
  public readonly delegatedOuDn: string;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: ManagedAdProps) {
    super(scope, id);

    const { directory } = props;
    const stack = cdk.Stack.of(this);

    // Managed AD admin password: 8-64 chars, 3 of 4 character classes. Characters that need
    // escaping in PowerShell / JSON are excluded because the bootstrap script reads it.
    this.adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: `${props.namePrefix}/managed-ad/admin`,
      description: `Admin password of ${directory.domainName} (user: ${directory.netBiosName}\\Admin)`,
      generateSecretString: {
        passwordLength: 32,
        excludeCharacters: '"\'`$\\/@%&*(){}[]|;:<>?,=+~^ ',
        requireEachIncludedType: true,
      },
      removalPolicy: props.removalPolicy,
    });

    const microsoftAd = new directoryservice.CfnMicrosoftAD(this, 'Directory', {
      name: directory.domainName,
      shortName: directory.netBiosName,
      edition: directory.edition,
      // Resolved by CloudFormation through a dynamic reference; never in the template.
      password: this.adminSecret.secretValue.unsafeUnwrap(),
      vpcSettings: {
        vpcId: props.vpc.vpcId,
        subnetIds: props.subnets.map((subnet) => subnet.subnetId),
      },
    });
    microsoftAd.applyRemovalPolicy(props.removalPolicy);

    this.directoryId = microsoftAd.ref;
    this.directoryArn = stack.formatArn({
      service: 'ds',
      resource: 'directory',
      resourceName: microsoftAd.ref,
    });
    this.dnsIpAddresses = cdk.Fn.join(',', microsoftAd.attrDnsIpAddresses);
    this.domainDn = directory.domainName
      .split('.')
      .map((label) => `DC=${label}`)
      .join(',');
    this.delegatedOuDn = `OU=${directory.netBiosName},${this.domainDn}`;

    // ds-data has no CloudFormation property; enable it with an SDK call.
    new cr.AwsCustomResource(this, 'EnableDirectoryDataAccess', {
      onCreate: {
        service: 'DirectoryService',
        action: 'EnableDirectoryDataAccess',
        parameters: { DirectoryId: microsoftAd.ref },
        physicalResourceId: cr.PhysicalResourceId.of(`${microsoftAd.ref}-ds-data`),
      },
      onDelete: {
        service: 'DirectoryService',
        action: 'DisableDirectoryDataAccess',
        parameters: { DirectoryId: microsoftAd.ref },
        ignoreErrorCodesMatching: 'EntityDoesNotExistException|DirectoryInDesiredStateException',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.directoryArn] }),
      installLatestAwsSdk: false,
    });
  }
}
