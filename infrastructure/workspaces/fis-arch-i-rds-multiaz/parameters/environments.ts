import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /**
     * Instance class of the Single-instance Multi-AZ DB instance (I-1 / I-3 target).
     */
    readonly dbInstanceClass: string;
    /**
     * Instance class of the Multi-AZ DB cluster members (I-2 target).
     * Multi-AZ DB clusters only support a limited set of classes (db.m5d / db.m6gd / db.r*d ...).
     */
    readonly clusterInstanceClass: string;
    /**
     * Email address subscribed to FIS experiment stop-condition alarms.
     * Optional — alarms are created regardless; no subscription if omitted.
     */
    readonly alarmEmail?: string;
}

export const params: Partial<Record<Environment, EnvParams>> = {};
