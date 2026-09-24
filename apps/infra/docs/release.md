# Release 上线流程

本文是将一个稳定版本发布到 `prod` 的简明操作手册。示例使用 `v0.10.3`；实际操作时，
请替换为本次版本号。版本必须使用 `vX.Y.Z` 格式，不支持预发布后缀。

## 前置检查

- 发布提交已经合并到 `main`，仓库中的版本号已经更新为本次版本。
- `main` 的必需检查均已通过。
- 操作者有权运行 GitHub Actions，并能批准 `dev` 和 `prod` Environment。

## 1. 创建 tag 并发布 GitHub Release

同步 `main`，在准备发布的提交上创建并推送 tag：

```bash
git switch main
git pull --ff-only origin main

TAG=v0.10.3
git tag "$TAG"
git push origin "$TAG"
```

然后发布同名 GitHub Release：

```bash
gh release create "$TAG" \
  --repo boxlite-ai/boxlite \
  --verify-tag \
  --generate-notes
```

仅推送 tag 不会触发 Runtime、SDK 和应用 image 的 release 构建；触发点是 GitHub
Release 的 `published` 事件。发布后，`Publish Release Images` 会自动从 `main` 调度
`mbuild-release`，使用本次 tag 将应用 images 发布到 `dev`。

等待 release 相关 workflows 完成，并确认 Release 中至少已经出现：

```text
boxlite-runner-vX.Y.Z-linux-amd64.tar.gz
boxlite-runner-vX.Y.Z-linux-amd64.tar.gz.sha256
```

`mdeploy-all` 在部署前会再次检查这两个 Runner 文件；文件尚未生成时不能继续上线。

## 2. 等待 mbuild-release 生成应用 images

打开 **Actions → Publish Release Images**，确认它已经成功调度
**mbuild-release**。批准 `mbuild-release` 的 `dev` Environment 后等待 workflow 完成。
它会从 tag 指向的提交读取 artifact 声明，并行构建并发布当前的三个 image 到 `dev`：

- `api`
- `proxy`
- `otel-collector`（即 collector）

发布后的 image tag 格式为 `vX.Y.Z-<commit-sha>`。确认三个 matrix jobs 全部成功后，
再进行生产部署。

如果自动调度失败，需要手动恢复时，在 **Actions → mbuild-release → Run workflow**
填写：

| 参数 | 值 |
| --- | --- |
| Run workflow from | `main` |
| `command` | `publish` |
| `tag` | 本次 tag，例如 `v0.10.3` |

或使用 GitHub CLI 调度同一恢复流程：

```bash
TAG=v0.10.3

gh workflow run mbuild-release.yml \
  --repo boxlite-ai/boxlite \
  --ref main \
  -f command=publish \
  -f tag="$TAG"
```

## 3. 使用 mdeploy-all 上线 prod

打开 **Actions → mdeploy-all → Run workflow**，填写：

| 参数 | 值 |
| --- | --- |
| Run workflow from | `main` |
| `stage` | `prod` |
| `components` | `api+runner` |
| `ref` | 本次 tag，例如 `v0.10.3` |
| `apply` | `true` |
| `confirm` | `true` |

批准 `prod` Environment。`mdeploy-all` 会依次：

1. 校验 tag、GitHub Release 和 Runner artifacts。
2. 调用 `mbuild-release`，把 `dev` 已发布的 images 提升到 `prod`；不会重新构建。
3. 校验 `prod` 中的 images，并将该版本部署到生产环境。

也可以用 GitHub CLI 触发：

```bash
TAG=v0.10.3

gh workflow run mdeploy-all.yml \
  --repo boxlite-ai/boxlite \
  --ref main \
  -f stage=prod \
  -f components=api+runner \
  -f ref="$TAG" \
  -f apply=true \
  -f confirm=true
```

`mdeploy-all` 全部 jobs 成功后，本次 release 才算完成上线。检查 workflow summary 中的
版本、commit、image tag 和部署结果是否与本次发布一致。

## 常见失败

- **提示没有 GitHub Release**：只推送了 tag；发布同名 GitHub Release 后重试。
- **没有自动出现 mbuild-release run**：先检查 `Publish Release Images`；修复该 run
  后重试，或按第 2 步从 `main` 手动调度 `mbuild-release`。
- **提示缺少 Runner artifact**：等待或修复 `Build Runner Binary`，直到 tarball 和
  `.sha256` 都已附加到 Release。
- **提示 tag 不合法或不在 main**：使用 `vX.Y.Z` 稳定版本 tag，并确保其提交属于
  `main`。
- **提示 image 已发布或已提升**：不要移动或复用 release tag；先检查之前的 workflow
  和 registry 状态，再决定是否继续 `mdeploy-all`。

完整的构建、提升和部署机制见 [Deploying BoxLite](mdeploy.md#one-dispatch)。
