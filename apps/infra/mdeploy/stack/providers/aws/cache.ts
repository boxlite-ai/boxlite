import type { Cache, CacheProvider, CacheRequest } from '../../cache.ts'
import type { NetworkBinding } from '../../network.ts'
import { awsPassword } from './password.ts'

const INSTANCE = { small: 'cache.t4g.micro', medium: 'cache.m7g.large' } as const

export const awsCacheProvider =
  ({ network }: { network: Extract<NetworkBinding, { cloud: 'aws' }> }): CacheProvider =>
  (request: CacheRequest): Cache => {
    if (!request.encryptInTransit) throw new Error('AWS Redis AUTH requires encryptInTransit=true')
    const password = awsPassword('CachePassword')
    const clients = new aws.ec2.SecurityGroup('CacheClientSecurityGroup', {
      vpcId: network.vpcId,
      egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
    })
    const ingress = new aws.vpc.SecurityGroupIngressRule('CacheFromClients', {
      securityGroupId: clients.id,
      referencedSecurityGroupId: clients.id,
      ipProtocol: 'tcp',
      fromPort: 6379,
      toPort: 6379,
    })
    const subnet = new aws.elasticache.SubnetGroup('CacheSubnetGroup', { subnetIds: network.privateSubnets })
    const parameters = new aws.elasticache.ParameterGroup('CacheParameterGroup', {
      family: 'redis7',
      parameters: [{ name: 'cluster-enabled', value: 'no' }],
    })
    const cluster = new aws.elasticache.ReplicationGroup('CacheCluster', {
      description: 'BoxLite cache',
      engine: 'redis',
      engineVersion: '7.1',
      nodeType: INSTANCE[request.size],
      port: 6379,
      subnetGroupName: subnet.name,
      securityGroupIds: [clients.id],
      parameterGroupName: parameters.name,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: request.encryptInTransit,
      ...(request.encryptInTransit ? { transitEncryptionMode: 'required' } : {}),
      authToken: password.value,
      authTokenUpdateStrategy: 'ROTATE',
      autoMinorVersionUpgrade: false,
      numCacheClusters: request.clustered ? 2 : 1,
      automaticFailoverEnabled: request.clustered,
      multiAzEnabled: request.clustered,
    })
    return {
      connection: {
        host: cluster.primaryEndpointAddress,
        port: cluster.port.apply(String),
      },
      binding: { cloud: 'aws', passwordRef: password.passwordRef, clientGrant: clients.id },
      id: cluster.id,
      ready: [cluster, ingress, ...password.ready],
    }
  }
