/*
 * PostgreSQL on Cloud SQL, with a private address.
 *
 * The password is generated here rather than by the service, which is the first
 * real difference from RDS: Cloud SQL has no "mint one and tell me" mode, so
 * `random.RandomPassword` produces it and it goes straight into Secret Manager.
 * The value never becomes an output of this stack — a Cloud Run revision reads
 * it through a `secretKeyRef`, and the deploy that arranged that never holds it.
 *
 * `clientGrant` is a service account rather than a security group, and that is
 * the second difference. There is no group to be a member of: an account is
 * granted `cloudsql.client` and a workload carries that account. Same idea,
 * incompatible value — which is exactly why the contract's binding is a tagged
 * union rather than a shared string.
 *
 * The private address needs the network's Private Service Access peering, and
 * an instance created before it exists fails with an error about the service
 * rather than about the peering. The provider takes the network binding, which
 * carries that peering, for that reason.
 */

import type { Database, DatabaseProvider, DatabaseRequest } from '../../database.ts'
import type { NetworkBinding } from '../../network.ts'

/**
 * What each requested size answers to, and the edition that tier is legal in.
 *
 * One constant rather than two, because they are one decision. `ENTERPRISE_PLUS`
 * accepts only the predefined `db-perf-optimized-N-*` machines; every tier here
 * is shared-core or custom, and those are `ENTERPRISE`'s alone. Leaving the
 * edition to the API is what makes this a create-time failure rather than a
 * choice — a PostgreSQL 16 instance defaults to `ENTERPRISE_PLUS`, and the
 * refusal that follows names the tier (`Invalid Tier (db-f1-micro) for
 * (ENTERPRISE_PLUS) Edition`) without mentioning the setting that caused it.
 */
export const MACHINE = {
  small: { tier: 'db-f1-micro', edition: 'ENTERPRISE' },
  medium: { tier: 'db-custom-2-7680', edition: 'ENTERPRISE' },
} as const

/** Cloud SQL's own port, and the only one it listens on. */
const PORT = '5432'

/** The account every connection is made as. Cloud SQL's own superuser is not used. */
const USERNAME = 'boxlite'

