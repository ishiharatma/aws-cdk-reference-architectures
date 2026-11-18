import { Environment, EnvironmentConfig } from '@common/parameters/environments';
import {
  DirectoryParams,
  ManagementInstanceParams,
  NetworkParams,
  OperatorRoleParams,
  UsageReportParams,
  WorkSpacesParams,
} from 'lib/types';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Closed VPC layout (requirements 1, 2, 3, 5). */
  readonly network: NetworkParams;
  /** Managed AD, OU tree, groups, PSO and GPO values. */
  readonly directory: DirectoryParams;
  /** Management instance that builds the AD objects. */
  readonly managementInstance: ManagementInstanceParams;
  /** WorkSpaces directory registration and IP access control (R1). */
  readonly workspaces: WorkSpacesParams;
  /** Operator role (requirement 4). */
  readonly operatorRole: OperatorRoleParams;
  /** Monthly usage report (requirement 6). */
  readonly usageReport: UsageReportParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
