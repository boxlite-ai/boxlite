# infra-local 使用说明

> 配套 [`infra-local-status.md`](./infra-local-status.md) — 那个文档说"跑的是什么",这个说"怎么用"。

## 0. TL;DR — 8 个 wrapper 命令

```bash
cd apps/infra-local

# 首次/平时启动整个 stack(L1 boxes + 4 个 native 进程)
make stack-up
# 看健康
make stack-status
# 看日志(any of: api / runner / proxy / dashboard / all)
make stack-logs COMPONENT=api
# 重启某个组件(runner 含重 build)
make stack-restart COMPONENTS=runner
# 改了 env 也想重启:
make stack-restart COMPONENTS="api proxy"
# 停全部 native(L1 boxes 不停)
make stack-down
# 软重置:停 native + 清 runner home + truncate user data(schema 保留)
make stack-reset
# 硬重置:加 schema 重 load
make stack-reset-hard
# 全核打击:连 L1 boxes + logs 一起干掉(下次 stack-up 是真冷启动)
make stack-nuke
```

所有 wrapper 都是 idempotent — 重复执行安全。组件级控制通过 `COMPONENTS=` 变量(空 = all)。

---

## 1. 首次启动(全新机器,一次性)

```bash
# 前置:M5 Apple Silicon + Docker Desktop(用于 BoxLite host runtime)
# yarn + go 1.25 + python 3.11 已装

cd boxlite-cloud-mvp/apps/infra-local
make stack-build    # 装 yarn deps + build runner/proxy 二进制
make stack-up       # L1 boxes(含 prod schema)+ 4 个 native 进程,一气呵成
make stack-status   # 验证全部 up
```

✅ 一条命令搞定。`stack-up.sh` 内部自动:
1. 检测 L1 是否已 up,不 up 则 `make up-with-schema`
2. 创建 NestJS 需要的两个 symlink(`apps/.env`、`apps/apps`)
3. 按依赖顺序 api → runner → proxy → dashboard 启,每个等健康才进下一个
4. 检测端口已被占用就先清(防 EADDRINUSE)
5. 写 PID 到 `apps/infra-local/.logs/<comp>.pid`,日志到 `<comp>.log`

## 2. 日常 dashboard 开发循环

**99% 时间用这条路径**(只改 dashboard 代码):

```bash
# Vite 已在跑 → 改 apps/dashboard/src/**/*.tsx → 保存 → 浏览器 HMR 自动刷
# API + Runner + Proxy + infra-local 都保持运行,不用动
```

| 改动类型 | 重启需求 |
|---|---|
| `.tsx` / `.ts` / `.css` | 无,Vite HMR |
| `apps/dashboard/.env` | Ctrl-C + `corepack yarn nx serve dashboard` |
| 新加 npm 包 | `yarn install` + restart Vite |
| API 端 schema 改了(`@boxlite-ai/api-client`)| `yarn nx run api:openapi` regen + restart Vite |

## 3. API 改动循环

```bash
# nx serve api 是 watch 模式 — 改 apps/api/src/**/*.ts → 自动重 build + 重启
# 但有 2 个例外:
```

| 改动 | 怎么处理 |
|---|---|
| 改了 `*.entity.ts`(数据库 schema)| 写一条 migration:`apps/api/src/migrations/<ts>-name-migration.ts`,重启会自动跑 |
| 改了 `.env` | Ctrl-C + 重新 `set -a; source .env; set +a; corepack yarn nx serve api` |
| 改了 OpenAPI(controller 的 `@Api*` 装饰器)| `yarn nx run api:openapi` 重生成 `dist/apps/api/openapi.json` → SDK client 重新生成 → dashboard 重启 |

## 4. Runner 改动循环

```bash
# Runner 是 native Go binary,没有 watch 模式
pkill -9 -f boxlite-runner
cd apps/runner && go build -o /tmp/boxlite-runner ./cmd/runner && cd -
# 重新跑(用 status doc 里的 cheatsheet)
```

Runner 内存里有状态(box 句柄、heartbeat 状态等),重启会**短暂丢失** — 用户的 sandbox 会 ~10s 后被 API reconcile cron 重新认领。

## 5. 数据库 reset(开发期常用)

```bash
# 完全清空 PG,从头 load prod schema
cd apps/infra-local && make load-schema  # 等同先 drop schema 再 apply
cd -

# 或:只 truncate user 数据,保留 schema/migrations 状态
PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
  TRUNCATE TABLE sandbox, snapshot, snapshot_runner, runner, region, 
                 organization, organization_user, organization_role, 
                 api_key, audit_log CASCADE;
"

# 然后重启 API 让它重新 seed default region + default runner
```

