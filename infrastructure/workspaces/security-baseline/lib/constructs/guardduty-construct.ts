import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import { Construct } from 'constructs';
import { GuardDutyFeatureParams } from 'parameters/environments';

/** Properties for {@link GuardDutyConstruct}. */
export interface GuardDutyConstructProps {
  /** Optional protection plans to enable. */
  readonly features: GuardDutyFeatureParams;
}

/**
 * A GuardDuty detector for this account and Region. Foundational detection (CloudTrail management events,
 * VPC Flow Logs, DNS logs) needs no configuration; the protection plans are opt-in via parameters.
 */
export class GuardDutyConstruct extends Construct {
  /** The detector. */
  public readonly detector: guardduty.CfnDetector;

  /**
   * Creates the detector with each protection plan set from parameters.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - detector settings
   */
  constructor(scope: Construct, id: string, props: GuardDutyConstructProps) {
    super(scope, id);

    const status = (enabled: boolean): string => (enabled ? 'ENABLED' : 'DISABLED');

    this.detector = new guardduty.CfnDetector(this, 'Resource', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      features: [
        { name: 'S3_DATA_EVENTS', status: status(props.features.s3Protection) },
        { name: 'EBS_MALWARE_PROTECTION', status: status(props.features.ebsMalwareProtection) },
        { name: 'RDS_LOGIN_EVENTS', status: status(props.features.rdsLoginEvents) },
        { name: 'LAMBDA_NETWORK_LOGS', status: status(props.features.lambdaNetworkLogs) },
      ],
    });
  }
}
