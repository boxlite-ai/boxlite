# `apps/api` 技术栈与 CRUD 框架总览

`apps/api` 是一个标准的 **NestJS 11 + TypeORM 0.3** 后端,典型“Module / Controller / Service / Entity / DTO”五件套。

## 核心栈

| 关注点 | 组件 | 版本 |
|---|---|---|
| **HTTP 框架** | `@nestjs/core` + `@nestjs/platform-express` | ^11.1.8 |
| **依赖注入 / 模块系统** | `@nestjs/common` | ^11.1.8 |
| **ORM** | `@nestjs/typeorm` + `typeorm` + `pg` | ^11 / ^0.3 / ^8.13 |
| **数据库** | PostgreSQL | — |
| **入参校验** | `class-validator` + `class-transformer` (`ValidationPipe`) | ^0.14 / ^0.5 |
| **OpenAPI/Swagger** | `@nestjs/swagger` | ^11.0.3 |
| **缓存(二级缓存 + Redis)** | `@nestjs/cache-manager` + `cache-manager` + `@nestjs-modules/ioredis` + `ioredis` | — |
| **限流** | `@nestjs/throttler` + `@nest-lab/throttler-storage-redis` | ^6.4 |
| **定时任务** | `@nestjs/schedule` | ^6.0 |
| **领域事件** | `@nestjs/event-emitter` | ^3.0 |
| **认证** | `@nestjs/passport` + 自家 `CombinedAuthGuard`/OIDC | — |
| **日志** | `nestjs-pino` + Pino | ^4.4 |
| **健康检查** | `@nestjs/terminus` | ^11 |
| **WebSocket** | `@nestjs/websockets` + `@nestjs/platform-socket.io` | ^11 |
| **Feature flag** | `@openfeature/nestjs-sdk` + PostHog provider | — |
| **分析仓库** | `@clickhouse/client` (单独 ClickHouseModule) | ^1.16 |
| **HTTP 客户端** | `@nestjs/axios` | ^4 |
| **追踪** | OpenTelemetry (`instrumentation-pg`, `pino`, `ioredis`) | — |
| **静态资源** | `@nestjs/serve-static` | — |

## 一个完整 CRUD 切片是怎么拼出来的

以 `api-key/` 为例,5 个文件对应 5 个职责:

```
api-key/
├── api-key.entity.ts      # ① ORM 映射:@Entity / @Column → PG 表
├── dto/
│   ├── create-api-key.dto.ts   # ② 入参契约 + class-validator 校验
│   └── api-key-list.dto.ts     # ③ 出参契约 + Swagger schema
├── api-key.service.ts     # ④ 业务逻辑 + Repository<ApiKey>(CRUD)
├── api-key.controller.ts  # ⑤ HTTP 路由 + Guards + Audit + Swagger 装饰
└── api-key.module.ts      # 把上面四个用 DI 装配起来
```

### 关键串联

**Module(装配)** `api-key.module.ts:15-21`

```ts
@Module({
  imports: [OrganizationModule, TypeOrmModule.forFeature([ApiKey])],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, RedisLockProvider],
  exports: [ApiKeyService],
})
```

**Service(CRUD)** `api-key.service.ts:24-29`

```ts
constructor(
  @InjectRepository(ApiKey) private apiKeyRepository: Repository<ApiKey>,
  private readonly redisLockProvider: RedisLockProvider,
  @InjectRedis() private readonly redis: Redis,
) {}
```

实际 CRUD 都是直接调 TypeORM 的 `Repository<T>` 方法:

- **C**: `apiKeyRepository.save(...)` (api-key.service.ts:54)
- **R**: `apiKeyRepository.find/findOne(...)` (api-key.service.ts:70/85)
- **U**: `apiKeyRepository.update(...)` (api-key.service.ts:135)
- **D**: `entityManager.remove(apiKey)` (api-key.service.ts:146)

外加:

- 用 `RedisLockProvider` 做分布式锁(更新 `lastUsedAt` 时去抖)
- 用 `@OnAsyncEvent` 监听领域事件(权限被撤销时级联删 key)

**Controller(HTTP + 安全 + 文档 + 审计)** `api-key.controller.ts:28-58`

```ts
@ApiTags('api-keys')
@Controller('api-keys')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
...
@Post()
@ApiOperation({ summary: 'Create API key', operationId: 'createApiKey' })
@ApiResponse({ status: 201, type: ApiKeyResponseDto })
@Audit({ action: AuditAction.CREATE, targetType: AuditTarget.API_KEY, ... })
async createApiKey(@AuthContext() ctx, @Body() dto: CreateApiKeyDto) { ... }
```

一个动作上叠了 **路由 + 多重 Guard(认证/授权/限流) + Swagger 文档 + 自定义 `@Audit` 切面**,业务代码本身保持瘦。

## DTO vs Entity

| 维度 | **DTO** (`*.dto.ts`) | **Entity** (`*.entity.ts`) |
|---|---|---|
| 角色 | API 传输契约(对外/HTTP) | 数据库表映射(对内/持久化) |
| 装饰器 | `@ApiProperty` / `@ApiSchema` (Swagger 文档) | `@Entity` / `@Column` / `@PrimaryColumn` (TypeORM) |
| CRUD | 不参与 CRUD,只描述返回/接收的形状 | 由 Repository 执行 CRUD |
| 内容裁剪 | 会脱敏/隐藏字段(如 `value: bb_****def`) | 存原始数据(`keyHash`, `keyPrefix`, `keySuffix` 等内部字段) |
| 生命周期 | 请求级别,临时构造 | 与数据库行一一对应 |

