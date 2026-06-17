# CLAUDE.md

## API Reference

A full OpenAPI spec for the CFS API is available at `~/cfs/api-cloudrun/openapi.json`. It is auto-generated on each commit in that repo and documents all endpoints, request/response schemas, and propagation rules.

## Commit Guidelines (Semantic Release)

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format. Semantic Release parses these to determine the next version.

| Prefix | Version Bump | Example |
|---|---|---|
| `fix:` | Patch (`1.14.1`) | `fix(orders): correct tax rounding` |
| `feat:` | Minor (`1.15.0`) | `feat(orders): add bulk create` |
| `feat!:` / `BREAKING CHANGE:` | Major (`2.0.0`) | `feat!: remove legacy order format` |
| `chore:` / `docs:` / `ci:` | No release | `chore: update dev deps` |

## Publish Protocol

1. **Develop locally** — commit to a feature branch, then push/merge to `beta`.
2. **Beta publish** — a GitHub Action runs semantic release on the `beta` branch, publishing to JSR with a `-beta.N` prerelease tag.
   - e.g. if current version is `1.14.0`: a `fix:` commit → `1.14.1-beta.1`, a `feat:` commit → `1.15.0-beta.1`, a breaking commit → `2.0.0-beta.1`.
   - Subsequent pushes to `beta` increment the prerelease number (`-beta.2`, `-beta.3`, …).
3. **Stable publish** — merge the `beta` branch into `main` via GitHub PR. Semantic release runs again and publishes the stable version (e.g. `1.15.0`) to JSR.
