# Changelog

## Unreleased

- Report unrecognised CLI output and malformed numeric battery readings as errors
  instead of hiding the plugin or displaying a partial inventory.
- Correct the minimum macOS version to 13.5 for Node.js 24.

## 0.1.1

- Open the menu immediately using the latest completed result instead of
  blocking while `openlogi list` runs; five-minute and manual refreshes remain
  available.

## 0.1.0

- Initial SwiftBar integration using the OpenLogi CLI.
- Preserve Raycast/Omarchy device selection, sorting, charging and connection behaviour.
- Bounded command execution, process cleanup and refresh coalescing.
- Native menu rendering without a persistent battery cache.
- Installer, uninstaller, automated tests and macOS/Linux CI.
- Reproducible pnpm installs and mise-pinned Node 24 LTS development environment.
- CI checks the mise-pinned Node 24 LTS and the latest Node release on both platforms.
