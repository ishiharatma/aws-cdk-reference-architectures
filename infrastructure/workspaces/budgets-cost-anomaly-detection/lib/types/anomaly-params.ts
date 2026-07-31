export const defaultAnomalyConfig = {
    monitorDimension: 'SERVICE' as const,
};

/**
 * A percentage + absolute-dollar threshold pair, AND-combined (both
 * conditions must be met before a notification is sent).
 */
export interface AnomalyThreshold {
    /**
     * Minimum anomaly impact, expressed as a percentage of the expected
     * spend, before a notification is sent (ANOMALY_TOTAL_IMPACT_PERCENTAGE).
     */
    readonly thresholdPercentage: number;
    /**
     * Minimum anomaly impact, in absolute USD, before a notification is
     * sent (ANOMALY_TOTAL_IMPACT_ABSOLUTE).
     */
    readonly thresholdAbsoluteUsd: number;
}

/**
 * Parameters for AWS Cost Anomaly Detection (Stack 2 / Stack 3)
 */
export interface AnomalyDetectionParams extends AnomalyThreshold {
    /**
     * Dimension the anomaly monitor evaluates cost anomalies against.
     * @default 'SERVICE'
     */
    readonly monitorDimension?: 'SERVICE' | 'LINKED_ACCOUNT';
    /**
     * Higher threshold for Stack 3's additional subscription on the same
     * monitor (see Stack 3's class doc for why it shares Stack 2's monitor
     * instead of creating its own). This demonstrates that a single monitor
     * can feed subscriptions with different severities/audiences — here, a
     * stricter "escalation" tier that only pages the unified/Slack channel
     * for larger anomalies, while Stack 2's subscription keeps covering the
     * full range at the base thresholds above.
     *
     * NOTE: in a real deployment, you would normally run Stack 2 *or*
     * Stack 3 for anomaly detection, not both — deploying both means every
     * qualifying anomaly is reported twice (once per subscription). This
     * option exists to demonstrate the pattern, not to recommend deploying
     * both stacks together in production.
     * @default same as thresholdPercentage/thresholdAbsoluteUsd above
     */
    readonly unifiedEscalation?: AnomalyThreshold;
}
