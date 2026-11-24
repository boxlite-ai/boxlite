import type { Placement } from '../../network.ts'
import type { WorkloadHost } from '../../cluster.ts'
import { instanceFor } from 'naming'

type AwsPlacement = Extract<Placement, { cloud: 'aws' }>
type AwsHost = Extract<WorkloadHost, { cloud: 'aws' }>

export const awsRuntimeRole = (name: string, service: string) =>
  new aws.iam.Role(name, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: service },
          Action: 'sts:AssumeRole',
        },
      ],
    }),
    permissionsBoundary: $interpolate`arn:aws:iam::${aws.getCallerIdentityOutput({}).accountId}:policy/${instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runtime-boundary' })}`,
  })

/** Place one task revision after its execution and runtime permissions are ready. */
export const awsService = (
  name: string,
  request: {
    host: AwsHost
    placement: AwsPlacement
    image: $util.Input<string>
    port: number
    environment: Record<string, $util.Input<string>>
    secrets?: Record<string, $util.Input<string>>
    command?: string[]
    taskRole?: CloudResource
    targets?: { targetGroupArn: $util.Input<string>; containerPort: number }[]
    dependsOn?: CloudResource[]
    autoscaled?: boolean
    wait?: boolean
  },
) => {
  const role = request.taskRole ?? awsRuntimeRole(`${name}TaskRole`, 'ecs-tasks.amazonaws.com')
  const execution = awsRuntimeRole(`${name}ExecutionRole`, 'ecs-tasks.amazonaws.com')
  const executionPolicy = new aws.iam.RolePolicyAttachment(`${name}ExecutionPolicy`, {
    role: execution.name,
    policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
  })
  const secrets = request.secrets ?? {}
  const secretPolicy = new aws.iam.RolePolicy(`${name}ExecutionSecrets`, {
    role: execution.name,
    policy: $resolve(Object.values(secrets)).apply((references: string[]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: references.length
          ? [
              {
                Effect: 'Allow',
                Action: ['secretsmanager:GetSecretValue', 'ssm:GetParameters'],
                Resource: [
                  ...new Set(
                    references.map((reference) =>
                      reference.startsWith('arn:aws:secretsmanager:')
                        ? reference.split(':').slice(0, 7).join(':')
                        : reference,
                    ),
                  ),
                ],
              },
            ]
          : [{ Effect: 'Deny', Action: 'secretsmanager:GetSecretValue', Resource: '*' }],
      }),
    ),
  })
  const logs = new aws.cloudwatch.LogGroup(`${name}Logs`, { retentionInDays: 30 })
  const ports = [...new Set([request.port, ...(request.targets ?? []).map((target) => target.containerPort)])]
  const task = new aws.ecs.TaskDefinition(
    `${name}Task`,
    {
      family: instanceFor({ app: $app.name, stage: $app.stage, artifact: name.toLowerCase() }),
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '256',
      memory: '512',
      executionRoleArn: execution.arn,
      taskRoleArn: role.arn,
      containerDefinitions: $jsonStringify([
        {
          name,
          image: request.image,
          essential: true,
          ...(request.command ? { command: request.command } : {}),
          portMappings: ports.map((port) => ({ containerPort: port, protocol: 'tcp' })),
          environment: Object.entries(request.environment)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => ({ name: key, value })),
          secrets: Object.entries(secrets)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, valueFrom]) => ({ name: key, valueFrom })),
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logs.name,
              'awslogs-region': aws.getRegionOutput({}).name,
              'awslogs-stream-prefix': name,
            },
          },
        },
      ]),
    },
    { dependsOn: [executionPolicy, secretPolicy, ...(request.dependsOn ?? [])] },
  )
  const service = new aws.ecs.Service(
    `${name}Service`,
    {
      cluster: request.host.cluster.arn,
      taskDefinition: task.arn,
      launchType: 'FARGATE',
      desiredCount: 1,
      waitForSteadyState: request.wait ?? true,
      deploymentCircuitBreaker: { enable: true, rollback: true },
      networkConfiguration: {
        subnets: request.placement.subnets,
        securityGroups: request.placement.securityGroups,
        assignPublicIp: false,
      },
      loadBalancers: (request.targets ?? []).map((target) => ({
        targetGroupArn: target.targetGroupArn,
        containerPort: target.containerPort,
        containerName: name,
      })),
    },
    {
      dependsOn: [executionPolicy, secretPolicy, ...(request.dependsOn ?? [])],
      ignoreChanges: request.autoscaled ? ['desiredCount'] : undefined,
    },
  )
  return { service, task, role, logGroup: logs.name, ready: [service, executionPolicy, secretPolicy] }
}
