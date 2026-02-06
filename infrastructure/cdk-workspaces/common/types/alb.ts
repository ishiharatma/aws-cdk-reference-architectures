
// ALB configuration
export interface AlbConfig {
    /** Existing ALB ARN (if not creating a new one) */
    readonly existingAlbArn?: string;
    /** ALB creation configuration (if creating a new one) */
    readonly createConfig?: AlbCreateConfig;
}


export interface AlbCreateConfig {
    readonly albName: string;
    /**
     * Whether the ALB is internet-facing
     * @default true
     */
    readonly internetFacing?: boolean;
    /**
     * ALB security groups
     * If not specified, a new security group will be created
     */
    readonly securityGroups?: string[];

    readonly healthCheckPath?: string;
}