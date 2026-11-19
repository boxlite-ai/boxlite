/** Slashes delimit the app and stage even when their names contain hyphens. */
export const workloadSecretPath = (app: string, stage: string) => `boxlite/workloads/${app}/${stage}/`