`~/.boxlite-runner/` 也要清,否则 runner 还以为旧 sandbox 存在:

```bash
pkill -9 -f boxlite-runner
rm -rf ~/.boxlite-runner/{db,boxes,images,rootfs}/
# 重启 runner
```

> 上面是底层 SQL/shell 做法,日常**不直接用**。用下面分级 wrapper。

## 5.5 分级清理 / 重建决策

按"动多少"分 5 档,**从最轻开始,够用就停手**。

| # | 范围 | 命令 | 耗时 |
|---|---|---|---|
| ① | 1 个 L2 native 重启 | `make stack-restart COMPONENTS=runner` | ~10s |
| ② | 1 个 L1 box stuck → 重建 | `make stack-rebuild-l1-box BOX=registry` | ~3s |
| ③ | 清 DB user 数据,schema 保留 | `make stack-reset && make stack-up` | ~60s |
| ④ | 含 schema 重对齐(prod baseline reload) | `make stack-reset-hard && make stack-up` | ~90s |
| ⑤ | 全部摧毁,从零冷启动 | `make stack-nuke && make stack-up` | 3-5 min |

### 场景 1:**完全重建**(场景 ⑤)

```bash
cd apps/infra-local
make stack-nuke && make stack-up
```

做了什么:
- 停 L2 4 个 native 进程
- 删 L1 全部 10 个 boxes(microVM kernel + rootfs)
- 清数据卷 + `.logs/`
- 重新 pull 10 个 image + 加载 prod schema
- 起 L2,API 自 seed(region / admin / snapshot pulled to active)

**何时用**:团队新人 onboard / 升级 schema-baseline / "我搞了一堆诡异操作想回归"。

### 场景 2:**Reset + 重 up**(场景 ③ 最常用)

```bash
cd apps/infra-local
make stack-reset && make stack-up
```

跟 ⑤ 的区别 — 这条**保留**:L1 boxes,PG schema,image cache,历史 logs。只清 PG **用户数据** + `~/.boxlite-runner/` 运行时状态。

**何时用**:迭代中数据脏了想清掉 sandbox/org/user;测 "fresh DB" 行为。

### 场景 3:**部分 reset → 部分 up**(场景 ①②,日常 90%)

```bash
# 改 native 代码
make stack-restart COMPONENTS=runner             # runner 含自动 rebuild
make stack-restart COMPONENTS=api                # 改 .env / 文件
make stack-restart COMPONENTS="api proxy"        # 多个

# L1 box stuck(典型:dex 登录 401 / registry pull 卡死)
make stack-rebuild-l1-box BOX=dex
make stack-rebuild-l1-box BOX=registry

# 看 + tail
make stack-status                                # 1 屏全况
make stack-logs COMPONENT=runner                 # 单组件
make stack-logs COMPONENT=all                    # 全部
```

**何时用**:99% 日常迭代。

### 一句话决策

**先 `stack-status` → 哪个红 / 卡 → 用最轻的一档修。从来不要无脑 `stack-nuke`。**

## 6. 测试技巧

### 6.1 浏览器(主测试方式)

```
http://localhost:3000  → 选 admin / user 登录(dex 静态用户)
```

### 6.2 curl API(SDK 测试 / 脚本 / CI)

```bash
# 用 admin key(跳过 OIDC,适合脚本)
curl -sS \
  -H "Authorization: Bearer local-dev-admin-key" \
  -H "X-BoxLite-Organization-ID: <org-uuid>" \
  http://localhost:3001/api/sandbox/paginated | jq

# 用 OIDC token(模拟用户)
# 1. 浏览器登录后从 DevTools sessionStorage 取 access_token
# 2. curl -H "Authorization: Bearer <token>" ...
```

### 6.3 SDK 测试

```bash
# Python SDK 直连 local API
cd sdks/python
BOXLITE_API_URL=http://localhost:3001/api \
BOXLITE_API_KEY=<api-key-via-dashboard-or-curl> \
pytest tests/

# Go SDK 同理:BOXLITE_API_URL + BOXLITE_API_KEY env
```

### 6.4 数据库直查(只读,不撞 runner 锁)

```bash
# 看 sandbox state
sqlite3 ~/.boxlite-runner/db/boxlite.db -header -column \
  "SELECT id, image, status FROM boxes WHERE status='running';"

# 看 API 主库
PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
  SELECT s.name, s.state, r.name as runner FROM sandbox s
  LEFT JOIN runner r ON r.id = s.\"runnerId\" 
  ORDER BY s.\"createdAt\" DESC LIMIT 10;
"
```

### 6.5 看日志

