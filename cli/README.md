# nudge-agent

Manage a [Nudge](https://github.com/tomfc23/nudge) install — phone notifications
for OpenCode and Codex.

```bash
nudge-agent install        # run the setup wizard
nudge-agent status         # what is wired up right now
nudge-agent update         # bring the plugin up to date
nudge-agent add codex      # wire one more harness
nudge-agent remove codex   # unwire one harness
nudge-agent uninstall      # remove Nudge (--level 3 --yes also wipes server data)
```

`status`, `update`, `add`, `remove` and `uninstall` operate on an existing install;
`install` runs the official wizard from the project site. This package is only the
CLI — the plugin and server are set up by the installer, which the CLI downloads
and runs.

Zero dependencies. Needs Node 18+ and macOS or Linux (the install itself uses
Docker, plus launchd or systemd for persistence).

Full documentation: <https://github.com/tomfc23/nudge>
