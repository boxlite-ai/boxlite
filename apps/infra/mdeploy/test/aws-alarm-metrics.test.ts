import assert from 'node:assert/strict'
import test from 'node:test'
import { awsAlarmProvider } from '../stack/providers/aws/alarms.ts'

test('AWS application alarms consume extracted metrics from this API log group', () => {
  const declarations: { kind: string; name: string; args: any }[] = []
  const resource = (kind: string) =>
    class {
      constructor(name: string, args: any) {
        declarations.push({ kind, name, args })
      }
    }
  Object.assign(globalThis, {
    $app: { name: 'fixture-app', stage: 'dev' },
    aws: { cloudwatch: { MetricAlarm: resource('alarm'), LogMetricFilter: resource('filter') } },
  })
  awsAlarmProvider({
    subjects: {
      api: { metricTarget: 'alb-fixture', metricLogGroup: 'api-fixture-logs' },
      edge: { metricTarget: 'nlb-fixture' },
      runners: {},
    } as any,
  })({
    apiServerErrors: { threshold: 1, periods: 1 },
    proxyUnhealthyTargets: { threshold: 1, periods: 1 },
    runnersUnreachable: { threshold: 1, periods: 1 },
    runnersDiskExpansionFailing: { threshold: 3, periods: 1 },
    runnersDiskPressureCritical: { threshold: 1, periods: 1 },
  })
  const application = declarations.filter((item) => item.kind === 'alarm' && item.name.startsWith('Runner'))
  const extracted = declarations.filter((item) => item.kind === 'filter')
  assert.deepEqual(
    extracted.map((item) => item.args.metricTransformation.name).sort(),
    application.map((item) => item.args.metricName).sort(),
    'AWS alarms have no log-to-metric publisher for the counters they consume',
  )
  for (const filter of extracted) {
    assert.equal(filter.args.logGroupName, 'api-fixture-logs')
    assert.equal(filter.args.metricTransformation.namespace, 'BoxLite/fixture-app/dev')
    assert.equal(filter.args.metricTransformation.value, '1')
    assert.equal(filter.args.metricTransformation.defaultValue, '0')
    const alarm = application.find((item) => item.args.metricName === filter.args.metricTransformation.name)!
    assert.equal(alarm.args.namespace, filter.args.metricTransformation.namespace)
  }
  const failing = extracted.find((item) => item.args.metricTransformation.name === 'RunnerDiskExpansionFailing')!
  assert.match(failing.args.pattern, /runner\.disk_expansion/)
  assert.match(failing.args.pattern, /level >= 50/)
  const critical = extracted.find((item) => item.args.metricTransformation.name === 'RunnerDiskPressureCritical')!
  assert.match(critical.args.pattern, /runner\.disk_pressure/)
  assert.match(critical.args.pattern, /critical/)
})
