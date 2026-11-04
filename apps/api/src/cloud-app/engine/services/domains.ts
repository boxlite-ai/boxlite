import type { AppRow, EnvRow } from '../db'
import type { Ctx } from '../ctx'

export interface DomainView {
  host: string
  env: string
  status: 'pending_dns' | 'active'
  records: { type: 'TXT' | 'CNAME'; name: string; value: string }[]
  verified_at: string | null
}
export interface AppDomains {
  list(app: AppRow, env: EnvRow): Promise<DomainView[]>
  add(app: AppRow, env: EnvRow, host: string, actor: string): Promise<DomainView>
  verify(
    app: AppRow,
    env: EnvRow,
    host: string,
    actor: string,
  ): Promise<DomainView & { cname?: string | null; cname_ok?: boolean }>
  remove(app: AppRow, env: EnvRow, host: string, actor: string): Promise<{ removed: string }>
  verifiedHost(env: EnvRow, host: string | null | undefined): Promise<string | null>
  releaseEnvironment(app: AppRow, env: EnvRow): Promise<void>
}

/** Domain ownership and routing are provided by the platform's Domain service. */
export const listDomains = async (ctx: Ctx, app: AppRow, env: EnvRow) => await ctx.domains.list(app, env)
export const addDomain = async (ctx: Ctx, app: AppRow, env: EnvRow, host: string, actor: string) =>
  await ctx.domains.add(app, env, host, actor)
export const verifyDomain = async (ctx: Ctx, app: AppRow, env: EnvRow, host: string, actor: string) =>
  await ctx.domains.verify(app, env, host, actor)
export const removeDomain = async (ctx: Ctx, app: AppRow, env: EnvRow, host: string, actor: string) =>
  await ctx.domains.remove(app, env, host, actor)
export const verifiedDomainOf = async (ctx: Pick<Ctx, 'domains'>, env: EnvRow, host: string | null | undefined) =>
  await ctx.domains.verifiedHost(env, host)
