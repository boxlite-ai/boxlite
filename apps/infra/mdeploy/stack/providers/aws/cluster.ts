import type { Cluster, ClusterProvider, ContainerRole, WorkloadHost } from '../../cluster.ts'
import type { Network } from '../../network.ts'

/** Networking owns placement; ECS supplies the task scheduler. */
export const awsClusterProvider =
  ({ network }: { network: Network }): ClusterProvider =>
  (): Cluster => {
    if (network.binding.cloud !== 'aws') throw new Error('The AWS cluster needs an AWS network')
    const cluster = new aws.ecs.Cluster('Cluster', { settings: [{ name: 'containerInsights', value: 'enabled' }] })
    const host: WorkloadHost = { cloud: 'aws', cluster: { arn: cluster.arn, network: network.binding } }
    return { hostFor: (_role: ContainerRole) => host, ready: [cluster, ...network.ready] }
  }
