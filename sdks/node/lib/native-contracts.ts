import type { CopyOptions } from "./copy.js";

/**
 * Checked-in TypeScript contracts for the native N-API module.
 *
 * The generated declarations under `sdks/node/native/` are build artifacts and
 * are intentionally not part of the checked-in TypeScript dependency graph.
 */

export interface ImageInfo {
  reference: string;
  repository: string;
  tag: string;
  id: string;
  cachedAt: string;
  sizeBytes?: number;
}

export interface ImagePullResult {
  reference: string;
  configDigest: string;
  layerCount: number;
}

export interface ImageHandle {
  pull(reference: string): Promise<ImagePullResult>;
  list(): Promise<ImageInfo[]>;
}

export interface JsEnvVar {
  key: string;
  value: string;
}

export interface JsVolumeSpec {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
}

export interface JsNetworkSpec {
  mode: "enabled" | "disabled";
  allowNet?: string[];
}

export interface JsPortSpec {
  hostPort?: number;
  guestPort: number;
  protocol?: string;
  hostIp?: string;
}

export interface JsSecret {
  name: string;
  value: string;
  hosts?: string[];
  placeholder?: string;
}

export interface JsSecurityOptions {
  jailerEnabled?: boolean;
  seccompEnabled?: boolean;
  maxOpenFiles?: number;
  maxFileSize?: number;
  maxProcesses?: number;
  maxMemory?: number;
  maxCpuTime?: number;
  networkEnabled?: boolean;
  closeFds?: boolean;
}

export interface JsHealthCheckOptions {
  interval: number;
  timeout: number;
  retries: number;
  startPeriod: number;
}

export interface JsBoxOptions {
  image?: string;
  rootfsPath?: string;
  cpus?: number;
  memoryMib?: number;
  diskSizeGb?: number;
  workingDir?: string;
  env?: JsEnvVar[];
  volumes?: JsVolumeSpec[];
  network?: JsNetworkSpec;
  ports?: JsPortSpec[];
  autoRemove?: boolean;
  detach?: boolean;
  entrypoint?: string[];
  cmd?: string[];
  user?: string;
  security?: JsSecurityOptions;
  healthCheck?: JsHealthCheckOptions;
  secrets?: JsSecret[];
}

export interface JsOptions {
  homeDir?: string;
  imageRegistries?: JsImageRegistry[];
}

export interface JsImageRegistryAuth {
  username?: string;
  password?: string;
  bearerToken?: string;
}

export interface JsImageRegistry {
  host: string;
  transport?: "https" | "http";
  skipVerify?: boolean;
  search?: boolean;
  auth?: JsImageRegistryAuth;
}

/** A bearer token plus its expiry. `expiresAt` is epoch seconds, or
 *  `null` for non-expiring tokens (e.g. API keys). */
export interface JsAccessToken {
  token: string;
  expiresAt?: number | null;
}

/** Native API-key credential class. Concrete implementation of the
 *  `Credential` interface (see ./credential). */
export interface ApiKeyCredential {
  getToken(): JsAccessToken;
}

export interface ApiKeyCredentialConstructor {
  new (key: string): ApiKeyCredential;
  /** Build from `BOXLITE_API_KEY`; returns `null` when unset/empty. */
  fromEnv(): ApiKeyCredential | null;
}

export type JsHealthState = "None" | "Starting" | "Healthy" | "Unhealthy";

export interface JsHealthStatus {
  state: JsHealthState;
  failures: number;
  lastCheck?: string;
}

export interface JsBoxStateInfo {
  status: string;
  running: boolean;
  pid?: number;
}

export interface JsBoxInfo {
  id: string;
  name?: string;
  state: JsBoxStateInfo;
  createdAt: string;
  image: string;
  cpus: number;
  memoryMib: number;
  healthStatus: JsHealthStatus;
}

export interface JsRuntimeMetrics {
  boxesCreatedTotal: number;
  boxesFailedTotal: number;
  numRunningBoxes: number;
  totalCommandsExecuted: number;
  totalExecErrors: number;
}

