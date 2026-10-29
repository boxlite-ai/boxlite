// Jest's node10 resolver cannot follow this package's export map. Runtime and
// production NodeNext resolution use the package's own declarations.
declare module '@opentelemetry/semantic-conventions/incubating' {
  export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME: 'deployment.environment.name'
  export const ATTR_SERVICE_INSTANCE_ID: 'service.instance.id'
}
