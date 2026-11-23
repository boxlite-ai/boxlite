/** Record real provider arguments without contacting a cloud or evaluating Pulumi. */
export const recordServices = (app: string, stage: string, build: () => void) => {
  const globals = globalThis as Record<string, any>
  const keys = ['$app', '$util', '$resolve', '$interpolate', '$jsonStringify', 'gcp', 'cloudflare']
  const before = keys.map((key) => Object.getOwnPropertyDescriptor(globals, key))
  const built: Array<{ kind: string; logical: string; args: any }> = []
  const output = (value: any): any => ({
    apply: (map: (value: any) => any) => output(map(value)),
    toString: () => String(value),
    toJSON: () => value,
    [Symbol.toPrimitive]: () => String(value),
  })
  const recorder = (kind: string): any =>
    new Proxy(function () {}, {
      get: (_target, key: string) => recorder(`${kind}.${key}`),
      apply: () => {
        if (kind === 'gcp.organizations.getProjectOutput') return { number: output('123456789012') }
        if (kind === 'cloudflare.getZoneOutput') return { zoneId: 'zone' }
        throw new Error(`Unexpected provider lookup: ${kind}`)
      },
      construct: (_target, [logical, args]) => {
        built.push({ kind, logical, args })
        const fields: Record<string, any> = {
          name: output(args.name ?? logical),
          dnsResourceRecords: [{ name: '_acme.example.com', type: 'CNAME', data: 'example.com' }],
        }
        return new Proxy(fields, {
          get: (target, key: string) => (key === 'then' ? undefined : (target[key] ?? output(`${logical}:${key}`))),
        })
      },
    })
  const interpolate = (parts: TemplateStringsArray, ...values: any[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ''), '')
  globals.$app = { name: app, stage }
  globals.$util = {
    output,
    interpolate,
    all: (values: any[]) => output(values.map((value) => value?.toJSON?.() ?? value)),
  }
  globals.$interpolate = interpolate
  globals.$resolve = globals.$util.all
  globals.$jsonStringify = JSON.stringify
  globals.gcp = recorder('gcp')
  globals.cloudflare = recorder('cloudflare')
  try {
    build()
    return built
  } finally {
    keys.forEach((key, index) =>
      before[index] ? Object.defineProperty(globals, key, before[index]!) : delete globals[key],
    )
  }
}
