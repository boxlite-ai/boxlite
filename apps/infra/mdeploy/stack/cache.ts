/*
 * The transient cache the control plane keeps its queues and sessions in.
 *
 * Shaped like the database and deliberately smaller. There is no backup
 * retention here and no protection flag, because there is nothing in it worth
 * keeping: a cache that is lost is refilled, which is the property that lets a
 * stage be torn down without a snapshot.
 *
 * The one thing worth saying twice is that the password is a reference on both
 * clouds and a value on neither. ElastiCache and Memorystore both mint one, and
 * both put it somewhere a workload is granted rather than handed — so nothing
 * about the shape here changes between them even though the resources do.
 */

export type CacheSize = 'small' | 'medium'

export type CacheRequest = {
  size: CacheSize
  /** More than one node. Off is one node, which is what a cache usually wants. */
  clustered: boolean
  /** Refuse plaintext on the wire. On everywhere; here to be refused loudly. */
  encryptInTransit: boolean
}

export type CacheConnection = {
  host: $util.Output<string>
  port: $util.Output<string>
}

export type CacheBinding =
  | { cloud: 'aws'; passwordRef: $util.Output<string>; clientGrant: $util.Output<string> }
  | {
      cloud: 'gcp'
      passwordRef: $util.Output<string>
      clientGrant: $util.Output<string>
      /**
       * A Secret Manager reference holding the instance's own CA certificate.
       *
       * Memorystore's transit encryption presents a certificate signed per
       * instance, which no image trusts — the same shape as Cloud SQL's. Unlike
       * Cloud SQL there is no platform proxy to hand the problem to, so the
       * certificate itself has to reach the container, and it reaches it as a
       * mounted file rather than as a value.
       */
      caRef: $util.Output<string>
    }

export type Cache = {
  connection: CacheConnection
  binding: CacheBinding
  id: $util.Output<string>
  ready: any[]
}

export type CacheProvider = (request: CacheRequest) => Cache

/** The name the API reads the cache password under (`apps/api` configuration.ts). */
export const CACHE_PASSWORD_VARIABLE = 'REDIS_PASSWORD'

/**
 * The environment a workload reads to reach this cache.
 *
 * `REDIS_TLS` is decided here rather than by the caller: `encryptInTransit` is
 * a request the provider has already had to honour, and a client told to speak
 * plaintext to a server that refuses it fails at the first command with an
 * error about the protocol rather than about the setting.
 */
export const cacheEnvironment = (cache: Cache): Record<string, $util.Output<string> | string> => ({
  REDIS_HOST: cache.connection.host,
  REDIS_PORT: cache.connection.port,
  REDIS_TLS: 'true',
  /*
   * Where Node finds a CA the image does not ship with, on the cloud that needs
   * one. Derived from the binding for the same reason `DB_TLS_ENABLED` is
   * derived from the connection: the module that knows the certificate is the
   * module that should say so, and a second place deciding is a second place to
   * disagree.
   *
   * Set only where the file is actually mounted — pointing this at a path that
   * does not exist makes Node refuse to start, so an unconditional value would
   * break the cloud that needs nothing.
   */
  ...(cache.binding.cloud === 'gcp' ? { NODE_EXTRA_CA_CERTS: CACHE_CA_PATH } : {}),
})

/**
 * Where a workload finds the CA that signs its cache's certificate.
 *
 * A path rather than a value, and `NODE_EXTRA_CA_CERTS` rather than a setting
 * of the client's: `apps/api` builds its Redis TLS options as a bare `tls: {}`
 * (`config/configuration.ts`) and has nowhere to put a CA. Node reads this
 * variable and *adds* what it finds to the default trust store, so the client
 * verifies without knowing anything new — which is the difference between an
 * infrastructure change and an application one.
 */
export const CACHE_CA_PATH = '/etc/ssl/boxlite/cache-ca.pem'
