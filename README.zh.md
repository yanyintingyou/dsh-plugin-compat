# dsh-plugin-compat

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | [中文](README.zh.md)

dsh 安装或激活插件时会检查 `engines.dsh`，没有这个字段就退回插件的 `@deepseek-ai/dsh-*` peer 依赖。自己写的本地插件通常两个都不声明，升级之后没人告诉你它还能不能加载。这个插件在版本变化后的第一次启动里做这项检查，写一份报告，修复留给你。

它全程只读：不启用、不下载、不更新，也不改任何插件的源码或配置。

## 查什么

装配状态直接取插件管理器的结论。每个 loader 行给出 `enabled`、`fiberPhase` 和诊断信息。`active` 表示模块导入成功、`apply` 正常返回、注入的服务都在；`failed` 会把原始诊断写进报告。

版本护栏先看 `engines.dsh`，这个字段不在就看 dsh 的 peer 依赖。管理器判成 `incompatible-version` 的插件单列一行，附上没有满足的范围；靠精确版本豁免运行的单列一行。

随安装包分发的官方 bundle 跳过，它们的版本始终等于 dsh 版本。

官方目录里按需安装的插件单独列出。它们固定在安装时的运行版本上，自己不会更新，需要按当前版本重装一次。

profile 里的残留也会列出来：`node_modules` 里指向不存在目录的链接、被选用但从未安装的 bundle、装了但不是插件包的依赖。

## 什么时候跑

每次启动评估一次，只有下面任一条成立才真正检查：

- dsh 版本和上次记录的不同，升级后走这条；
- 安装目录的 `package.json` 变了，同版本重装也落在这里；
- profile 的依赖或启用列表变了；
- 上次检查没有跑完。

另外两个事件会触发：`plugin-manager/changed` 和 `app-boot/config-reload`。它们在最后一个事件之后 1.5 秒合并成一次检查。工具的 `check` 动作按需立刻跑。

启动 3 秒后做第一次采样。还有行停在 `pending` 或 `loading` 的话，7 秒后再采一次。用户消息、回合、模型请求、文件监听都不会触发检查。

## 写到哪里

全部写到 `~/.dsh/plugin-compat/`，报告保留最近三份：

- `state.json`：上次的运行版本、安装标记、插件清单、registry 版本缓存；
- `report-<版本>.json`：完整报告；
- `report.md`：同一份内容的可读版本。

每个插件带两个字段：运行状态（正常、异常、未就绪、未启用）和护栏（已声明、靠豁免、无护栏、不满足、未判定）。待处理的数量把这几类加起来：异常的、未就绪的、靠豁免的、启用但没有护栏的、落后的官方按需插件、profile 残留。每条待处理都列出证据和一条建议，并写明该去哪做：插件页、`plugin_manager`，或者插件源码。

## 工具

`plugin_compat` 有三个动作：

- `status`：读最近一次报告；
- `check`：立刻跑一次，并刷新 registry 查询；
- `explain <包名>`：返回单个插件的行状态、证据和建议。

## 开发版

在 `0.2.2-rc.5` 这类 prerelease 运行时上，按稳定版写范围（`^0.2.2`）的插件不满足该范围。这来自 semver 对 prerelease 的处理，稳定版发布后同一个插件恢复兼容。版本豁免绑定到一个精确的运行版本，`0.2.2-rc.5` 上授予的到 `0.2.2-rc.6` 失效。

## 限制

- 不验证浏览器端。Host 侧全部 `active` 的插件，页面里仍可能什么都渲染不出来；报告会点名带 `dsh.client` 的 bundle。
- 没有实现 upgrade-guide 比对，方法或 slot prop 改名在这里看不出来。
- 没有定时查新版 dsh。每次检查时顺带记一次 registry 的 `latest`。

## 安装

把目录放在一个固定的位置。在 dsh 里用 `plugin_manager` 的 `install_bundle`，目标填绝对路径；或者打开 **Plugins → Add plugin** 选择这个目录。插件激活约 3 秒后出现第一份报告，用 `plugin_compat status` 读取。

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
