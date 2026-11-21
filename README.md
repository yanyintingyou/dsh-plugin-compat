# dsh-plugin-compat

[English](README.md) | [中文](README.zh.md)

dsh checks `engines.dsh` when it installs or activates a plugin, and falls back to the plugin's `@deepseek-ai/dsh-*` peer dependencies. Local plugins written by hand usually declare neither. After an upgrade, nothing tells you whether they still load. This plugin runs that check on the first start after a version change, writes a report, and leaves the fixing to you.

It stays read-only: it never enables, disables, updates, removes or edits a plugin.

## What it checks

Activation comes straight from the plugin manager. Each loader row reports `enabled`, `fiberPhase` and a diagnostic. `active` means the module imported, `apply` returned, and the injected services existed. `failed` carries the original diagnostic, which goes into the report.

The version guard is `engines.dsh`, or the dsh peer dependencies when that field is absent. A plugin the manager rejects as `incompatible-version` gets its own line with the ranges that failed. So does a plugin running under an exact-version exemption.

The checker skips official bundles that ship inside the installation. Their version always equals the dsh version.

Official catalog bundles installed on demand get their own entry. They pin the runtime version they were installed under, do not update themselves, and need a reinstall at the current version.

Profile leftovers also appear: links in `node_modules` that point at a missing directory, bundles selected but never installed, and dependencies that are not plugin bundles.

## When it runs

Every start evaluates once and runs a check only when one of these holds:

- the dsh version differs from the recorded one, which covers an upgrade;
- the installation's `package.json` changed, which covers a reinstall of the same version;
- the profile's dependency or bundle list changed;
- the previous run did not finish.

Two events also trigger it: `plugin-manager/changed` and `app-boot/config-reload`. Both coalesce into one check 1.5 seconds after the last event. The tool's `check` action runs one on the spot.

The first sample lands three seconds after start. Any row still `pending` or `loading` gets a second sample seven seconds later. User messages, turns, model requests and file watching never trigger a check.

## Files

Everything goes to `~/.dsh/plugin-compat/`, and the plugin keeps the three newest reports:

- `state.json` holds the last runtime version, an install stamp, the plugin list, and the cached registry version.
- `report-<version>.json` is the full report.
- `report.md` is the same report written for reading.

Each plugin entry carries a run state (normal, broken, not ready, disabled) and a guard state (declared, exempted, none, unmet, unknown). The pending count adds up broken rows, rows not ready, plugins on an exemption, enabled plugins without a guard, stale official bundles, and profile leftovers. Every pending item lists its evidence, one suggested action, and where to do it: the plugin page, `plugin_manager`, or the plugin source.

## Tool

`plugin_compat` offers three actions:

- `status` reads the latest report.
- `check` runs a check now and refreshes the registry lookup.
- `explain <name>` returns one plugin's rows, evidence and suggestion.

## Prerelease builds

On a prerelease runtime such as `0.2.2-rc.5`, a plugin that declares a stable range like `^0.2.2` does not satisfy that range. That follows from how semver treats prereleases, and the same plugin becomes compatible once the stable release ships. An exemption binds to one exact runtime version, so one granted on `0.2.2-rc.5` lapses on `0.2.2-rc.6`.

## Limits

- The plugin does not verify browser-side halves. A plugin with every Host row `active` can still render nothing in the page; the report names the bundles that carry `dsh.client`.
- Upgrade-guide matching is not implemented, so a renamed method or slot prop stays invisible here.
- No periodic check for a newer dsh. Each check records the registry's `latest` tag while it runs.

## Install

Keep the directory somewhere stable. In dsh, run `plugin_manager` with `install_bundle` and the absolute path, or open **Plugins → Add plugin** and pick the directory. The first report appears about three seconds after activation; `plugin_compat status` reads it.

## Configure

```yaml
- id: plugin-compat
  name: '@local/dsh-plugin-compat'
  config:
    checkOnBoot: true
    checkLatest: true
```

| Key | Default | Effect |
| --- | --- | --- |
| `checkOnBoot` | `true` | Evaluate after start |
| `checkLatest` | `true` | Query the registry for the newest dsh version |
| `stateDir` | `~/.dsh/plugin-compat` | Where state and reports go |
| `reportKeep` | `3` | Number of reports to keep |

## License

MIT. See [LICENSE](LICENSE).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
