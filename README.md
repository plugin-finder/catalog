# plugin-localizer / catalog

Public catalog index for **Plugin Localizer**. `plugin-index.json` lists RPG Maker
MV/MZ plugins published on GitHub under the **MIT License** or the **Unlicense**.
The app fetches this file to populate its in-app plugin search.

## Files
- `plugin-index.json` — the catalog (an array of plugin entries).
- `build-plugin-index.mjs` — self-contained generator (Node 20+, no dependencies).
- `index-sources.json` — the repos/users to scan (`repoDirs`, `repos`, `users`).
- `.github/workflows/update-catalog.yml` — rebuilds the catalog **daily (00:07 JST)**
  and on demand, committing changes automatically.

## Author opt-out
Plugin authors can exclude their plugin by adding `@no-localize` anywhere in the
plugin source. Marked plugins are skipped at build time.

## Manual rebuild
```
GITHUB_TOKEN=<token> node build-plugin-index.mjs
```
