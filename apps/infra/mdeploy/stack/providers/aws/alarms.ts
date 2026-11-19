/**
 * Load-balancer signals come from AWS; application signals are extracted from
 * the API's raw JSON logs. Each app/stage has its own metric namespace.
 */

import type { AlarmProvider, AlarmRequest, AlarmSubjects, AlarmThreshold } from '../../alarms.ts'

/** The default window: one minute, which is the finest a standard metric is published at. */
const DEFAULT_PERIOD_SECONDS = 60

/** App/stage isolation for metrics extracted from API log events. */
const applicationNamespace = () => `BoxLite/${$app.name}/${$app.stage}`

const alarm = (
  name: string,
  threshold: AlarmThreshold,
  spec: Record<string, unknown>,
  periodSeconds = DEFAULT_PERIOD_SECONDS,
): CloudResource =>
  new aws.cloudwatch.MetricAlarm(name, {
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    threshold: threshold.threshold,
    evaluationPeriods: threshold.periods,
    period: periodSeconds,
    // Silence is not a breach. See the note above.
    treatMissingData: 'notBreaching',
    ...spec,
  })

export const awsAlarmProvider =
  ({ subjects }: { subjects: AlarmSubjects }): AlarmProvider =>
  (request: AlarmRequest): void => {
    if (!subjects.api.metricLogGroup) throw new Error('AWS application alarms require the API CloudWatch log group')
    const signals = [
      ['RunnerUnreachable', '{ $.event = "runner.unreachable" }'],
      ['RunnerDiskExpansionFailing', `{ $.['event.name'] = "runner.disk_expansion" && $.level >= 50 }`],
      [
        'RunnerDiskPressureCritical',
        `{ $.['event.name'] = "runner.disk_pressure" && $.['disk.pressure_level'] = "critical" }`,
      ],
    ]
    for (const [name, pattern] of signals)
      new aws.cloudwatch.LogMetricFilter(name + 'Metric', {
        logGroupName: subjects.api.metricLogGroup,
        pattern,
        metricTransformation: { name, namespace: applicationNamespace(), value: '1', defaultValue: '0', unit: 'Count' },
      })

    alarm('ApiServerErrorAlarm', request.apiServerErrors, {
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      statistic: 'Sum',
      alarmDescription: 'The control plane is answering 5xx',
      // Dimensioned on the load balancer rather than on the target group: a
      // deploy replaces the group, and an alarm pointed at the old one goes
      // quiet exactly when a rollout is most likely to be the cause.
      dimensions: { LoadBalancer: subjects.api.metricTarget },
    })

    alarm('ProxyUnhealthyTargetAlarm', request.proxyUnhealthyTargets, {
      namespace: 'AWS/NetworkELB',
      metricName: 'UnHealthyHostCount',
      statistic: 'Maximum',
      alarmDescription: 'The box proxy has no healthy target; every running box is unreachable',
      dimensions: { LoadBalancer: subjects.edge.metricTarget },
    })

    alarm('RunnerUnreachableAlarm', request.runnersUnreachable, {
      namespace: applicationNamespace(),
      metricName: 'RunnerUnreachable',
      statistic: 'Maximum',
      alarmDescription: 'A registered runner has stopped answering the control plane',
    })

    /*
     * Both disk alarms read metrics extracted from control-plane log
     * lines (`RunnerUnreachable`'s shape, and for the same reason): expansion
     * failures and critical pressure happen on hosts the alarms cannot reach,
     * so the API that hears about them is what publishes them. The metrics
     * arrive with the API task; the alarm existing first is what keeps a
     * failure discovered in staging from being one nobody was listening for.
     */
    alarm(
      'RunnerDiskExpansionFailingAlarm',
      request.runnersDiskExpansionFailing,
      {
        namespace: applicationNamespace(),
        metricName: 'RunnerDiskExpansionFailing',
        statistic: 'Sum',
        alarmDescription: 'Runner data-disk expansions are failing',
      },
      /*
       * A quarter-hour window, matching the GCP side: the expansion loop is
       * paced by the control plane's cron, so a single runner failing on
       * every round produces one line a minute and never reaches a per-minute
       * threshold. Three failures inside one 900-second window —
       * `{threshold: 3, periods: 1}` — is the design's "≈15min 内 ≥3 次".
       */
      900,
    )

    alarm('RunnerDiskPressureCriticalAlarm', request.runnersDiskPressureCritical, {
      namespace: applicationNamespace(),
      metricName: 'RunnerDiskPressureCritical',
      statistic: 'Sum',
      alarmDescription: 'A runner is at critical data-disk usage',
    })
  }
