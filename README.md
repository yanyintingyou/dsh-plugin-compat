# dsh-plugin-compat

[English](README.md) | [中文](README.zh.md)

A DeepSeek Harness (dsh) Host plugin. After a dsh upgrade it checks the plugins you installed yourself, reports whether each one still activates and what its version guard says, then stops. It never enables, disables, updates or edits a plugin.

## Why it exists

dsh gates plugins at install and activation time through `engines.dsh`, or else through `@deepseek-ai/dsh-*` peer dependencies. Hand-written local bundles usually declare neither. Nothing tells you whether they still work after an upgrade, so this plugin produces that report.

## What it checks

- **Activation.** Each loader row's `enabled`, `fiberPhase` and diagnostic, read from the plugin manager. `active` means the module imported, `apply` returned, and injected services existed. `failed` carries the original diagnostic.
- **Version guard.** `engines.dsh`, else the dsh peer dependencies. The plugin also flags rows the manager rejects as `incompatible-version`, with the unmet ranges, and rows running on an exact-version exemption.
- **Official on-demand bundles.** Bundles from the official catalog that were installed at an older runtime version. They do not update themselves and need reinstalling at the current version.
- **Profile leftovers.** Links in `node_modules` that point at a missing directory, bundles selected but not installed, and dependencies that are not plugin bundles.

Official bundles shipped with the installation are skipped: their version always equals the dsh version.

## When it runs

Every start evaluates once, and only these conditions run a check:

- the dsh version differs from the recorded one (the path an upgrade takes);
- the installation anchor's `package.json` changed (a reinstall of the same version);
- the profile's dependency or bundle list changed;
- the last run did not finish.

Beyond that, `plugin-manager/changed` and `app-boot/config-reload` coalesce into one check 1.5 seconds after the last event. The tool's `check` action runs one on demand.

The first sample lands 3 seconds after start. If any row is still `pending` or `loading`, one more sample follows 7 seconds later.

User messages, turns, model requests and file watching never trigger a check.

## What it writes

Only its own directory, `~/.dsh/plugin-compat/` by default:

- `state.json`: last runtime version, install stamp, plugin list, cached registry version.
- `report-<version>.json`: the full report.
- `report.md`: the same report for reading.

The plugin keeps the three newest reports and deletes older ones.

## The report

The plugin row and every finding carry a verdict and a guard state:

- Verdict: normal, broken, not ready, or disabled.
- Guard: declared, exempted, missing, unmet, or unknown.
- Pending items count broken rows, rows not ready, plugins running on an exemption, enabled plugins without a guard, stale official bundles, and profile leftovers.

Each finding lists its evidence and one suggested action, with the place to do it: the plugin page, `plugin_manager`, or the plugin source.

## Tool

`plugin_compat`, read-only:

- `status` reads the latest report.
- `check` re-runs it now and refreshes the registry lookup.
- `explain <name>` returns one plugin's rows, evidence and suggestion.

## Development builds

On a prerelease runtime such as `0.2.2-rc.5`, a plugin that declares a stable range (`^0.2.2`) does not satisfy the range. That is normal range semantics, and the same plugin turns compatible when the stable release lands. Exemptions bind to one exact runtime version, so an exemption granted on `0.2.2-rc.5` stops applying on `0.2.2-rc.6`, and the plugin needs a new grant.

## Limits

- Client halves are not verified. A plugin whose Host rows are all `active` can still render nothing in the browser; the report names the bundles that carry `dsh.client`.
- Upgrade-guide contract matching is not implemented. A renamed method or slot prop does not show up here.
- No periodic check for new dsh releases. The report records the registry's `latest` tag whenever a check runs.

## Install

1. Keep this directory somewhere stable.
2. In dsh, run `plugin_manager` with action `install_bundle` and the absolute directory path, or open **Plugins → Add plugin** and pick the directory.
3. The first report is written about 3 seconds after the plugin activates. Call `plugin_compat status` to read it.

## Configure

```yaml
- id: plugin-compat
  name: '@local/dsh-plugin-compat'
  config:
    checkOnBoot: true
    checkLatest: true
```

| Key | Default | Effect |
|---|---|---|
| `checkOnBoot` | `true` | Evaluate after start |
| `checkLatest` | `true` | Query the registry for the newest dsh version |
| `stateDir` | `~/.dsh/plugin-compat` | Where state and reports go |
| `reportKeep` | `3` | Number of reports to keep |

## License

MIT. See [LICENSE](LICENSE).
