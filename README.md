# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Keven3027/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Keven3027/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process: git smart HTTP (protocol v0 + v2, shallow fetch, packfiles, sideband, non-fast-forward rejection with per-ref report-status), the REST v3 API (repos, branches, refs, commits, contents, labels, issues, comments, pulls and merges, GitHub-shaped JSON with Link-header pagination), the GraphQL v4 API (gh's queries and mutations, cursor pagination, `__type` introspection, Relay `node(id:)`, operation batching, opaque global ids) and an MCP server (`server/discover`, `initialize`, six github-mcp-server-style tools over Streamable HTTP JSON-RPC 2.0) — all reading and writing one shared in-memory object store. Zero dependencies: Node 22 standard library only.

Local self-tests: 121 git-core assertions, 33 GraphQL assertions, 24 MCP assertions. Official conformance suite: 120/120 checks, all four performance workloads full marks.

## Run it

```sh
node main.ts  # serves git + REST (/api/v3) + GraphQL (/api/graphql) + MCP (/mcp) on one port
```

Set `MAKEFUN_SHOP_TOKEN` (bearer token) and `MAKEFUN_SHOP_LOGIN` (the account login) to serve as that user.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g2c6ddth&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
