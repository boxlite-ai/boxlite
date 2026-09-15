/*
 * What the control plane needs from a managed PostgreSQL, described without
 * naming a cloud.
 *
 * The request below says what has to be true — a database of this size, backed
 * up this long, refusing deletion on a protected stage. It deliberately does
 * not say `t4g.micro`, `db-f1-micro`, Secrets Manager or Secret Manager: those
 * are answers, and each cloud answers differently.
 *
 * What comes back is split in two. `connection` is portable — a host, a port, a
 * user, a database name — and every consumer may read it. `binding` is the part
 * that cannot be made portable, and is therefore made *visible*: a tagged union,
 * so a caller reaching into the AWS member is written down as AWS-specific at
 * the call site rather than hidden behind an abstraction that would leak anyway.
 * Adding a second cloud adds a member, and every site that has not handled it
 * stops compiling.
 */

export type DatabaseSize = 'small' | 'medium'

export type DatabaseRequest = {
  /** The logical database inside the server. */
  name: string
  size: DatabaseSize
  /** Survive the loss of one availability zone. Costs roughly double. */
  highlyAvailable: boolean
  backupRetentionDays: number
  /** Refuse deletion, and keep a final snapshot if it is deleted anyway. */
  protected: boolean
}

/** Everything a client needs except the password, which is never a value here. */
export type DatabaseConnection = {
  /**
   * A hostname, or a Unix socket directory when it begins with `/`.
   *
   * `pg` reads the second form as a socket, which is how a Cloud Run workload
   * reaches Cloud SQL through the proxy the platform builds in.
   */
  host: $util.Output<string>
  port: $util.Output<string>
  username: $util.Output<string>
  database: $util.Output<string>
  /**
   * Whether the *client* encrypts, which is not the same as whether the
   * connection is encrypted.
   *
   * RDS presents a certificate chaining to a root the image already trusts, so
   * the client does the encrypting and this is true. Cloud SQL signs with a CA
   * of its own per instance, and a client that verifies against the public
   * trust store gets `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — so a GCP workload
   * connects through the platform's proxy instead, which authenticates as the
   * workload's own service account and takes a short-lived client certificate
   * per connection. The traffic is encrypted either way; only who encrypts it
   * differs, and this is that.
   */
  applicationTls: boolean
}

/**
 * The cloud-specific half.
 *
 * Both members carry the same two ideas, and neither value is interchangeable —
 * which is exactly why the tag is here instead of a shared string type. A
 * Secrets Manager ARN handed to Cloud Run resolves to nothing, and a security
 * group is not something a Cloud Run service can be given at all.
 *
 * `passwordRef` is how a workload is *given* the password rather than the
 * password itself. `clientGrant` is the identity that marks a workload as
 * allowed to connect, attached at the workload rather than granted at the
 * database.
 */
export type DatabaseBinding =
  | {
      cloud: 'aws'
      /** A Secrets Manager ARN the ECS agent resolves before the container starts. */
      passwordRef: $util.Output<string>
      /** A security group id, attached through a service's `securityGroups`. */
      clientGrant: $util.Output<string>
    }
  | {
      cloud: 'gcp'
      /**
       * A Secret Manager reference Cloud Run resolves through `secretKeyRef`.
       *
       * `projects/<p>/secrets/<s>`, or that with `/versions/<v>` when the
       * provider pinned one. `providers/gcp/secret-env.ts` splits either into
       * the two fields Cloud Run wants and is the only place that does.
       */
      passwordRef: $util.Output<string>
      /** A service account email, attached through a service's `serviceAccount`. */
      clientGrant: $util.Output<string>
      /**
       * `<project>:<region>:<instance>`, which a Cloud Run workload mounts to
       * get the proxy's socket. On AWS there is nothing to mount: the client
       * opens a TCP connection to a host and there is no platform in between.
       */
      connectionName: $util.Output<string>
    }

export type Database = {
  connection: DatabaseConnection
  binding: DatabaseBinding
  id: $util.Output<string>
  /** Hand to `dependsOn`: nothing may touch the database before these exist. */
  ready: any[]
}

/** One per cloud. The stack picks it once and never asks again. */
export type DatabaseProvider = (request: DatabaseRequest) => Database

/**
 * The name the API reads the password under.
 *
 * Here rather than in `databaseEnvironment` below because the password is never
 * a value in an environment: each provider hands `binding.passwordRef` to its
 * cloud under this name. Declared once all the same — the composition root has
 * to know it to refuse a store that names the same variable.
 */
export const DATABASE_PASSWORD_VARIABLE = 'DB_PASSWORD'

/**
 * The environment a workload reads to reach this database.
 *
 * The names are `apps/api`'s own (`configuration.ts`), so a rename there is one
 * edit here rather than a hunt through providers. The password is not among
 * them: it arrives through `binding`, by reference.
 */
export const databaseEnvironment = (database: Database): Record<string, $util.Input<string>> => ({
  DB_HOST: database.connection.host,
  DB_PORT: database.connection.port,
  DB_USERNAME: database.connection.username,
  DB_DATABASE: database.connection.database,
  /*
   * Derived from the connection rather than set per provider: the two are one
   * decision, and a socket host with the client still encrypting is a container
   * that cannot start. A plain string, not an output — nothing about it is
   * discovered while the stack runs, and an `Input` is what the consumer takes.
   */
  DB_TLS_ENABLED: String(database.connection.applicationTls),
})