数据流:

```
PG 表 ──TypeORM──► ApiKey (entity)
                     │
                     ▼ ApiKeyListDto.fromApiKey()
                   ApiKeyListDto ──► HTTP JSON
```

## ORM 配置在哪里

ORM 用的是 **TypeORM**,配置分两处:**运行时**(应用启动用)和 **CLI 时**(执行 migration 用)。

### 1. 运行时配置 — `TypeOrmModule.forRootAsync`

**位置:** `apps/api/src/app.module.ts:72-106`

```ts
TypeOrmModule.forRootAsync({
  inject: [TypedConfigService],
  useFactory: (configService) => ({
    type: 'postgres',
    host: configService.getOrThrow('database.host'),
    ...
    autoLoadEntities: true,           // ← 自动收集所有 @Entity
    migrations: [join(__dirname, 'migrations/**/*-migration.{ts,js}')],
    migrationsRun: ...,
    namingStrategy: new CustomNamingStrategy(),
    cache: { type: 'ioredis', ... },  // ← TypeORM 二级缓存走 Redis
    entitySkipConstructor: true,
  }),
})
```

要点:

- `autoLoadEntities: true` — 各模块通过 `TypeOrmModule.forFeature([XxxEntity])` 注册的实体会被自动加载,不用手动列
- `namingStrategy` 在 `src/common/utils/naming-strategy.util.ts`(snake_case 之类)
- 连接池、TLS、Redis 缓存都从 `TypedConfigService` 拿

### 2. 配置的“值”来源

**位置:** `apps/api/src/config/configuration.ts:14-31`

```ts
database: {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  tls: { ... },
  pool: { max, min, idleTimeoutMillis, connectionTimeoutMillis },
}
```

通过 `TypedConfigModule` / `TypedConfigService`(`src/config/`)封装,提供类型安全访问。环境变量通过 `.env` / `.env.local` 注入。

### 3. CLI / Migration 用的独立 DataSource

TypeORM CLI 不走 Nest 的 DI,所以单独有:

**位置:** `apps/api/src/migrations/data-source.ts`

```ts
export const baseDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST,
  ...
  entities: [join(__dirname, '../**/*.entity.ts')],   // ← 扫所有 *.entity.ts
  namingStrategy: new CustomNamingStrategy(),
}
export default new DataSource({
  ...baseDataSourceOptions,
  migrations: [join(__dirname, '**/*-migration.{ts,js}')],
})
```

还有两个变体:

- `src/migrations/pre-deploy/data-source.ts` — 部署前迁移
- `src/migrations/post-deploy/data-source.ts` — 部署后迁移

### 速查图

```
.env / 环境变量
      │
      ▼
configuration.ts ──► TypedConfigService ──► app.module.ts (TypeOrmModule.forRootAsync) ──► 运行时 DI
      │
      └──────────► migrations/data-source.ts ──► TypeORM CLI（生成/执行 migration）
                                │
                                └── entities: src/**/*.entity.ts
                                    migrations: src/migrations/*-migration.ts
```

各模块自己的实体在 `xxx/xxx.entity.ts`,并在对应 `xxx.module.ts` 里用 `TypeOrmModule.forFeature([XxxEntity])` 注册,Service 通过 `@InjectRepository(XxxEntity)` 拿到 Repository 做 CRUD。

## 不是 CRUD 但围绕 CRUD 的横切组件

- **审计日志**:自家 `@Audit` 装饰器(`audit/decorators/audit.decorator.ts`)+ `AuditModule`,自动落审计表
- **领域事件**:`@nestjs/event-emitter` + 自家 `@OnAsyncEvent`(支持事务上下文中的异步事件)
- **缓存失效**:Service 里手动 `redis.del(...)`(因为 `auth` 链路会缓存 key 校验结果)
- **限流**:`ThrottlerModule` + Redis 存储 + 失败鉴权额外中间件 `FailedAuthRateLimitMiddleware`
- **迁移**:`typeorm` CLI + `apps/api/src/migrations/{,pre-deploy/,post-deploy/}data-source.ts` 三套 DataSource

## Migration 工具链

通过 `apps/package.json` 暴露的脚本驱动 TypeORM CLI:

```bash
pnpm migration:generate         # 对比 entity 生成 pre/post deploy 两套
pnpm migration:run:init         # 初始全量
pnpm migration:run:pre-deploy   # 部署前
pnpm migration:run:post-deploy  # 部署后
pnpm migration:revert           # 回滚
```

## 总结

**NestJS 11(DI/装饰器/管道/守卫) + TypeORM 0.3(Repository 模式) + class-validator/Swagger(契约层) + Redis(缓存/锁/限流) + 自家审计 & 事件切面**,严格遵循“Controller 薄、Service 厚、Entity 纯 schema、DTO 纯契约”的分层。没有用 `@nestjsx/crud` 这类自动 CRUD 生成器,所有 endpoint 都是手写的。
