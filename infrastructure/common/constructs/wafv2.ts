import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Environment } from "../parameters/environments";
import { C_RESOURCE } from '../constants';

interface Wafv2Props {
    readonly project: string;
    readonly environment: Environment;
    readonly accessLogsBucket?: s3.IBucket;
    readonly snsAlarmTopic?: sns.ITopic;
}

export class Wafv2 extends Construct {
    public readonly waf: wafv2.CfnWebACL;
    
    constructor(scope: Construct, id: string, props: Wafv2Props) {
        super(scope, id);
        // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_wafregional.CfnWebACL.html
        this.waf = new wafv2.CfnWebACL(this, C_RESOURCE, {
            defaultAction: { allow: {} },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${props.project}-${props.environment}-waf`,
                sampledRequestsEnabled: true,
            },
        });
        if (props.accessLogsBucket) {
            new wafv2.CfnLoggingConfiguration(
                this,
                "LoggingConfiguration",
                {
                    logDestinationConfigs: [props.accessLogsBucket.bucketArn],
                    resourceArn: this.waf.attrArn,
                }
            );
        }
        this._createAlarm(this.waf, props.snsAlarmTopic);
    }

    /**
     * Create CloudWatch Alarm for WAF Web ACL if SNS Topic is provided
     * @param waf WAF Regional Web ACL
     * @param snsTopic SNS Topic for alarm notifications
     */
    private _createAlarm(waf: wafv2.CfnWebACL, snsTopic?: sns.ITopic) {
        if (!snsTopic) {
            return;
        }
        // Alarm creation logic goes here
    }
}