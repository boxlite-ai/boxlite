/**
 * Native Pulumi programs install these globals before composing provider bundles.
 * Input/Output and AWS resources use official SDK types; the remaining provider
 * namespaces retain constructor-boundary tests alongside their shared contracts.
 */

declare global {
  /** The app and stage this deploy is for. Both engines set it. */
  const $app: { readonly name: string; readonly stage: string }

  namespace $util {
    type Input<T> = import('@pulumi/pulumi').Input<T>
    type Output<T> = import('@pulumi/pulumi').Output<T>
  }

  /** Wraps a plain value, and marks one as secret so the state seals it. */
  const $util: {
    output<T>(value: $util.Input<T>): $util.Output<T>
    secret<T>(value: $util.Input<T>): $util.Output<T>
    interpolate(strings: TemplateStringsArray, ...values: any[]): $util.Output<string>
    jsonStringify(value: any): $util.Output<string>
    all(values: any[]): $util.Output<any[]>
  }

  /** Template-literal interpolation over values that are not resolved yet. */
  function $interpolate(strings: TemplateStringsArray, ...values: any[]): $util.Output<string>

  function $output<T>(value: $util.Input<T>): $util.Output<T>
  function $jsonStringify(value: any): $util.Output<string>

  /** Waits for several values at once. `$util.all` under the name the stack uses. */
  function $resolve<T extends any[]>(values: T): $util.Output<{ [K in keyof T]: any }>

  /** Paths the CLI resolved. Only the ClickHouse reconcile command reads it. */
  const $cli: { paths: { root: string } }

  const aws: typeof import('@pulumi/aws')
  const gcp: any
  const random: any
  const cloudflare: any
  const command: any
  const kubernetes: any

  /** Opaque dependency handles shared by cloud-specific resource implementations. */
  type CloudResource = any
}

export {}
