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

/** One minute, matching the AWS side's period. */
const PERIOD = '60s'

/*
 * Resource types, and the trap that they are two vocabularies rather than one.
 *
 * A log-based metric is written with a *logging* resource type — what the log
 * entry carried — and an alert policy is filtered with a *monitoring* one. The
 * two overlap enough to look identical and do not coincide:
 * `gce_instance_group_manager` is a perfectly good logging resource and is not
 * a monitored resource descriptor at all, so a policy naming it is refused with
 * `The resource name does not represent a known descriptor`.
 *
 * So each alarm states both, and they are only equal where the two vocabularies
 * happen to agree. Naming the wrong monitoring type is the quiet failure this
 * file exists to avoid — a policy that is accepted and matches nothing.
 */
const CLOUD_RUN = { logging: 'cloud_run_revision', monitoring: 'cloud_run_revision' }

/*
 * The autohealer's repair entries are logged against the group manager, which
 * Monitoring does not know. Logging writes such a series against `global`,
 * which is the descriptor here.
 *
 * UNVERIFIED, deliberately marked: no repair has been emitted on this stage, so
 * this is the documented fallback rather than an observed series. It is the
 * difference between an alarm that fires and one that is merely accepted, and
 * the way to settle it is one measurement — force a repair, then read the
 * series' own resource type — not a second reading of the docs.
 */
const INSTANCE_GROUP = { logging: 'gce_instance_group_manager', monitoring: 'global' }

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

/** One metric and the policy that watches it. */
const watch = ({
  resourceName,
  project,
  metricName,
  resourceType,
  filter,
  threshold,
  description,
  notificationChannels,
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
          duration: `${threshold.periods * 60}s`,
          aggregations: [{ alignmentPeriod: PERIOD, perSeriesAligner: 'ALIGN_DELTA' }],
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
      // The group's own autohealer logs a repair when a host stops answering,
      // which is the closest thing this cloud has to AWS's UnHealthyHostCount.
      resourceType: INSTANCE_GROUP,
      filter: subjects.edge.metricTarget.apply(
        (group: string) =>
          `resource.type="${INSTANCE_GROUP.logging}" AND resource.labels.instance_group_manager_name="${group}" ` +
          'AND jsonPayload.event_type="INSTANCE_REPAIR"',
      ),
      threshold: request.proxyUnhealthyTargets,
      description: 'The box proxy is repairing hosts; boxes may be unreachable',
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
  }
