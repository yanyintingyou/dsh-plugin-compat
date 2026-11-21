/**
 * @local/dsh-plugin-compat — DSH 升级后检查用户自装的插件是否仍适配当前运行时。
 *
 * 只读：除自己的 state.json 与 report 文件外，不改插件、配置或 profile。
 * 运行状态和声明兼容性都读插件管理器给出的结论（listBundles 的 rows / error /
 * version 豁免），这里不重复实现版本范围判定。
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'plugin-compat'

/** 三个宿主服务都在时才激活。 */
export const inject = ['pluginManager', 'tools', 'timer']

const BOOT_DELAY = 3_000
const RETRY_DELAY = 7_000
const EVENT_DEBOUNCE = 1_500
const LATEST_TIMEOUT_MS = 5_000
const LATEST_TTL_MS = 6 * 60 * 60 * 1_000
const DEFAULT_KEEP = 3
const REGISTRY_DEFAULT = 'https://registry.npmjs.org'

const INSTALL_FALLBACK = process.env.DSH_INSTALL_DIR === undefined ? undefined : join(process.env.DSH_INSTALL_DIR, 'package.json')
const PROFILE_FALLBACK = process.env.DSH_PROFILE_DIR
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const VERDICT_TEXT = { ok: '正常', broken: '异常', unknown: '未就绪', disabled: '未启用' }
const GUARD_TEXT = { declared: '已声明', exempted: '靠豁免', none: '无护栏', unmet: '不满足', unknown: '未判定' }

function localTime(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString('zh-CN', { hour12: false })
}


