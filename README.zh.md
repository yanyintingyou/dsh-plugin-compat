# dsh-plugin-compat

[English](README.md) | [中文](README.zh.md)

DeepSeek Harness（dsh）的 Host 端插件。DSH 升级之后，它把你自己安装的插件查一遍，报告每个插件是否还能起来、版本护栏是什么，然后停下。启用、禁用、更新、改源码全部留给你决定。

## 为什么要它

DSH 在安装和激活时用 `engines.dsh` 或 `@deepseek-ai/dsh-*` 的 peer 依赖拦截不兼容的插件。手写的本地 bundle 通常两个都不写，升级之后没有任何东西告诉你它们还能不能用。这个插件补上这份报告。

## 检查什么

- **装配状态**：每个 loader 行的 `enabled`、`fiberPhase`、诊断信息，数据来自插件管理器。`active` 说明模块导入成功、`apply` 正常返回、依赖的服务都在；`failed` 带上原始诊断。
- **版本护栏**：读 `engines.dsh`，没有就看 dsh peer 依赖。管理器判定为 `incompatible-version` 的行单列，附未满足的范围；靠精确版本豁免在跑的行也单列。
- **官方按需插件**：官方目录里按需安装的插件，装的时候固定在当时的运行版本上。升级 DSH 后它们不会自己更新，需要按当前版本重装。
- **profile 残留**：`node_modules` 里指向不存在目录的链接、被选用但没有安装的 bundle、装了但不是插件包的依赖。

随安装包分发的官方 bundle 直接跳过，它们的版本永远等于 DSH 版本。

## 什么时候跑

每次启动评估一次，只有下面任一条成立才真正检查：

- DSH 版本与上次记录的不同（升级后走这条）；
- 安装锚点的 `package.json` 变了（同版本重装）；
- profile 的依赖或启用列表变了；
- 上次没跑完。

此外，`plugin-manager/changed` 和 `app-boot/config-reload` 会在最后一个事件之后 1.5 秒合并触发一次；工具的 `check` 动作按需立即跑一次。

启动 3 秒后第一次采样。如果还有行停在 `pending`/`loading`，7 秒后再采一次。

用户消息、回合、模型请求、文件监听都不会触发检查。

## 写什么

只写自己的目录，默认 `~/.dsh/plugin-compat/`：

- `state.json`：上次的运行版本、安装标记、插件清单、registry 版本缓存。
- `report-<版本>.json`：完整报告。
- `report.md`：同一份内容，给人读。

报告保留最近三份，旧的自动删除。

## 报告怎么看

插件行和每一条待处理项都带判定与护栏状态：

- 判定：正常、异常、未就绪、未启用。
- 护栏：已声明、靠豁免、无护栏、不满足、未判定。
- 待处理计数包含：运行异常、未就绪、靠豁免运行、启用但无护栏、官方按需插件落后、profile 残留。

每条待处理项都列出证据和一条建议动作，并写明该去哪做：插件页、`plugin_manager`，或者直接改插件源码。

## 工具

`plugin_compat`，只读：

- `status`：读最近一次报告。
- `check`：立即重跑，并刷新 registry 版本查询。
- `explain <包名>`：返回单个插件的行状态、证据和建议。

## 开发版与正式版

在 `0.2.2-rc.5` 这类 prerelease 运行时上，按稳定版写范围（`^0.2.2`）的插件不满足这个范围。这是版本范围的正常语义，等稳定版发布后同一个插件就恢复兼容。豁免绑定到某个精确运行版本，`0.2.2-rc.5` 上授的权到 `0.2.2-rc.6` 失效，需要重新授权。

## 限制

- 不验证 Client 半。Host 侧全部 `active` 的插件，浏览器里仍可能什么都渲染不出来；报告会点名带 `dsh.client` 的 bundle。
- 没有实现 upgrade-guide 契约比对。方法或 slot prop 改名这类问题，这份报告看不出来。
- 没有定时查新版 DSH。每次检查时顺带记一次 registry 的 `latest` 标签。

## 安装

1. 把本目录放在一个固定的位置。
2. 在 dsh 里用 `plugin_manager` 的 `install_bundle`，目标填绝对路径；或者 **Plugins → Add plugin** 选择本目录。
3. 插件激活约 3 秒后写出第一份报告。用 `plugin_compat status` 读取。

## 配置

```yaml
- id: plugin-compat
  name: '@local/dsh-plugin-compat'
  config:
    checkOnBoot: true
    checkLatest: true
```

| 键 | 默认 | 作用 |
|---|---|---|
| `checkOnBoot` | `true` | 启动后是否检查 |
| `checkLatest` | `true` | 是否查询 registry 上最新的 dsh 版本 |
| `stateDir` | `~/.dsh/plugin-compat` | 状态与报告目录 |
| `reportKeep` | `3` | 保留几份报告 |

## 许可

MIT，见 [LICENSE](LICENSE)。