export const gcpDatabaseProvider =
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
    /** The identity granted `cloudsql.client`, from the network's own accounts. */
    clientAccount: $util.Output<string>
    /**
     * The network's own resources, the peering among them. An instance created
     * before Private Service Access exists fails with an error about the
     * service rather than about the peering, so the edge is explicit.
     */
    dependsOn: any[]
  }): DatabaseProvider =>
  (request: DatabaseRequest): Database => {
    const prefix = `${$app.name}-${$app.stage}`

    const instance = new gcp.sql.DatabaseInstance(
      'Database',
      {
        name: `${prefix}-db`,
        project,
        region,
        databaseVersion: 'POSTGRES_16',
        // Refuses a delete through the API, which is the counterpart of RDS's
        // deletion protection. Cloud SQL also has a provider-side flag below;
        // both, because they refuse different callers.
        deletionProtection: request.protected,
        settings: {
          tier: MACHINE[request.size].tier,
          // Declared beside the tier, never left to the API. See the note above.
          edition: MACHINE[request.size].edition,
          // Regional survives the loss of one zone, at roughly double the cost.
          availabilityType: request.highlyAvailable ? 'REGIONAL' : 'ZONAL',
          backupConfiguration: {
            enabled: request.backupRetentionDays > 0,
            pointInTimeRecoveryEnabled: request.backupRetentionDays > 0,
            backupRetentionSettings: { retainedBackups: request.backupRetentionDays, retentionUnit: 'COUNT' },
          },
          /*
           * On, because off is what makes a working network look broken.
           *
           * Cloud SQL terminates TLS at the instance front end, so a client that
           * fails the handshake never reaches Postgres and Postgres logs
           * nothing. With `log_connections` off by default, *no connection
           * logged* and *no packet arrived* are the same observation — and a
           * reachability problem gets diagnosed as a network one for as long as
           * that holds. This is the flag that separates them.
           */
          databaseFlags: [{ name: 'log_connections', value: 'on' }],
          ipConfiguration: {
            // No public address at all. The only way in is the peering below.
            ipv4Enabled: false,
            privateNetwork: network.network,
            /*
             * What makes the managed Cloud SQL path actually carry traffic.
             *
             * Without it a workload's `/cloudsql/<instance>` socket is present
             * and dead: mounting is not a route, and the built-in proxy's
             * traffic still has to reach the instance over this network. The
             * API here connects to the private address rather than through that
             * socket, but a job or a one-off container that uses the managed
             * integration is the ordinary way to reach this database by hand —
             * and it times out, silently, on an instance without this.
             */
            enablePrivatePathForGoogleCloudServices: true,
            // Refuse an unencrypted client, rather than merely offering TLS.
            sslMode: 'ENCRYPTED_ONLY',
          },
        },
      },
      {
        // The instance cannot take a private address before the peering with
        // Google's service producer exists. `deletionProtection` above refuses
        // an API delete; `protect` refuses one the engine would make.
        dependsOn,
        protect: request.protected,
      },
    )

    const database = new gcp.sql.Database('DatabaseSchema', {
      name: request.name,
      project,
      instance: instance.name,
    })

    /*
     * The password, generated and immediately put out of reach.
     *
     * `$util.secret` marks it so the engine seals it in state; the workload
     * receives the reference and resolves it through `secretKeyRef`. Both
     * halves matter — sealing the state without changing the delivery would
     * still put the password in every revision.
     */
    const password = new random.RandomPassword('DatabasePassword', { length: 32, special: false })
    const secret = new gcp.secretmanager.Secret('DatabasePasswordSecret', {
      project,
      secretId: `${prefix}-db-password`,
      replication: { auto: {} },
    })
    const version = new gcp.secretmanager.SecretVersion('DatabasePasswordValue', {
      secret: secret.id,
      secretData: $util.secret(password.result),
    })

    const user = new gcp.sql.User('DatabaseUser', {
      name: USERNAME,
      project,
      instance: instance.name,
      password: $util.secret(password.result),
    })

    // What makes an account allowed to connect. Attached at the project because
    // that is where Cloud SQL's own role lives; the account it names is one
    // role's alone, so the reach is still one workload's.
    const client = new gcp.projects.IAMMember('DatabaseClient', {
      project,
      role: 'roles/cloudsql.client',
      member: clientAccount.apply((email: string) => `serviceAccount:${email}`),
    })

    return {
      connection: {
        /*
         * The socket the platform's own proxy exposes, not the private address.
         *
         * The address is reachable — a job on this subnet finds 5432 open at it
         * — and connecting to it directly fails anyway: Cloud SQL signs with a
         * CA of its own per instance, `sslMode` refuses an unencrypted client,
         * and the image trusts the public roots, so `pg` gets
         * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. A direct connection therefore needs
         * a certificate fetched, mounted and rotated. The proxy needs none: it
         * authenticates as the workload's own service account and takes a
         * short-lived client certificate per connection, which is exactly what
         * the `cloudsql.client` grant below authorises.
         */
        host: instance.connectionName.apply((connection: string) => `/cloudsql/${connection}`),
        port: $util.output(PORT),
        username: $util.output(USERNAME),
        database: $util.output(request.name),
        // The proxy holds the certificates; the client encrypts nothing itself.
        applicationTls: false,
      },
      binding: {
        cloud: 'gcp',
        // Pinned to the version this deploy created, rather than left to
        // resolve `latest`: a rotation then changes what a running revision
        // reads without the deploy seeing anything. A stored address cannot
        // be pinned — mstage refuses a version on one — so `secret-env.ts`
        // accepts both and resolves an unpinned reference to the latest.
        passwordRef: version.name,
        clientGrant: clientAccount,
        connectionName: instance.connectionName,
      },
      id: instance.id,
      ready: [database, user, version, client],
    }
  }
