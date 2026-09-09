/*
 * Redis on Memorystore, with a private address.
 *
 * Memorystore mints its own AUTH string and exposes it as an output, so unlike
 * the database this provider copies rather than generates. The destination is
 * the same either way: Secret Manager, and a `secretKeyRef` the platform
 * resolves — the value never becomes a revision's plain environment.
 *
 * `clientGrant` is the account carried by whatever connects, as it is for the
 * database. Memorystore has no IAM role of its own to grant: reachability is
 * the network's answer and the AUTH string is the credential, so what this
 * returns is the identity the firewall rules already name. Saying that plainly
 * beats inventing a grant that does nothing.
 */

import type { Cache, CacheProvider, CacheRequest } from '../../cache.ts'
import type { NetworkBinding } from '../../network.ts'

/** What each requested size answers to, in gigabytes. */
const MEMORY_GB = { small: 1, medium: 5 } as const


export const gcpCacheProvider =
  ({
    network,
    project,
    region,
    clientAccount,
    dependsOn,
  }: {
    network: Extract<NetworkBinding, { cloud: 'gcp' }>
    project: string
    region: string
    clientAccount: $util.Output<string>
    /** The network's own resources, the peering among them. See `database.ts`. */
    dependsOn: any[]
  }): CacheProvider =>
  (request: CacheRequest): Cache => {
    const prefix = `${$app.name}-${$app.stage}`

    const instance = new gcp.redis.Instance(
      'Cache',
      {
        name: `${prefix}-cache`,
        project,
        region,
        memorySizeGb: MEMORY_GB[request.size],
        // Standard keeps a replica in a second zone; basic is one node. A cache
        // that is lost is refilled, so this follows the request rather than
        // defaulting to the safer answer.
        tier: request.clustered ? 'STANDARD_HA' : 'BASIC',
        authorizedNetwork: network.network,
        connectMode: 'PRIVATE_SERVICE_ACCESS',
        // The AUTH string. Without it the instance admits anything that can
        // reach the address, which on a shared network is more than intended.
        authEnabled: true,
        // `SERVER_AUTHENTICATION` is Memorystore's word for TLS. The contract
        // refuses `false` before this is reached, so this honours the request
        // rather than deciding it.
        transitEncryptionMode: request.encryptInTransit ? 'SERVER_AUTHENTICATION' : 'DISABLED',
      },
      { dependsOn },
    )

    const secret = new gcp.secretmanager.Secret('CachePasswordSecret', {
      project,
      secretId: `${prefix}-cache-password`,
      replication: { auto: {} },
    })
    const version = new gcp.secretmanager.SecretVersion('CachePasswordValue', {
      secret: secret.id,
      secretData: $util.secret(instance.authString),
    })

    /*
     * The instance's own CA, put where a workload can be handed it.
     *
     * Memorystore signs with a certificate no image trusts, exactly as Cloud
     * SQL does — but there is no platform proxy for Redis, so the certificate
     * has to travel. Through Secret Manager rather than as a stack output: a
     * mounted secret is the delivery channel a Cloud Run workload already has
     * for a file, and this keeps the CA on the same path as every credential.
     */
    const ca = new gcp.secretmanager.Secret('CacheCaSecret', {
      project,
      secretId: `${prefix}-cache-ca`,
      replication: { auto: {} },
    })
    const caVersion = new gcp.secretmanager.SecretVersion('CacheCaValue', {
      secret: ca.id,
      /*
       * With a trailing newline, which the API does not return one with.
       *
       * A PEM whose final `-----END CERTIFICATE-----` has no newline after it
       * is not parsed, and nothing says so: OpenSSL skips the block, Node
       * carries on with the default trust store, and the connection fails with
       * `unable to verify the first certificate` — the identical error to
       * having mounted no CA at all.
       */
      secretData: instance.serverCaCerts.apply(
        (certificates: { cert: string }[]) => `${certificates[0]!.cert.trimEnd()}\n`,
      ),
    })

    return {
      /*
       * The port the instance reports, not Redis's default.
       *
       * Memorystore moves the listener when transit encryption is on: an
       * instance with `SERVER_AUTHENTICATION` serves 6378, and 6379 is then a
       * port nothing is bound to. A client dialling the constant does not get
       * refused, it gets a connect timeout — which reads as a firewall or a
       * peering problem and sends the reader to look at the network. Asking the
       * instance is both shorter and true whichever mode it is in.
       */
      connection: { host: instance.host, port: instance.port.apply(String) },
      binding: { cloud: 'gcp', passwordRef: version.name, clientGrant: clientAccount, caRef: caVersion.name },
      id: instance.id,
      ready: [version, caVersion],
    }
  }
