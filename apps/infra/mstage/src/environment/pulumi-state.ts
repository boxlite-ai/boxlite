/** Pulumi DIY backends scope checkpoints by project and locks by fully qualified stack name. */
export const pulumiCheckpointKey = (app: string, stage: string): string => `.pulumi/stacks/${app}/${stage}.json`
export const pulumiLockPrefix = (app: string, stage: string): string => `.pulumi/locks/organization/${app}/${stage}/`
