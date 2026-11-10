/*
 * Alert policies on Cloud Monitoring.
 *
 * The difference from CloudWatch is not the policy, it is the metric. AWS reads
 * counters the workloads publish; Google reads *log-based* metrics, which do
 * not exist until something is told how to extract them. So each alarm here is
 * two resources — the metric that says which log lines count, and the policy
 * that says how many is too many — where the AWS side is one.
 *
 * That is why the shared module carries a threshold and nothing else. A
 * namespace, a dimension and a filter are three different clouds' words for the
 * same idea, and none of them is portable; a contract that named any of them
 * would have named one cloud's.
 *
 * `alignmentPeriod` and the comparison are chosen to match the AWS side's, so
 * an operator reading a page on one cloud is reading the same question on the
 * other: a count over a minute, over the threshold, for this many consecutive
 * periods.
 */

import type { AlarmProvider, AlarmRequest, AlarmSubjects, AlarmThreshold } from '../../alarms.ts'
import { instanceFor } from 'naming'

/** The default window: one minute, matching the AWS side's. */
const DEFAULT_WINDOW_SECONDS = 60

/*
 * Resource types, and the trap that they are two vocabularies rather than one.
 *
 * A log-based metric is written with a *logging* resource type — what the log
 * entry carried — and an alert policy is filtered with a *monitoring* one. The
 * two overlap enough to look identical and do not coincide:
 * The old VM autohealer logged against `gce_instance_group_manager`, which is
 * not a monitored resource descriptor at all. GKE's standalone NEG health
 * transitions use `gce_network_endpoint_group` in both vocabularies.
 *
 * So each alarm states both, and they are only equal where the two vocabularies
 * happen to agree. Naming the wrong monitoring type is the quiet failure this
 * file exists to avoid — a policy that is accepted and matches nothing.
 */
const CLOUD_RUN = { logging: 'cloud_run_revision', monitoring: 'cloud_run_revision' }

const NETWORK_ENDPOINT_GROUP = {
  logging: 'gce_network_endpoint_group',
  monitoring: 'gce_network_endpoint_group',
}

/**
 * What one alert policy watches: its own metric, and its own workload's kind.
 *
 * Monitoring will not take a condition without a `resource.type` restriction —
 * *"must specify a restriction on resource.type in the filter"*, as a 400 — so
 * the clause is not optional and cannot simply be dropped. What can be wrong is
 * *which* kind it names: the clause only scopes aggregation, and naming the kind
 * some other workload happens to be silently matches nothing. That is an alarm
 * that has gone quiet with nothing failing, which reads exactly like nothing
 * being wrong.
 *
 * So the kind is the caller's, taken from the same value that selects the log
 * lines the metric counts. One source for both, because two would be two things
 * to keep in step and only one of them fails loudly.
 */
export const alertPolicyFilter = ({ metricName, resourceType }: { metricName: string; resourceType: string }): string =>
  `metric.type="logging.googleapis.com/user/${metricName}" AND resource.type="${resourceType}"`

/**
 * One metric and the policy that watches it.
 *
 * The window is a per-alarm answer, not a module constant: an alarm's three
 * numbers (threshold, periods, window) only mean something together, and the
 * disk alarms watch processes whose failure cadence is set by the control
 * plane's own cron rather than by request traffic.
 */
const watch = ({
  resourceName,
  project,
  metricName,
  resourceType,
  filter,
  threshold,
  description,
  notificationChannels,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
}: {
  resourceName: string
  project: string
  metricName: string
  /**
   * The two names for where this alarm's log lines come from: the logging
   * resource the metric selects on, and the monitored resource the policy
   * filters on. Both, because they are not always the same word.
   */
  resourceType: { logging: string; monitoring: string }
  /** Which log entries count. Google's own logging filter syntax. */
  filter: $util.Input<string>
  threshold: AlarmThreshold
  description: string
  notificationChannels: string[]
  /**
   * How long one aggregation window runs, in seconds. The default is the one
   * minute every request-driven alarm here shares; an alarm whose signal is
   * paced by the control plane's cron — at most one failure line per runner
   * per round — states its own longer window, because "three strikes" has to
   * be counted over the stretch those strikes actually arrive in.
   */
  windowSeconds?: number
}): any[] => {
  const metric = new gcp.logging.Metric(`${resourceName}Metric`, {
    name: metricName,
    project,
    filter,
    metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64' },
  })
  const policy = new gcp.monitoring.AlertPolicy(resourceName, {
    project,
    displayName: description,
    combiner: 'OR',
    conditions: [
      {
        displayName: description,
        conditionThreshold: {
          filter: metric.name.apply((name: string) => alertPolicyFilter({ metricName: name, resourceType: resourceType.monitoring })),
          comparison: 'COMPARISON_GT',
          // One below the threshold with a strict comparison, so "at least N"
          // means the same thing here as CloudWatch's GreaterThanOrEqual.
          thresholdValue: threshold.threshold - 1,
          duration: `${threshold.periods * windowSeconds}s`,
          aggregations: [{ alignmentPeriod: `${windowSeconds}s`, perSeriesAligner: 'ALIGN_DELTA' }],
        },
      },
    ],
    notificationChannels,
  })
  return [metric, policy]
}