```bash
# API stdout:重定向了 nx serve 输出的 terminal
# Runner stdout:重定向了启动 runner 的 terminal
# Proxy stdout:同上

# Box 内部日志(infra-local 那 10 个 box)
boxlite logs boxlite-local-postgres
boxlite logs boxlite-local-caddy

# Sandbox microVM 内部日志(runner 管的)
ls -lt ~/.boxlite-runner/boxes/<id>/logs/
```

## 7. 常见问题

| 症状 | 大概原因 | 解法 |
|---|---|---|
| API 全部 401 | `SSH_GATEWAY_API_KEY` 或 `PROXY_API_KEY` 没设 | 看 `apps/api/.env` 这两条值必须非空 |
| Sandbox 卡 PENDING | snapshot 还没 PULLING 完 | 等 30-60s;再卡查 runner log 看 image pull 错误 |
| Sandbox 卡 STARTED 但 terminal 黑屏 + `Connection closed` | image 是 amd64,runner 跑 arm64 microVM | 已 fix(`runner/registry.go` 用 `runtime.GOARCH`)— 旧 image 要清缓存重 pull |
| Dashboard 看不到 "+ Create Sandbox" | PostHog feature flag bootstrap 没生效 | 看 `PostHogProviderWrapper.tsx` 里 `LOCAL_DEV_FEATURE_FLAG_DEFAULTS` 有没有那个 flag |
| `POST /api/regions` → 404 "Cannot POST" | API server-side PostHog flag bootstrap 没生效 | 看 `app.module.ts` 的 `bootstrapFlags` 配置 |
| Boxlite-runner 撞锁 `Another BoxliteRuntime is already using directory` | 已有 runner 进程持有 `~/.boxlite-runner/.lock` | `lsof ~/.boxlite-runner/.lock` 找出 PID,决定是 kill 还是错用了 home dir |
| Terminal `Connection closed` 后无法重连 | signed-url 过期(默认 300s)| 重新点 Connect 按钮,dashboard 自动重新拿 |
| Dashboard 加载报 `Unauthorized` / `401`,即便刚 OIDC 登录 | **Dex SQLite session db 缓存了旧 grant**,新 login 复用 stale token(常发生在 box SIGKILL / 长时间不用之后)。判定:浏览器解 token 时 `accessTokenIat` 是几天前的 | `make stack-rebuild-l1-box BOX=dex` + 浏览器 `sessionStorage.clear()` + 重 login |
| Sandbox `pulling` 卡几分钟不动 | **Registry box TCP 还 listen 但内部 registry process hung**(SIGKILL 副作用)。`curl http://127.0.0.1:25000/v2/_catalog` 5s 超时即确认 | `make stack-rebuild-l1-box BOX=registry`,stuck 的 pull 自动恢复 |
| 任意 L1 box(pgadmin / jaeger / minio / ...)行为诡异 | 同上,L1 box 内部 stateful 进程坏掉 | `make stack-rebuild-l1-box BOX=<name>` 一键摧毁重建 |

## 8. 本地"发布"流程(MVP 内部 demo / 自测)

local 没有真正的"发布",但可以做"冻结到一个 known-good 状态"给团队 demo:

```bash
# 1. 提交所有改动
git add -A && git commit -m "demo: snapshot for <date>"

# 2. 用 boxlite SDK 导出 infra-local box 镜像(可选,~5 GB,真备份用)
for s in postgres redis minio registry dex caddy; do
  boxlite export boxlite-local-$s -o demos/$s-$(date +%Y%m%d).tar
done

# 3. 给团队成员的 README:
#    git clone + checkout 这个 commit
#    按章节 1 的"首次启动"操作
#    指向章节 6 的测试方法
```

如果是给客户演示,**只暴露 dashboard :3000**,其他端口都不要 forward — terminal 走 caddy :28080 也需要绑定 host header,远程访问需要额外的 DNS 配置(用 dns-shim,parked)。

## 9. 完整 stop

```bash
# 停 4 个 native 进程
pkill -9 -f "nx.*serve.*(api|dashboard)"
pkill -9 -f "boxlite-runner"
pkill -9 -f "boxlite-proxy"

# 停 10 个 infra boxes(保留数据)
for b in caddy registry-ui pgadmin otel jaeger dex registry minio redis postgres; do
  boxlite stop boxlite-local-$b
done

# 或彻底删(数据也丢)
cd apps/infra-local && make down
```

## 一句话

**dashboard 改 .tsx + Vite HMR = 默认开发节奏。** API/Runner/Proxy 都是稳定基础设施跑后台,日常不动。需要清空状态:`make load-schema` + 清 `~/.boxlite-runner/`。需要 demo:固定一个 commit + 按章节 1 一遍即可。