function readJson(file) {
  if (file === undefined) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function stampOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function sanitize(value) {
  return String(value).replace(/[^0-9A-Za-z._-]/g, '_')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 本地 dsh 版本、安装形态，以及安装锚点的替换标记。 */
function runtimeInfo(anchor) {
  const manifest = anchor === undefined ? undefined : readJson(anchor)
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined
  let installation = 'unknown'
  if (anchor !== undefined) {
    if (anchor.includes('app.asar')) installation = 'desktop'
    else installation = readJson(join(anchor, '..', '..', '..', 'package.json'))?.name === '@deepseek-ai/dsh-root' ? 'source' : 'npm'
  }
  return {
    version,
    installation,
    prerelease: typeof version === 'string' && version.includes('-'),
    stamp: anchor === undefined ? undefined : stampOf(anchor),
  }
}

/** profile 声明的插件集合；只读 package.json，用来判断要不要重跑检查。 */
function profileSignature(profileDir) {
  const manifest = readJson(profileDir === undefined ? undefined : join(profileDir, 'package.json'))
  return {
    dependencies: Object.entries(manifest?.dependencies ?? {}).map(([key, value]) => `${key}@${String(value)}`).sort(),
    bundles: [...(manifest?.dsh?.profile?.bundles ?? [])].sort(),
  }
}

function decide(state, runtime, signature) {
  if (runtime.version === undefined) return { run: true, reason: '读不到本地 DSH 版本' }
  if (state === undefined) return { run: true, reason: '没有历史报告' }
  if (state.runtimeVersion !== runtime.version) return { run: true, reason: `DSH ${state.runtimeVersion ?? '未知'} → ${runtime.version}` }
  if (state.installStamp !== runtime.stamp) return { run: true, reason: '安装目录被替换' }
  if (JSON.stringify(state.dependencies) !== JSON.stringify(signature.dependencies)) return { run: true, reason: '插件清单变化' }
  if (JSON.stringify(state.bundles) !== JSON.stringify(signature.bundles)) return { run: true, reason: '启用列表变化' }
  if (state.status !== 'done') return { run: true, reason: '上次检查未完成' }
  return { run: false, reason: '版本与插件清单都没有变化' }
}

/** 从 profile 的 node_modules 或 link 源目录读插件清单。 */
function manifestOf(bundle, profileDir) {
  const candidates = []
  if (profileDir !== undefined) candidates.push(join(profileDir, 'node_modules', bundle.name, 'package.json'))
  if (typeof bundle.source === 'string' && bundle.source.startsWith('link:')) candidates.push(join(bundle.source.slice(5), 'package.json'))
  for (const file of candidates) {
    const manifest = readJson(file)
    if (manifest !== undefined) return manifest
  }
  return undefined
}

function declaresGuard(manifest) {
  const engines = manifest?.engines
  if (engines !== null && typeof engines === 'object' && Object.hasOwn(engines, 'dsh')) return true
  const peers = manifest?.peerDependencies
  if (peers === null || typeof peers !== 'object') return false
  return Object.keys(peers).some(key => key === '@deepseek-ai/dsh' || key.startsWith('@deepseek-ai/dsh-'))
}

/** 版本护栏：豁免、管理器的 incompatible 结论、清单里的声明，三者合一。 */
function guardOf(bundle, manifest, exemptions, runtime) {
  const key = `${bundle.name}@${String(bundle.version)}`
  if ((exemptions[key] ?? []).includes(runtime.version)) {
    return { kind: 'exempted', detail: `精确版本豁免允许它运行在 ${runtime.version}` }
  }
  const failure = bundle.error
  if (failure?.code === 'incompatible-version' && Array.isArray(failure.incompatible) && failure.incompatible.length > 0) {
    return { kind: 'unmet', detail: `声明不满足 ${runtime.version}：${JSON.stringify(failure.incompatible[0].requirements)}` }
  }
  if (failure !== undefined) return { kind: 'unknown', detail: `插件管理器报告 ${failure.code}${failure.diagnostic === undefined ? '' : `：${failure.diagnostic}`}` }
  if (manifest === undefined) return { kind: 'unknown', detail: '读不到插件的 package.json' }
  if (declaresGuard(manifest)) return { kind: 'declared', detail: '声明了 dsh 版本要求' }
  return { kind: 'none', detail: '没有声明 engines.dsh 或 dsh peer 依赖，升级后没有版本护栏' }
}

function verdictOf(bundle, rows) {
  if (bundle.enabled !== true) return 'disabled'
  if (bundle.error?.code === 'incompatible-version') return 'broken'
  if (rows.some(row => row.phase === 'failed')) return 'broken'
  if (rows.length === 0) return 'unknown'
  if (rows.some(row => row.phase !== 'active')) return 'unknown'
  return 'ok'
}

function titleOf(bundle, manifest) {
  const title = bundle.meta?.title
  if (typeof title === 'string' && title.length > 0) return title
  if (title !== null && typeof title === 'object') {
    const localized = title.zh ?? title['zh-CN'] ?? title.en
    if (typeof localized === 'string' && localized.length > 0) return localized
  }
  if (typeof manifest?.description === 'string' && manifest.description.length > 0) return manifest.description
  return bundle.name
}

function actionOf(verdict, guard) {
  if (verdict === 'broken') return guard.kind === 'unmet' ? '在插件页更新到兼容版本，或改源码适配当前 dsh' : '看插件页的诊断；确认后在插件页禁用，或改源码'
  if (verdict === 'unknown') return '等下次检查再确认；一直未就绪就看插件页'
  if (guard.kind === 'exempted') return '更新插件；继续用就要在每次 DSH 更新后重新授权豁免'
  if (guard.kind === 'none') return '可选：补 engines.dsh 或 dsh peer 依赖；在那之前每次 DSH 更新后人工复核'
  if (verdict === 'disabled') return '未启用，不用处理'
  return '不用处理'
}

function inspectBundle(bundle, entries, exemptions, runtime, profileDir) {
  const rows = (bundle.rows ?? []).map(row => {
    const entry = row.entryId === undefined ? undefined : entries.get(row.entryId)
    return {
      rowId: row.rowId,
      moduleName: row.moduleName,
      phase: entry === undefined ? null : entry.fiberPhase,
      enabled: entry?.enabled === true,
      diagnostic: entry?.diagnostic,
    }
  })
  const manifest = manifestOf(bundle, profileDir)
  const guard = guardOf(bundle, manifest, exemptions, runtime)
  const verdict = verdictOf(bundle, rows)
  const reasons = []
  const failed = rows.find(row => row.phase === 'failed')
  const stalled = rows.find(row => row.phase !== 'active')
  if (verdict === 'broken') {
    reasons.push(failed === undefined ? guard.detail : `行 ${failed.rowId} 加载失败${failed.diagnostic === undefined ? '' : `：${failed.diagnostic}`}`)
  } else if (verdict === 'unknown') {
    reasons.push(stalled === undefined ? '启用了但没有可解析的行' : `行 ${stalled.rowId} 停在 ${stalled.phase ?? '未挂载'}`)
  } else if (verdict === 'disabled') {
    reasons.push('未启用，不做运行检查')
  } else {
    reasons.push(`${rows.length} 行全部 active`)
  }
  if (guard.kind === 'exempted' || guard.kind === 'unmet' || guard.kind === 'none') reasons.push(guard.detail)
  return {
    name: bundle.name,
    title: titleOf(bundle, manifest),
    version: bundle.version,
    enabled: bundle.enabled === true,
    source: typeof bundle.source === 'string' ? bundle.source : undefined,
    hasClient: manifest?.dsh?.client !== undefined,
    verdict,
    guard,
    rows,
    reasons,
    action: actionOf(verdict, guard),
  }
}

/** profile/node_modules 里指向不存在目录的残留链接。 */
function scanDangling(profileDir) {
  const found = []
  if (profileDir === undefined) return found
  const root = join(profileDir, 'node_modules')
  let top
  try {
    top = readdirSync(root)
  } catch {
    return found
  }
  const names = []
  for (const entry of top) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      try {
        for (const child of readdirSync(join(root, entry))) names.push(`${entry}/${child}`)
      } catch {}
    } else {
      names.push(entry)
    }
  }
  for (const name of names) {
    try {
      statSync(join(root, name))
    } catch {
      found.push({ kind: 'dangling-link', name, detail: 'node_modules 里的链接指向不存在的目录' })
    }
  }
  return found
}

