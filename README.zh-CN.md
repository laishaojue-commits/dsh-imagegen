# dsh-imagegen v0.1

[English](README.md) | [简体中文](README.zh-CN.md)

适配 **DeepSeek Harness 0.2.0-rc.2** 的生图插件，支持 Gemini 原生 `generateContent` 和 OpenAI 兼容 Images 接口。基于 [ZhaoJun233/dsh-imagegen](https://github.com/ZhaoJun233/dsh-imagegen) 修改。

## 功能

- 默认固定使用配置里的生图模型，拒绝临时换成聊天模型。
- 短冷却由工具内部等待，到时间后最多重试一次；长冷却直接说明还需等待多久。
- 缓存已知冷却时间，连续重复调用不会反复请求同一个受限接口。
- 区分额度冷却、网络错误、超时、HTTP 错误、取消和响应无图片。
- 提示主模型在失败后说明情况并结束，不自动查进程、遍历目录或试其他模型。
- 成功结果附带总耗时、请求次数和冷却等待时间；日志不记录密钥、接口地址、提示词或图片内容。

## 本地安装

桌面版可以直接调用自带 CLI，无需先把 `dsh` 加到 PATH：

```powershell
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add "link:C:\path\to\dsh-imagegen"
```

CLI/Web 版：

```powershell
dsh plugin --profile web add "link:C:\path\to\dsh-imagegen"
```

把示例路径替换成源码目录。安装或更新后，重启对应的 DSH 主机才会加载新代码。桌面版链接插件会复用应用自带运行时；Web 部署需能解析清单声明的 DSH peer 包。特殊安装位置可通过 `DSH_RUNTIME_DIR` 指定运行时目录。

## 配置生图服务

打开 **插件 → 插件配置 → 生图服务**，填写 API 地址、密钥和默认生图模型。设置接口不会回显密钥，仓库内不含真实凭证。

本机 CPA 的连接示例：

```json
{
  "protocol": "gemini",
  "url": "http://127.0.0.1:8317",
  "apiKeyEnv": "IMAGEGEN_API_KEY",
  "apiKeyHeader": "Authorization",
  "apiKeyPrefix": "Bearer ",
  "defaultModel": "gemini-3.1-flash-image"
}
```

密钥可在设置中填写，也可在启动 DSH 的环境中定义 `IMAGEGEN_API_KEY`。旧配置文件 `~/.dsh/dsh-imagegen.json` 仍可使用上述连接结构；插件设置未填写连接或未提供凭证时，会回退读取它。两种协议的示例均在 [examples](examples/) 中。

Gemini 基址自动拼接 `/v1beta/models/{model}:generateContent`，不会使用 Images 接口。选择 `image2` 时可填写 `https://example.com/v1` 这样的基址，插件会追加 `/images/generations`。

## 冷却与重试

高级策略写在当前 profile 的 `cordis.patch.yml`，保存后重启。这几个字段不在设置页中实时编辑：

```yaml
- id: imagegen
  config:
    allowModelOverride: false
    maxRetries: 1
    maxCooldownWaitMs: 60000
    requestTimeoutMs: 90000
    timeoutMs: 180000
```

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `allowModelOverride` | `false` | 工具默认只能用配置中的生图模型 |
| `maxRetries` | `1` | 429 后最多重试一次，可设 0–2 |
| `maxCooldownWaitMs` | `60000` | 单次调用累计自动等待预算，可设 0–120000 毫秒 |
| `requestTimeoutMs` | `90000` | 一次 API 请求的超时，包含响应体读取 |
| `timeoutMs` | `180000` | 工具总耗时上限，包含等待与保存 |

冷却计时额外留出 1 秒余量。等待会超过预算，或无法为后续请求预留完整请求窗口时，直接返回剩余时间，不长时间挂起。上游未给出恢复时间时，初次采用 30 秒退避。网络错误和超时不自动重复提交，避免重复生成。

插件优先读取当前 `Retry-After`、`reset_seconds` 等结构化字段，不拿 `last_upstream_error` 中旧的“9m32s”作为实时倒计时。冷却缓存只存在于当前进程，插件重载后清空；它不会增加上游额度，也不会缩短上游规定的冷却。

## 使用工具

通常直接说“生成一张红蘑菇图片”即可。主模型调用 `image_generate` 时应省略 `model`，使用配置的默认生图模型。可指定提示词、比例、分辨率和工作区内的相对输出路径。输出默认保存在 `generated-images/`。

| 错误标签 | 含义 |
| --- | --- |
| `IMAGE_COOLDOWN` | 限流或额度冷却，附剩余秒数 |
| `IMAGE_MODEL_LOCKED` | 工具试图覆盖配置的生图模型 |
| `IMAGE_NO_IMAGE` | 收到有效响应，但没有可用图片 |
| `IMAGE_NETWORK` | 生图接口连接或读取失败 |
| `IMAGE_TIMEOUT` | 单次请求或总时间超时 |
| `IMAGE_HTTP_ERROR` | 其他 HTTP 错误，提示内容经过脱敏 |
| `IMAGE_INVALID_RESPONSE` | 上游没有返回有效 JSON |
| `IMAGE_CANCELLED` | 用户或运行时取消操作 |

## 测试与打包

Node.js 22+；策略和前端模块测试无需安装 npm 依赖，不访问真实生图接口：

```powershell
npm run check
npm test
npm run test:desktop
npm pack
```

桌面冒烟测试使用已安装的 Windows DSH 0.2.0-rc.2 和固定响应样本，不打开或重启现有应用。安装位置不同时可设置 `DSH_DESKTOP_EXE`。GitHub Actions 配置覆盖 Node 22/24 与 Windows/macOS/Linux；这不代表已经完成每个平台的 DSH 实机验收。

## 从 GitHub 安装

仓库：[laishaojue-commits/dsh-imagegen](https://github.com/laishaojue-commits/dsh-imagegen)。

```powershell
dsh plugin --profile desktop add github:laishaojue-commits/dsh-imagegen
```

没有把 `dsh` 加到 PATH 时，使用“本地安装”中的桌面 CLI 路径。Web 版将 `desktop` 换成 `web`。安装后重启 DSH。`private: true` 仅阻止意外发布到 npm，不影响 GitHub 安装。

本机 DSH 配置、凭证和真实密钥不放进仓库。
