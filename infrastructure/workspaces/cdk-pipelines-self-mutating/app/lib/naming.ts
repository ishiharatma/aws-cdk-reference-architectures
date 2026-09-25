/** Shared naming so the repository stack (workspace root) and the pipeline stack (this app) agree without cross-stack references. */
export const resourcePrefix = (project: string, environment: string): string => `${project}-${environment}-cdkp`;

export const repositoryName = (project: string, environment: string): string => `${resourcePrefix(project, environment)}-app`;

export const pipelineStackName = (project: string, environment: string): string => `${resourcePrefix(project, environment)}-pipeline`;

export const appStackName = (project: string, environment: string, stageName: string): string =>
  `${resourcePrefix(project, environment)}-${stageName.toLowerCase()}-hello`;