function computeCounts(plugins, official, anomalies) {
  const enabled = plugins.filter(plugin => plugin.enabled).length
  const broken = plugins.filter(plugin => plugin.verdict === 'broken').length
  const unknown = plugins.filter(plugin => plugin.verdict === 'unknown').length
  const exempted = plugins.filter(plugin => plugin.enabled && plugin.guard.kind === 'exempted').length
  const unguarded = plugins.filter(plugin => plugin.enabled && plugin.verdict === 'ok' && plugin.guard.kind === 'none').length
  return {
    user: plugins.length,
    enabled,
    broken,
    unknown,
    exempted,
    unguarded,
    officialStale: official.length,
    anomalies: anomalies.length,
    attention: broken + unknown + exempted + unguarded + official.length + anomalies.length,
  }
}

function renderStatus(report, stateDir) {
  if (report === undefined) return '还没有兼容性报告：启动后约 3 秒生成第一次，也可以调用 check 立即检查。'
  const lines = []
  const latest = report.latest === undefined
    ? '未查询'
    : report.latest.error !== undefined
      ? '查询失败'
      : `${report.latest.version}${report.latest.relation === 'same' ? '（与本地相同）' : '（与本地不同）'}`
  lines.push(`DSH ${report.runtimeVersion ?? '未知'}（${report.installation}${report.runtimePrerelease ? '，prerelease' : ''}）· registry latest ${latest}`)
  lines.push(`检查于 ${localTime(report.checkedAt)}（${report.reason}）· 自装插件 ${report.counts.user} 个，启用 ${report.counts.enabled} 个 · 待处理 ${report.counts.attention}`)
  for (const plugin of report.plugins) {
    lines.push(`- ${plugin.title ?? plugin.name} ${plugin.name}@${plugin.version ?? '?'} · ${plugin.enabled ? '启用' : '未启用'} · ${VERDICT_TEXT[plugin.verdict]} · ${GUARD_TEXT[plugin.guard.kind]} · ${plugin.reasons[plugin.reasons.length - 1] ?? ''}`)
  }
  for (const item of report.official) lines.push(`- 官方按需插件 ${item.name}@${item.version} 落后于运行时 ${item.targetVersion}，需要按当前版本重装`)
  for (const item of report.anomalies) lines.push(`- 异常 ${item.name}：${item.detail}`)
  lines.push(`报告：${join(stateDir, 'report.md')}`)
  lines.push('只读检查：没有启用、禁用、更新或修改任何插件与配置。')
  return lines.join('\n')
}

