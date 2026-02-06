import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as wafregional from 'aws-cdk-lib/aws-waf-regional';

// VPC configuration
export interface WafConfig {
    /** Existing WAF WebAcl ARN (if not creating a new one) */
    readonly existingWafArn?: string;
    /** WAF creation configuration (if creating a new one) */
    readonly createConfig?: WafCreateConfig;
}

export interface WafCreateConfig {
    readonly enabledLogging: boolean;
}