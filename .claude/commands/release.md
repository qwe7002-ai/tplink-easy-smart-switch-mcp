Cut a new release for tplink-easy-smart-switch-mcp.

Usage:
  /release <version>    — e.g. /release 0.5.0

## Steps

1. **Validate** — $ARGUMENTS must be a semver string like `0.5.0` (no leading `v`).
   If it is missing or malformed, stop and ask for the version.

2. **Pre-flight checks**:
   - Run `bun run typecheck`. Abort if it fails.
   - Run `git status` — abort if there are uncommitted changes.
   - Run `git log --oneline origin/master..HEAD` — show what will be released.

3. **Bump version** — update `"version"` in `package.json` to the new version.
   Also update the version string in `src/index.ts`:
   ```ts
   const server = new McpServer({ name: "tplink-easy-smart-switch-mcp", version: "<new-version>" });
   ```

4. **Commit** — stage `package.json` and `src/index.ts`, commit:
   ```
   git commit -m "chore: bump version to <version>"
   ```

5. **Tag** — create an annotated tag:
   ```
   git tag -a v<version> -m "Release v<version>"
   ```

6. **Push**:
   ```
   git push origin HEAD
   git push origin v<version>
   ```
   Pushing the tag will trigger the `release.yml` GitHub Actions workflow, which
   builds Linux and Windows binaries and creates a GitHub release automatically.

7. **Confirm** — show the tag that was pushed and remind the user to check the
   Actions tab on GitHub for the build status.

## Notes
- Do NOT create the GitHub release manually — the `release.yml` workflow does it.
- If `git push` fails, do not retry with `--force`. Diagnose the error first.
