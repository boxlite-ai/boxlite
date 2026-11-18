import { awsRuntimeRole } from './service.ts'
import { instanceFor } from 'naming'

/** Two availability zones retain the existing CIDRs and fck-NAT egress model. */
export const awsVpc = (region: string, internetEgress: boolean) => {
  const network = new aws.ec2.Vpc('Vpc', { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true })
  const gateway = new aws.ec2.InternetGateway('VpcInternetGateway', { vpcId: network.id })
  const zones = aws.getAvailabilityZonesOutput({ state: 'available' })
  const natSecurityGroup = internetEgress
    ? new aws.ec2.SecurityGroup('VpcNatSecurityGroup', {
        vpcId: network.id,
        ingress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: [network.cidrBlock] }],
        egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
      })
    : undefined
  const role = internetEgress ? awsRuntimeRole('VpcNatRole', 'ec2.amazonaws.com') : undefined
  const profile = role ? new aws.iam.InstanceProfile('VpcNatInstanceProfile', { role: role.name }) : undefined
  if (role)
    new aws.iam.RolePolicyAttachment('VpcNatSsm', {
      role: role.name,
      policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    })
  const ami = internetEgress
    ? aws.ec2.getAmiOutput({
        owners: ['568608671756'],
        mostRecent: true,
        filters: [
          { name: 'name', values: ['fck-nat-al2023-*'] },
          { name: 'architecture', values: ['arm64'] },
        ],
      })
    : undefined
  const publicSubnets: CloudResource[] = []
  const privateSubnets: CloudResource[] = []
  const privateRouteTables: CloudResource[] = []
  const ready: CloudResource[] = []
  for (let index = 0; index < 2; index++) {
    const suffix = index + 1
    const zone = zones.names.apply((names: string[]) => {
      if (names.length < 2) throw new Error(`${region} needs two available zones for the application network`)
      return names[index]!
    })
    const publicSubnet = new aws.ec2.Subnet(`VpcPublicSubnet${suffix}`, {
      vpcId: network.id,
      cidrBlock: `10.0.${index * 8}.0/22`,
      availabilityZone: zone,
      mapPublicIpOnLaunch: true,
    })
    const privateSubnet = new aws.ec2.Subnet(`VpcPrivateSubnet${suffix}`, {
      vpcId: network.id,
      cidrBlock: `10.0.${index * 8 + 4}.0/22`,
      availabilityZone: zone,
    })
    const publicRoute = new aws.ec2.RouteTable(`VpcPublicRouteTable${suffix}`, {
      vpcId: network.id,
      routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: gateway.id }],
    })
    ready.push(
      new aws.ec2.RouteTableAssociation(`VpcPublicRouteTableAssociation${suffix}`, {
        subnetId: publicSubnet.id,
        routeTableId: publicRoute.id,
      }),
    )
    let nat: CloudResource | undefined
    if (internetEgress) {
      const label = instanceFor({ app: $app.name, stage: $app.stage, artifact: `nat-${suffix}` })
      const address = new aws.ec2.Eip(`VpcElasticIp${suffix}`, { domain: 'vpc' })
      nat = new aws.ec2.Instance(
        `VpcNatInstance${suffix}`,
        {
          instanceType: 't4g.nano',
          ami: ami!.id,
          subnetId: publicSubnet.id,
          vpcSecurityGroupIds: [natSecurityGroup!.id],
          iamInstanceProfile: profile!.name,
          sourceDestCheck: false,
          tags: { Name: $interpolate`${label}-${zone}` },
        },
        { dependsOn: [gateway], ignoreChanges: ['ami', 'userData'] },
      )
      ready.push(new aws.ec2.EipAssociation(`VpcNatAddress${suffix}`, { allocationId: address.id, instanceId: nat.id }))
    }
    const privateRoute = new aws.ec2.RouteTable(`VpcPrivateRouteTable${suffix}`, {
      vpcId: network.id,
      routes: nat ? [{ cidrBlock: '0.0.0.0/0', networkInterfaceId: nat.primaryNetworkInterfaceId }] : [],
    })
    ready.push(
      new aws.ec2.RouteTableAssociation(`VpcPrivateRouteTableAssociation${suffix}`, {
        subnetId: privateSubnet.id,
        routeTableId: privateRoute.id,
      }),
    )
    publicSubnets.push(publicSubnet)
    privateSubnets.push(privateSubnet)
    privateRouteTables.push(privateRoute)
  }
  const namespace = new aws.servicediscovery.PrivateDnsNamespace('VpcCloudmapNamespace', {
    name: `${instanceFor({ app: $app.name, stage: $app.stage, artifact: 'network' })}.internal`,
    vpc: network.id,
  })
  return {
    id: network.id,
    cidrBlock: network.cidrBlock,
    publicSubnets: $util.output(publicSubnets.map((subnet) => subnet.id)),
    privateSubnets: $util.output(privateSubnets.map((subnet) => subnet.id)),
    privateRouteTables,
    namespace,
    ready,
  }
}
