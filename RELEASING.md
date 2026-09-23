# Releasing Nudge

Two artifacts ship from this repo: the **plugin** (via a git clone or a website's
`plugin.tar.gz`) and the **`nudge-agent` CLI** (via npm and the Homebrew tap). They are
versioned in lockstep and released together.

## 1. Bump the version

Raise the version to `X.Y.Z` in **both** `package.json` files — `./package.json` and
`./cli/package.json` — then commit. Keep them equal; `status` prints both, and a
mismatch mid-release is confusing to read.

## 2. Tag and push

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The tag is what the Homebrew formula downloads, so it must exist before step 4. If
`main` has moved past the commit you want to release, tag that commit explicitly.

## 3. Publish to npm

```bash
cd cli
npm publish --dry-run     # prints the exact file list first
npm publish               # prompts for a 2FA/OTP if 2FA is on the account
```

The dry run should list exactly three files: `nudge-agent.mjs`, `package.json`,
`README.md`. A published version can never be reused, and unpublishing is only
possible for 72 hours — so treat the version number as spent the moment you publish.

## 4. Update the Homebrew tap

```bash
curl -fsSL https://github.com/tomfc23/nudge/archive/refs/tags/vX.Y.Z.tar.gz -o /tmp/nudge.tar.gz
shasum -a 256 /tmp/nudge.tar.gz
```

Put that `url` and `sha256` into `Formula/nudge-agent.rb` in
[tomfc23/homebrew-nudge](https://github.com/tomfc23/homebrew-nudge), commit and push, then:

```bash
brew install --build-from-source ./Formula/nudge-agent.rb
brew test nudge-agent
```

## 5. Verify both channels

```bash
npm view nudge-agent version     # → X.Y.Z
nudge-agent --version            # → nudge-agent X.Y.Z
```

Then, on a clean machine: `nudge-agent install`, confirm the phone receives the
wizard's test push, and check `nudge-agent status` reports it.

## Notes

- The formula installs **`cli/nudge-agent.mjs` and `cli/package.json`**. The CLI reads
  its sibling `package.json` for `--version` — install only the script and users get
  `nudge-agent unknown`. It also needs the executable bit (`chmod 755` in git); npm
  sets that on install, `bin.install_symlink` does not.
- `homebrew-core` (the right long-term home for CLI-only software; casks are for
  GUI/prebuilt apps) requires a repo at least 30 days old plus 75 stars / 30 forks, or
  **225 stars / 90 forks for a self-submission by the repo owner**. Revisit once that is
  true — the third-party tap works in the meantime.
- The CLI fetches the installer from `raw.githubusercontent.com/tomfc23/nudge/main`, so a
  broken `main` breaks installs for everyone. Tagging does not pin installs:
  `install.sh` has no ref/branch option yet. Adding `NTFY_GIT_REF` to its
  `git clone` would close that gap.
