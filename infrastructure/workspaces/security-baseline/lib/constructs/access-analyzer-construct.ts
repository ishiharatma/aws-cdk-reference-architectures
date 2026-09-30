import * as accessanalyzer from 'aws-cdk-lib/aws-accessanalyzer';
import { Construct } from 'constructs';

/** Properties for {@link AccessAnalyzerConstruct}. */
export interface AccessAnalyzerConstructProps {
  /** Prefix for analyzer names. */
  readonly namePrefix: string;
  /** Also create the paid unused-access analyzer. */
  readonly enableUnusedAccess: boolean;
  /** Days without use after which unused access is reported. */
  readonly unusedAccessAgeDays: number;
}

/**
 * IAM Access Analyzer scoped to this account: an external-access analyzer (free), and optionally an
 * unused-access analyzer (billed per IAM role and user analyzed).
 */
export class AccessAnalyzerConstruct extends Construct {
  /** External-access analyzer. */
  public readonly externalAccess: accessanalyzer.CfnAnalyzer;
  /** Unused-access analyzer, when enabled. */
  public readonly unusedAccess?: accessanalyzer.CfnAnalyzer;

  /**
   * Creates the analyzers described on the class.
   *
   * @param scope - parent construct
   * @param id - construct ID
   * @param props - analyzer settings
   */
  constructor(scope: Construct, id: string, props: AccessAnalyzerConstructProps) {
    super(scope, id);

    this.externalAccess = new accessanalyzer.CfnAnalyzer(this, 'ExternalAccess', {
      analyzerName: `${props.namePrefix}-external-access`,
      type: 'ACCOUNT',
    });

    if (props.enableUnusedAccess) {
      this.unusedAccess = new accessanalyzer.CfnAnalyzer(this, 'UnusedAccess', {
        analyzerName: `${props.namePrefix}-unused-access`,
        type: 'ACCOUNT_UNUSED_ACCESS',
        analyzerConfiguration: {
          unusedAccessConfiguration: { unusedAccessAge: props.unusedAccessAgeDays },
        },
      });
    }
  }
}