function renderExplain(report, name) {
  if (report === undefined) return '还没有报告，先调用 check。'
  const plugin = report.plugins.find(item => item.name === name)
  if (plugin !== undefined) {
    const lines = [
      `${plugin.title ?? plugin.name} ${plugin.name}@${plugin.version ?? '?'}`,
      `启用：${plugin.enabled ? '是' : '否'} · 运行：${VERDICT_TEXT[plugin.verdict]} · 护栏：${GUARD_TEXT[plugin.guard.kind]}`,
      `来源：${plugin.source ?? '未知'}`,
    ]
    for (const row of plugin.rows) {
      lines.push(`行 ${row.rowId} → ${row.moduleName}：${row.phase ?? '未挂载'}${row.enabled ? '' : '（行未启用）'}${row.diagnostic === undefined ? '' : ` · ${row.diagnostic}`}`)
    }
    for (const reason of plugin.reasons) lines.push(`证据：${reason}`)
    lines.push(`建议：${plugin.action}`)
    return lines.join('\n')
  }
  const official = report.official.find(item => item.name === name)
  if (official !== undefined) return `${official.name}@${official.version}：官方按需插件，当前运行时是 ${official.targetVersion}，按当前版本重装。`
  const anomaly = report.anomalies.find(item => item.name === name)
  if (anomaly !== undefined) return `${anomaly.name}：${anomaly.detail}`
  return `报告里没有 ${name}。`
}