export const gcpAlarmProvider =
  ({
    subjects,
    project,
    notificationChannels = [],
  }: {
    subjects: AlarmSubjects
    project: string
    /** Where a firing policy is sent. Empty is a policy that only shows in the console. */
    notificationChannels?: string[]
  }): AlarmProvider =>
  (request: AlarmRequest): void => {
    watch({
      resourceName: 'ApiServerErrorAlarm',
      project,
      metricName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-5xx' }),
      resourceType: CLOUD_RUN,
      filter: subjects.api.metricTarget.apply(
        (service: string) =>
          `resource.type="${CLOUD_RUN.logging}" AND resource.labels.service_name="${service}" AND httpRequest.status>=500`,
      ),
      threshold: request.apiServerErrors,
      description: 'The control plane is answering 5xx',
      notificationChannels,
    })

    watch({
      resourceName: 'ProxyUnhealthyTargetAlarm',
      project,
      metricName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy-unhealthy' }),
      // `ProxyHealthCheck` enables transition logging. Its resource label is
      // the standalone NEG's numeric id, so another stage cannot contribute.
      resourceType: NETWORK_ENDPOINT_GROUP,
      filter: subjects.edge.metricTarget.apply(
        (negId: string) =>
          `logName="projects/${project}/logs/compute.googleapis.com%2Fhealthchecks" ` +
          `AND resource.type="${NETWORK_ENDPOINT_GROUP.logging}" ` +
          `AND resource.labels.network_endpoint_group_id="${negId}" ` +
          'AND jsonPayload.healthCheckProbeResult.healthState="UNHEALTHY"',
      ),
      threshold: request.proxyUnhealthyTargets,
      description: 'The box proxy has an unhealthy GKE network endpoint',
      notificationChannels,
    })

    watch({
      resourceName: 'RunnerUnreachableAlarm',
      project,
      metricName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner-unreachable' }),
      // Emitted by the control plane, not by the runner: a host that has gone
      // silent cannot report that it has.
      resourceType: CLOUD_RUN,
      filter: subjects.api.metricTarget.apply(
        (service: string) =>
          `resource.type="${CLOUD_RUN.logging}" AND resource.labels.service_name="${service}" ` +
          'AND jsonPayload.event="runner.unreachable"',
      ),
      threshold: request.runnersUnreachable,
      description: 'A registered runner has stopped answering the control plane',
      notificationChannels,
    })

    /*
     * Disk expansion failing, logged by the control plane at error level: a
     * rate-limit refusal, an operation that FAILED, a grow whose filesystem
     * never confirmed. The alarm is the only notice a quiet failure gets —
     * the resize itself succeeds or silences, and neither reports anywhere.
     *
     * The attributes travel as pino-merged keys, so the event name and the
     * result are dotted keys inside the JSON payload, quoted as the logging
     * query language requires.
     */
    watch({
      resourceName: 'RunnerDiskExpansionFailingAlarm',
      project,
      metricName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner-disk-expansion-failing' }),
      resourceType: CLOUD_RUN,
      filter: subjects.api.metricTarget.apply(
        (service: string) =>
          `resource.type="${CLOUD_RUN.logging}" AND resource.labels.service_name="${service}" ` +
          'AND jsonPayload."event.name"="runner.disk_expansion" AND severity>=ERROR',
      ),
      threshold: request.runnersDiskExpansionFailing,
      description: 'Runner data-disk expansions are failing',
      notificationChannels,
      /*
       * A quarter-hour window, not the default minute. The expansion loop is
       * paced by the control plane's cron: at most one attempt — so one
       * failure line — per runner per round. Over the default minute a single
       * runner failing on every round never reaches the threshold, which is
       * exactly the steady failure this alarm exists to announce. Three
       * failures inside one quarter-hour window is the design's own sentence
       * (≈15min 内 ≥3 次), and {threshold: 3, periods: 1} over 900s spells it.
       */
      windowSeconds: 900,
    })

    /*
     * A runner at critical disk pressure, logged by the control plane from
     * every healthcheck that reports one — the stage before the expansion
     * that was supposed to have caught it. Each critical runner contributes
     * one line per heartbeat, so a count over one minute answers "is any
     * runner critical right now", and the threshold is the fewest lines that
     * can say yes.
     */
    watch({
      resourceName: 'RunnerDiskPressureCriticalAlarm',
      project,
      metricName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner-disk-pressure-critical' }),
      resourceType: CLOUD_RUN,
      filter: subjects.api.metricTarget.apply(
        (service: string) =>
          `resource.type="${CLOUD_RUN.logging}" AND resource.labels.service_name="${service}" ` +
          'AND jsonPayload."event.name"="runner.disk_pressure" ' +
          'AND jsonPayload."disk.pressure_level"="critical"',
      ),
      threshold: request.runnersDiskPressureCritical,
      description: 'A runner is at critical data-disk usage',
      notificationChannels,
    })
  }
