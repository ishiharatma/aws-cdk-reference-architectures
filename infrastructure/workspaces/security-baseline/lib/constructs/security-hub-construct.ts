import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import { Construct } from 'constructs';

/** Properties for {@link SecurityHubConstruct}. */
export interface SecurityHubConstructProps {
  /** Config recorder; Security Hub controls evaluate Config data, so the hub is created after it. */
  readonly configRecorder: config.CfnConfigurationRecorder;
  /** Extra standard ARNs to subscribe to besides AWS Foundational Security Best Practices. */
  readonly additionalStandardArns: string[];
}

/**
 * Security Hub for this account and Region, subscribed to AWS Foundational Security Best Practices.
 * Default standards are turned off on the hub so the subscriptions are exactly the ones declared here.
 * GuardDuty and IAM Access Analyzer findings flow in through their built-in integrations.
 */
export class SecurityHubConstruct extends Construct {
  /** The hub. */
  public readonly hub: securityhub.CfnHub;

  /**
   * Creates the hub and one subscription per standard, ordered after Config.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - hub settings
   */
  constructor(scope: Construct, id: string, props: SecurityHubConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    this.hub = new securityhub.CfnHub(this, 'Resource', {
      enableDefaultStandards: false,
      controlFindingGenerator: 'SECURITY_CONTROL',
      autoEnableControls: true,
    });
    this.hub.node.addDependency(props.configRecorder);

    const standardArns = [
      `arn:${stack.partition}:securityhub:${stack.region}::standards/aws-foundational-security-best-practices/v/1.0.0`,
      ...props.additionalStandardArns,
    ];
    standardArns.forEach((standardsArn, index) => {
      const standard = new securityhub.CfnStandard(this, `Standard${index}`, { standardsArn });
      standard.node.addDependency(this.hub);
    });
  }
}