function renderMarkdown(report) {
  const lines = []
  const latest = report.latest === undefined
    ? '未查询'
    : report.latest.error !== undefined
      ? `查询失败（${report.latest.error}）`
      : `${report.latest.version}（${report.latest.relation === 'same' ? '与本地相同' : '与本地不同'}，${report.latest.registry}）`
  lines.push(`# 插件兼容巡检 · ${report.runtimeVersion ?? '未知版本'}`)
  lines.push('')
  lines.push(`检查时间 ${localTime(report.checkedAt)} · 安装形态 ${report.installation}${report.runtimePrerelease ? '（prerelease）' : ''} · registry latest ${latest} · 触发原因 ${report.reason}`)
  lines.push('')
  lines.push('只读检查：没有启用、禁用、更新或修改任何插件与配置。是否处理、什么时候处理，由你决定。')
  lines.push('')
  lines.push(`## 自装插件（${report.counts.user}，启用 ${report.counts.enabled}）`)
  lines.push('')
  lines.push('| 插件 | 版本 | 启用 | 运行 | 版本护栏 | 来源 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const plugin of report.plugins) {
    lines.push(`| ${plugin.title ?? plugin.name}（\`${plugin.name}\`） | ${plugin.version ?? '?'} | ${plugin.enabled ? '是' : '否'} | ${VERDICT_TEXT[plugin.verdict]} | ${GUARD_TEXT[plugin.guard.kind]} | ${plugin.source ?? ''} |`)
  }
  lines.push('')
  lines.push(`## 待处理（${report.counts.attention}）`)
  lines.push('')
  const attention = report.plugins.filter(plugin => plugin.verdict === 'broken' || plugin.verdict === 'unknown' || (plugin.enabled && (plugin.guard.kind === 'none' || plugin.guard.kind === 'exempted')))
  if (attention.length === 0 && report.official.length === 0 && report.anomalies.length === 0) lines.push('没有需要处理的项目。')
  for (const plugin of attention) {
    lines.push(`- **${plugin.title ?? plugin.name}**（\`${plugin.name}\`）— ${plugin.reasons.join('；')}`)
    lines.push(`  - 建议：${plugin.action}`)
  }
  for (const item of report.official) lines.push(`- **${item.name}** — 官方按需插件停留在 ${item.version}，当前运行时是 ${item.targetVersion}。建议按当前版本重装。`)
  for (const item of report.anomalies) lines.push(`- **${item.name}** — ${item.detail}`)
  lines.push('')
  lines.push('## 未覆盖')
  lines.push('')
  const clientHalves = report.plugins.filter(plugin => plugin.enabled && plugin.hasClient)
  lines.push(clientHalves.length === 0 ? '- Client 半：本次没有带 `dsh.client` 的启用插件。' : `- Client 半（浏览器内加载）：没有验证 —— ${clientHalves.map(plugin => plugin.name).join('、')}`)
  lines.push('- 契约比对（upgrade-guide 匹配）：尚未实现，本报告只覆盖装配与声明两层。')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const manager = ctx.pluginManager
  let profileContext
  try {
    profileContext = ctx.profileContext
  } catch {}
  const profileDir = profileContext?.dir ?? PROFILE_FALLBACK
  const installAnchor = profileContext?.installAnchor ?? INSTALL_FALLBACK
  const stateDir = config.stateDir || join(DSH_HOME, 'plugin-compat')
  const statePath = join(stateDir, 'state.json')
  const keep = Number.isInteger(config.reportKeep) && config.reportKeep > 0 ? config.reportKeep : DEFAULT_KEEP
  const checkLatest = config.checkLatest !== false

  let latest = readJson(statePath)?.latest
  let lastReport
  let running
  let cancelDebounce

  async function queryLatest(refresh) {
    if (!checkLatest) return undefined
    if (!refresh && latest !== undefined && typeof latest.checkedAt === 'number' && Date.now() - latest.checkedAt < LATEST_TTL_MS) return latest
    const candidates = []
    try {
      const registries = await manager.registries()
      for (const value of [registries.registry, ...(registries.fallbackRegistries ?? []), registries.resolved]) {
        if (typeof value === 'string' && value.length > 0) candidates.push(value)
      }
    } catch (error) {
      ctx.logger.warn(`plugin-compat: 读 registry 配置失败 ${messageOf(error)}`)
    }
    candidates.push(REGISTRY_DEFAULT)
    const tried = new Set()
    for (const base of candidates) {
      const registry = base.replace(/\/+$/, '')
      if (tried.has(registry)) continue
      tried.add(registry)
      try {
        const response = await fetch(`${registry}/-/package/@deepseek-ai%2Fdsh/dist-tags`, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) })
        if (!response.ok) continue
        const tags = await response.json()
        if (typeof tags?.latest !== 'string') continue
        latest = { version: tags.latest, registry, checkedAt: Date.now() }
        return latest
      } catch {}
    }
    latest = { error: '所有 registry 都没有回答', checkedAt: Date.now() }
    return latest
  }

  async function buildReport(runtime, reason, refreshLatest) {
    const bundles = await manager.listBundles()
    const entries = new Map((await manager.listPlugins()).map(entry => [entry.entryId, entry]))
    let exemptions = {}
    try {
      exemptions = manager.listVersionExemptions()?.exemptions ?? {}
    } catch (error) {
      ctx.logger.warn(`plugin-compat: 读版本豁免失败 ${messageOf(error)}`)
    }
    const plugins = []
    const official = []
    const anomalies = []
    for (const bundle of bundles) {
      if (bundle.enabled === true && bundle.installed !== true && bundle.availability !== 'installation') {
        anomalies.push({ kind: 'selected-missing', name: bundle.name, detail: '在这个 profile 里被选用，但没有安装' })
      }
      if (bundle.availability !== 'profile' || bundle.installed !== true) continue
      if (bundle.official === true) {
        const target = bundle.installTarget?.version
        if (typeof target === 'string' && typeof bundle.version === 'string' && target !== bundle.version) {
          official.push({ name: bundle.name, version: bundle.version, targetVersion: target })
        }
        continue
      }
      const rows = bundle.rows ?? []
      if (rows.length === 0) {
        if (bundle.error !== undefined) anomalies.push({ kind: 'not-a-plugin', name: bundle.name, detail: `不是插件包（${bundle.error.code}）` })
        continue
      }
      plugins.push(inspectBundle(bundle, entries, exemptions, runtime, profileDir))
    }
    anomalies.push(...scanDangling(profileDir))
    const queried = await queryLatest(refreshLatest)
    const latestSummary = queried === undefined
      ? undefined
      : queried.error !== undefined
        ? { error: queried.error }
        : { version: queried.version, registry: queried.registry, relation: queried.version === runtime.version ? 'same' : 'different' }
    return {
      runtimeVersion: runtime.version,
      runtimePrerelease: runtime.prerelease,
      installation: runtime.installation,
      checkedAt: new Date().toISOString(),
      reason,
      latest: latestSummary,
      counts: computeCounts(plugins, official, anomalies),
      plugins,
      official,
      anomalies,
    }
  }

  function pruneReports(keepFile) {
    let files
    try {
      files = readdirSync(stateDir).filter(file => file.startsWith('report-') && file.endsWith('.json'))
    } catch {
      return
    }
    const others = files
      .map(file => ({ file, path: join(stateDir, file) }))
      .filter(entry => entry.path !== keepFile)
      .map(entry => ({ ...entry, mtime: stampOf(entry.path) ?? 0 }))
      .sort((left, right) => right.mtime - left.mtime)
    for (const entry of others.slice(Math.max(0, keep - 1))) {
      try {
        rmSync(entry.path, { force: true })
      } catch {}
    }
  }

  function persist(report, runtime, signature) {
    mkdirSync(stateDir, { recursive: true })
    const reportFile = join(stateDir, `report-${sanitize(report.runtimeVersion ?? 'unknown')}.json`)
    writeFileSync(reportFile, JSON.stringify(report, null, 2))
    writeFileSync(join(stateDir, 'report.md'), renderMarkdown(report))
    writeFileSync(statePath, JSON.stringify({
      runtimeVersion: runtime.version,
      installStamp: runtime.stamp,
      dependencies: signature.dependencies,
      bundles: signature.bundles,
      checkedAt: report.checkedAt,
      status: 'done',
      latest,
    }, null, 2))
    pruneReports(reportFile)
  }

  function loadReport(runtime) {
    if (lastReport !== undefined) return lastReport
    lastReport = readJson(join(stateDir, `report-${sanitize(runtime.version ?? 'unknown')}.json`))
    return lastReport
  }

  function runCheck(reason, options = {}) {
    if (running !== undefined) return running
    running = (async () => {
      const runtime = runtimeInfo(installAnchor)
      const signature = profileSignature(profileDir)
      const state = readJson(statePath)
      const decision = decide(state, runtime, signature)
      if (options.force !== true && decision.run !== true) {
        ctx.logger.info(`plugin-compat: 跳过检查（${decision.reason}）`)
        return { report: loadReport(runtime), ran: false }
      }
      const reportReason = reason === '启动' && decision.run === true ? decision.reason : reason
      const report = await buildReport(runtime, reportReason, options.refreshLatest === true)
      lastReport = report
      persist(report, runtime, signature)
      ctx.logger.info(`plugin-compat: 检查完成，待处理 ${report.counts.attention} 项（${report.reason}）`)
      return { report, ran: true }
    })().catch(error => {
      ctx.logger.warn(`plugin-compat: 检查失败 ${messageOf(error)}`)
      return { report: undefined, ran: false }
    }).finally(() => {
      running = undefined
    })
    return running
  }

  if (config.checkOnBoot !== false) {
    ctx.timer.timeout(async () => {
      const result = await runCheck('启动')
      if (result.ran && (result.report?.counts.unknown ?? 0) > 0) {
        ctx.timer.timeout(() => { void runCheck('启动复采', { force: true }) }, RETRY_DELAY)
      }
    }, BOOT_DELAY)
  }

  const onProfileChanged = () => {
    if (cancelDebounce !== undefined) cancelDebounce()
    cancelDebounce = ctx.timer.timeout(() => {
      cancelDebounce = undefined
      void runCheck('插件变更', { force: true })
    }, EVENT_DEBOUNCE)
  }
  ctx.on('plugin-manager/changed', onProfileChanged)
  ctx.on('app-boot/config-reload', onProfileChanged)

  ctx.tools.register({
    name: 'plugin_compat',
    description: 'Report whether the plugins you installed yourself (non-official dsh bundles) still work on the running dsh version. '
      + 'Reads the plugin manager\'s own activation state and each package\'s declared dsh requirements. '
      + 'Read-only: it never enables, disables, updates, removes, or edits a plugin. '
      + 'Covers Host-side activation and declarations; browser-side halves and upgrade-guide contract changes are not verified.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'check', 'explain'],
          description: 'status reads the latest report; check re-runs it now; explain shows one plugin\'s evidence.',
        },
        name: {
          type: 'string',
          description: 'Plugin package name, used by explain.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      if (args.action === 'check') {
        const result = await runCheck('手动', { force: true, refreshLatest: true })
        return { text: renderStatus(result.report, stateDir) }
      }
      const report = loadReport(runtimeInfo(installAnchor))
      if (args.action === 'explain') return { text: renderExplain(report, args.name ?? '') }
      return { text: renderStatus(report, stateDir) }
    },
  })
}
