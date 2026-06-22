# 夜间自主执行报告 (2026-06-22)

> Brian 睡前授权 5h 自主、在 boxlite-scratch worktree、做到撞墙为止。
> ★约 1h 后 SSO token 过期 → 所有需要 AWS 的动作(sst diff/deploy/建角色/验证)全阻塞★
> → 转纯【文档/代码/静态分析】路线，产出如下。dev 全程零触碰。

## 一句话

```
SST Console 接入包 + 灰度发布架构 + dev 部署破坏性 diff 的【根因锁定】 全部产出并提交。
真正的技术收获: 把困扰多日的"破坏性 LB 替换"锁定到了 3 个具体 env 变量(env parity)。
卡点: SSO 过期(等你重登) + 浏览器连接(等你) + 老板批角色。
```

## 产出物 (都在 `docs/ops/`, 已 commit 到 `ops/sst-console-onboarding` 分支)

```
sst-console/
  README.md                    决策包入口 + 做完vs待人 一览
  boss-approval.md             ★给老板的一页★: 批一个【只读+收窄+带边界】角色, 含为什么安全
  iam-console-reader.cfn.yaml  ★收窄连接角色★ boxlite-*命名+带boundary+纯只读(替掉默认Admin模板)
  onboarding-runbook.md        你照点的浏览器步骤(注册→连AWS用我们模板→连dev) + us-east-1坑 + 回退方案
  autodeploy-migration.md      若要 Console 替部署: 哪些能搬/OSS搬不了(trusted publishing) + 代码草案 + 成本
  visualization-options.md     SST Console(SaaS) vs 自托管 Grafana/CloudWatch 对比
gradual-rollout-architecture.md ★灰度发布架构★ 四层(feature flag/ECS canary/expand-contract DB/runner fleet canary)
dev-deploy-destructive-diff-rootcause.md ★根因★ env parity 锁定到 *_PUBLIC 三变量 + 验证命令 + 持久修复
```

## 三个最重要的结论

### 1. SST Console: 当只读看板上, 别整套搬部署
- 自托管开源版【现在不可行】(source-available 但官方自托管未发布)。
- 用 = 托管 SaaS。收窄成【只读+boxlite-*+带边界】角色就安全(模板已写好)。
- 整套搬部署不值: 只覆盖云部署一块; OSS 必须留 GitHub(trusted publishing 绑 GitHub OIDC);
  公开仓下 GHA 免费、Console 是净增成本; 还撞老板安全线。
- 它【不解决】我们真正卡住的 IAM/部署问题。

### 2. ★dev 部署破坏性 diff 的根因 = env parity, 锁定到具体变量★
- config 自 dev 部署的 commit(9e153f8b)起【没改过 DNS 路由】→ 不是 config bug。
- `sst.config.ts` 引用 79 个 env, SSM 只注入 18 个。缺口里 **JAEGER_PUBLIC / MAILDEV_PUBLIC /
  PGADMIN_PUBLIC** 直接翻转 LB 的 internal↔internet-facing(AWS 不可变属性)→ 强制替换 LB → DNS 连带。
- ★纠正我之前的过度判断★: "部署会删 api.dev DNS、断掉"是【过度解读】。DNS 记录是 LB 替换的连带,
  不是 config 故意删的; 会随 LB 重指, 不是永久移除。(需重登 SSO 后 diff 终确认。)
- 持久修复: 把所有影响基础设施的 env 都 seed 进 SSM(扩 seed 脚本), 或把 *_PUBLIC 改成提交常量。

### 3. "怎么灰度 runner/DB" 的真答案 = 架构, 不是工具
- 四层各有机制: feature=PostHog flag(最易,已规划) / cloud=ECS CodeDeploy canary / DB=expand-contract(已设计) /
  runner=多 runner 队列 + canary 调度(最大缺口, 现在只 1 台 runner 无法灰度)。
- 看板(Console/CloudWatch/Grafana)只是"眼睛", 不是灰度引擎。

## 你醒来后的动作 (按优先级)

```
🙋 1. 重登 SSO: aws sso login --profile boxlite-sso
      → 解锁: 验证 env-parity 根因(根因文档底部有 3 条命令) + 真正修 dev 部署
🙋 2. 决定 dev 部署 Path A(保留public LB, 补env) 还是 B(接受替换, 收敛到config的internal意图)
      → 我倾向 B, 但要先 diff 确认 Api/Proxy 的【public】LB 不会被误转 internal(那才会真断)
🙋 3. (可选)给老板看 boss-approval.md, 决定要不要接 SST Console 只读看板
🤖 4. 我能继续: 你重登 SSO 后, 我跑验证命令 + 按你选的 Path 修 dev 部署 + 真部署验活
```

## 没做的 / 卡住的 (诚实)

```
⛔ 任何 AWS 动作 — SSO 过期, 包括: sst diff/deploy 验证、实建连接角色、确认 LB scheme
⛔ 连 SST Console — 浏览器+你账号+计费, 自动化不了
⛔ 老板批角色 — 外部决策
⛔ api.dev 实际修复 — 需 SSO 看 dev 真实 LB scheme + 你选 Path A/B 才能落地(已根因+文档化)
```
