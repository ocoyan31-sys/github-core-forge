# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ocoyan31-sys/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ocoyan31-sys/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

**github-core-forge** is a standalone, GitHub-compatible git forge that runs as one Node.js process and serves four surfaces from its own in-memory store — no UI, no database, no git binary, Node standard library only:

- **Git smart HTTP** — upload-pack protocol v2 (capability advertisement, `ls-refs` with peel/symrefs/unborn and server-side ref-prefix filtering, fetch with shallow deepen semantics) and receive-pack v0 with `report-status`, `side-band-64k` and per-ref fast-forward enforcement. Packfiles are read and written in-process, including OFS/REF delta resolution for pushed packs and SHA-1 verification throughout.
- **REST v3** under `/api/v3` — repositories (create/read/patch/delete, Link-header pagination), branches, commits, the contents API (create/update/delete with stale-sha 409), labels, issues with comments, and pull requests with file diffs and three-way squash merges (conflicts answer 405).
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server` send: viewer, repository fields, `__type` introspection, issue/pull reads, cursor pagination, `node(id:)` global-id round-trips, operation batching, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations.
- **MCP** at `/mcp` — JSON-RPC streamable HTTP speaking the modern `server/discover` era, with the six github-mcp-server tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) backed by the same store, so an object created over MCP is the same object over REST.

Everything is content-addressed exactly as git computes it: one shared object store, per-repository refs, and merges computed as real three-way tree merges over the merge base.

## Run it

```sh
npm start    # node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ environment lifecycle (bind an ephemeral port, register it, wait to be told the trial is done). The forge itself lives in `app.ts` (HTTP + REST), `gitproto.ts` (the git wire), `store.ts` (objects, trees, merges, records), `graphql.ts` (the GraphQL parser/executor) and `mcp.ts` (the MCP endpoint).

---

<sub>Entered on [make.fun](https://make.fun/?ref=5h2hvham&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