export interface JsBoxMetrics {
  commandsExecutedTotal: number;
  execErrorsTotal: number;
  bytesSentTotal: number;
  bytesReceivedTotal: number;
  totalCreateDurationMs?: number;
  guestBootDurationMs?: number;
  cpuPercent?: number;
  memoryBytes?: number;
  networkBytesSent?: number;
  networkBytesReceived?: number;
  networkTcpConnections?: number;
  networkTcpErrors?: number;
  stageFilesystemSetupMs?: number;
  stageImagePrepareMs?: number;
  stageGuestRootfsMs?: number;
  stageBoxConfigMs?: number;
  stageBoxSpawnMs?: number;
  stageContainerInitMs?: number;
}

export interface JsExecResult {
  exitCode: number;
  errorMessage?: string;
}

export interface JsExecStdout {
  next(): Promise<string | null>;
}

export interface JsExecStderr {
  next(): Promise<string | null>;
}

export interface JsExecStdin {
  write(data: Buffer): Promise<void>;
  writeString(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface JsExecution {
  id(): Promise<string>;
  stdin(): Promise<JsExecStdin>;
  stdout(): Promise<JsExecStdout>;
  stderr(): Promise<JsExecStderr>;
  wait(): Promise<JsExecResult>;
  kill(): Promise<void>;
  resizeTty(rows: number, cols: number): Promise<void>;
  signal(signal: number): Promise<void>;
}

export interface JsSnapshotInfo {
  id: string;
  boxId: string;
  name: string;
  createdAt: number;
  containerDiskBytes: number;
  sizeBytes: number;
}

export type JsSnapshotOptions = Record<string, never>;

export interface JsSnapshotHandle {
  create(
    name: string,
    options?: JsSnapshotOptions | null,
  ): Promise<JsSnapshotInfo>;
  list(): Promise<JsSnapshotInfo[]>;
  get(name: string): Promise<JsSnapshotInfo | null>;
  remove(name: string): Promise<void>;
  restore(name: string): Promise<void>;
}

export type JsCloneOptions = Record<string, never>;

export type JsExportOptions = Record<string, never>;

export interface JsBox {
  readonly id: string;
  readonly name: string | null;
  info(): JsBoxInfo;
  exec(
    command: string,
    args?: string[] | null,
    env?: Array<[string, string]> | null,
    tty?: boolean | null,
    user?: string | null,
    timeoutSecs?: number | null,
    workingDir?: string | null,
  ): Promise<JsExecution>;
  readonly snapshot: JsSnapshotHandle;
  cloneBox(
    options?: JsCloneOptions | null,
    name?: string | null,
  ): Promise<JsBox>;
  export(dest: string, options?: JsExportOptions | null): Promise<string>;
  start(): Promise<void>;
  stop(): Promise<void>;
  metrics(): Promise<JsBoxMetrics>;
  copyIn(
    hostPath: string,
    containerDest: string,
    options?: CopyOptions | null,
  ): Promise<void>;
  copyOut(
    containerSrc: string,
    hostDest: string,
    options?: CopyOptions | null,
  ): Promise<void>;
}

export interface JsGetOrCreateResult {
  readonly created: boolean;
  readonly box: JsBox;
}

export interface JsBoxlite {
  importBox(archivePath: string, name?: string | null): Promise<JsBox>;
  create(options: JsBoxOptions, name?: string | null): Promise<JsBox>;
  getOrCreate(
    options: JsBoxOptions,
    name?: string | null,
  ): Promise<JsGetOrCreateResult>;
  listInfo(): Promise<JsBoxInfo[]>;
  getInfo(idOrName: string): Promise<JsBoxInfo | null>;
  get(idOrName: string): Promise<JsBox | null>;
  metrics(): Promise<JsRuntimeMetrics>;
  readonly images: ImageHandle;
  remove(idOrName: string, force?: boolean | null): Promise<void>;
  close(): void;
  shutdown(timeout?: number | null): Promise<void>;
}

export interface JsBoxliteConstructor {
  new (options: JsOptions): JsBoxlite;
  withDefaultConfig(): JsBoxlite;
  initDefault(options: JsOptions): void;
  /** Connect to a remote BoxLite REST server.
   *  Positional `(url, credential?, prefix?)`. */
  rest(
    url: string,
    credential?: ApiKeyCredential | null,
    prefix?: string | null,
  ): JsBoxlite;
}

export interface NativeModule {
  JsBoxlite: JsBoxliteConstructor;
  ApiKeyCredential: ApiKeyCredentialConstructor;
  [key: string]: unknown;
}
