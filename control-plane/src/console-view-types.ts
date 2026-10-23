/** The console's view types: the shapes of the dashboard's lib/apps/types.ts, as the console API returns them. */
import type { ConsoleMetrics } from './console-access.js';
import type { ActivityView } from './console-activity.js';
import type { AuthStatusView } from './console-enduser.js';
import type { Deployment } from './db.js';

export type ConsoleStatus = 'draft' | 'building' | 'live' | 'degraded' | 'sleeping' | 'failed';
export type Access = 'private' | 'org' | 'public';

export interface LastDeployView {
  releaseId: string;
  at: string;
  by: string;
}

export interface AppSummaryView {
  id: string;
  name: string;
  slug: string;
  /** The env's own origin, as the CP serves it (resources.appUrl); exists from creation. */
  url: string;
  visibility: Access;
  status: ConsoleStatus;
  lastDeploy: LastDeployView | null;
  resources: { database: boolean; storage: number; users: null };
  createdAt: string;
  environments: number;
  attention?: string;
  /** While main deploys: "Deploying #4 · build". */
  progress?: string;
  /** main's last screenshot, for the App list (null until one is taken). */
  previewSrc?: string | null;
  /** Other environments with a live deployment, so a list row whose main has none can say where it runs. */
  liveIn?: string[];
}

export interface EnvironmentSummaryView {
  name: string;
  status: ConsoleStatus;
  url: string;
  box: string | null;
  lastDeploy: LastDeployView | null;
  from: string | null;
}

export interface ServiceView {
  name: string;
  command: string[];
  exposed: boolean;
  port?: number;
  healthPath?: string;
  staticDir?: string;
  state: string;
  pid?: number;
  restarts: number;
  lastExitCode?: number;
  health: string;
  /** The service's last error lines, when it is crashing, restarting or unhealthy. */
  recentErrors: string[];
}

export interface ScheduleView {
  name: string;
  cron: string;
  target: string;
  /** null while nothing is live (schedules only run against a live release). */
  nextRun: string | null;
  lastRun: string | null;
  /** HTTP status of the last run. */
  lastStatus: number | null;
}

export interface ReleaseView {
  id: string;
  number: number;
  summary: string;
  createdAt: string;
  finishedAt: string | null;
  by: string;
  status: Deployment['status'];
  current: boolean;
  error?: string;
  steps: Deployment['steps'];
  changes: string[];
  files: number | null;
  bytes: number | null;
  buildSeconds: number | null;
  hasSource: boolean;
  rollback: { possible: boolean; reason?: string };
  restorePoint: string | null;
  startedAt: string | null;
  /** The step running now and since when, while the deployment is in progress. */
  running: { name: string; detail?: string; since: string | null } | null;
  /** For a failed deployment: the classified cause, in a line. */
  cause: string | null;
}

export interface DatabaseSummaryView {
  status: 'ready';
  engine: string;
  host: string;
  name: string;
  user: string;
  branch: string | null;
  injectedAs: string;
  injectedInto: string[];
}

export interface VolumeView {
  name: string;
  mountPath: string;
  mode: string;
  volumeName: string;
  volumeId: string | null;
  sizeBytes: number | null;
  state: string | null;
}

export interface SecretRefView {
  name: string;
  from: string;
  inject: 'env';
  usedBy: string[];
  /** false when the org secret it names has been deleted since. */
  present: boolean;
}

export interface ProblemView {
  summary: string;
  detail: string;
  fixPrompt?: string;
  /** The failed deployment this problem is about. */
  deployment?: number;
  /** What still serves users, when something does. */
  serving?: string;
  /** The variable the service says it is missing ("SLACK_TOKEN is not set"); the owner can set it in the console. */
  missingVariable?: string;
}

export interface AppDetailView extends Omit<AppSummaryView, 'environments'> {
  /** The CP's own id of the App (app_…), for support; `id` is the name the console routes by. */
  appId: string;
  environment: string;
  createdFrom: string | null;
  runtime: { image: string; size: string; cpus: number | null; memoryMib: number | null } | null;
  box: { id: string; state: string } | null;
  services: ServiceView[];
  activeRelease: string | null;
  releases: ReleaseView[];
  activity: ActivityView[];
  database: DatabaseSummaryView | null;
  storages: VolumeView[];
  secrets: SecretRefView[];
  /** [variables] of the latest spec; null before the first apply/deploy (nothing to edit yet). */
  variables: Record<string, string> | null;
  platformVariables: { name: string; value: string; kind: string }[];
  problems: ProblemView[];
  statusDetail: string | null;
  /** The deployment in progress, for the header's live line. */
  deploying: { id: string; number: number; step: string | null; detail: string | null; since: string } | null;
  schedules: ScheduleView[];
  /** [variables] of the live release; differs from `variables` while a change is being deployed. */
  liveVariables: Record<string, string> | null;
  metrics: ConsoleMetrics | null;
  /** The last screenshot of the live URL (preview.ts); `src` is relative to the console API. */
  preview: { src: string; capturedAt: string; releaseId: string } | null;
  handoffPrompt: string;
  key: { last4: string; createdAt: string } | null;
  accessSource: 'manifest' | 'online';
  specVersion: number | null;
  auth: AuthStatusView;
}
