# makefun-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shibadogcap-ops/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shibadogcap-ops/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every edit format an AI model writes. It reads a unified diff (line numbers forgiven), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON, finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace, indentation), and writes every change or none, printing one line per changed file or one line per failed edit. It runs as a single Node 22 file with the standard library alone: no install, no network, nothing to configure.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is a patch file in the working tree (or standard input when absent or `-`); `--check` reports without writing, `--strict` matches lines exactly. SPEC.md in this repository is the full specification mend implements.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g2zss0a3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
