import type { Database, DatabaseProvider, DatabaseRequest } from '../../database.ts'
import type { NetworkBinding } from '../../network.ts'
import { instanceFor } from 'naming'
import { awsPassword } from './password.ts'

const INSTANCE = { small: 'db.t4g.micro', standard: 'db.t4g.small', medium: 'db.m7g.large' } as const
const STORAGE = { small: 20, standard: 20, medium: 100 } as const

export const awsDatabaseProvider =
  ({
    network,
    existingPasswordRef,
  }: {
    network: Extract<NetworkBinding, { cloud: 'aws' }>
    existingPasswordRef?: string
  }): DatabaseProvider =>
  (request: DatabaseRequest): Database => {
    const password = awsPassword('DatabasePassword', existingPasswordRef, 'password')
    const clients = new aws.ec2.SecurityGroup('DatabaseClientSecurityGroup', {
      vpcId: network.vpcId,
      egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
    })
    const ingress = new aws.vpc.SecurityGroupIngressRule('DatabaseFromClients', {
      securityGroupId: clients.id,
      referencedSecurityGroupId: clients.id,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
    })
    const subnet = new aws.rds.SubnetGroup('DatabaseSubnetGroup', { subnetIds: network.privateSubnets })
    const parameters = new aws.rds.ParameterGroup('DatabaseParameterGroup', {
      family: 'postgres17',
      parameters: [
        { name: 'rds.force_ssl', value: '0' },
        { name: 'rds.logical_replication', value: '1', applyMethod: 'pending-reboot' },
      ],
    })
    const suffix = request.protected ? new random.RandomId('DbFinalSnapshotSuffix', { byteLength: 4 }) : undefined
    const instance = new aws.rds.Instance(
      'DatabaseInstance',
      {
        dbName: request.name,
        engine: 'postgres',
        engineVersion: '17',
        username: 'postgres',
        password: password.value,
        instanceClass: INSTANCE[request.size],
        allocatedStorage: STORAGE[request.size],
        storageType: 'gp3',
        storageEncrypted: true,
        multiAz: request.highlyAvailable,
        publiclyAccessible: false,
        dbSubnetGroupName: subnet.name,
        vpcSecurityGroupIds: [clients.id],
        parameterGroupName: parameters.name,
        backupRetentionPeriod: request.backupRetentionDays,
        deletionProtection: request.protected,
        skipFinalSnapshot: !request.protected,
        ...(suffix
          ? {
              finalSnapshotIdentifier: $interpolate`${instanceFor({ app: $app.name, stage: $app.stage, artifact: 'database-final' })}-${suffix.hex}`,
            }
          : {}),
        autoMinorVersionUpgrade: false,
      },
      { ignoreChanges: ['engineVersion'], protect: request.protected, retainOnDelete: request.protected },
    )
    return {
      connection: {
        host: instance.address,
        port: instance.port.apply(String),
        username: instance.username,
        database: instance.dbName,
        applicationTls: true,
      },
      binding: { cloud: 'aws', passwordRef: password.passwordRef, clientGrant: clients.id },
      id: instance.id,
      ready: [instance, ingress, ...password.ready],
    }
  }
