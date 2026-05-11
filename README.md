# testmon-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[TestMonitor](https://www.testmonitor.com/). Lets Claude, GitHub Copilot,
Cursor, etc. **author acceptance test cases** in TestMonitor and **read back
UAT feedback** from test runs and defects.

- Pure Node.js / TypeScript — distributed via `npx` or Docker.
- Auth: TestMonitor Personal Access Token (Bearer).
- Stdio transport (works with every major MCP client).
- Read-only mode for safe shared setups.

## Install & run

### Via `npx` (recommended)

```bash
TESTMONITOR_DOMAIN=acme.testmonitor.com \
TESTMONITOR_TOKEN=tm_pat_xxx \
npx -y @wyocode/testmon-mcp
```

### Via Docker

```bash
docker run -i --rm \
  -e TESTMONITOR_DOMAIN=acme.testmonitor.com \
  -e TESTMONITOR_TOKEN=tm_pat_xxx \
  ghcr.io/your-org/testmon-mcp:latest
```

## Configuration

| Var | Required | Description |
| --- | --- | --- |
| `TESTMONITOR_DOMAIN` | yes | e.g. `acme.testmonitor.com` (no scheme) |
| `TESTMONITOR_TOKEN` | yes | Personal Access Token from My Account → API |
| `TESTMONITOR_DEFAULT_PROJECT_ID` | no | Lets tools/prompts omit `projectId` |
| `TESTMONITOR_TIMEOUT_MS` | no | Per-request timeout, default `15000` |
| `TESTMONITOR_READONLY` | no | `true` hides all create/update tools |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` |

## Client setup (`mcp.json`)

### A — PAT inline (simplest; do not commit)

```jsonc
{
  "mcpServers": {
    "testmonitor": {
      "command": "npx",
      "args": ["-y", "@wyocode/testmon-mcp"],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN":  "tm_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### B — PAT from OS env (safe to commit)

```jsonc
{
  "mcpServers": {
    "testmonitor": {
      "command": "npx",
      "args": ["-y", "@wyocode/testmon-mcp"],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN": "${env:TESTMONITOR_TOKEN}"
      }
    }
  }
}
```

### C — VS Code `inputs` prompt (secret store)

```jsonc
{
  "inputs": [
    { "id": "tmToken", "type": "promptString", "description": "TestMonitor PAT", "password": true }
  ],
  "servers": {
    "testmonitor": {
      "command": "npx",
      "args": ["-y", "@wyocode/testmon-mcp"],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN": "${input:tmToken}"
      }
    }
  }
}
```

### D — Docker variant

```jsonc
{
  "mcpServers": {
    "testmonitor": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "TESTMONITOR_DOMAIN",
        "-e", "TESTMONITOR_TOKEN",
        "ghcr.io/your-org/testmon-mcp:latest"
      ],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN": "${env:TESTMONITOR_TOKEN}"
      }
    }
  }
}
```

## Tools

| Tool | Read | Write |
| --- | --- | --- |
| `testmonitor_projects_list` / `_get` | ✓ | |
| `testmonitor_milestones_list` | ✓ | |
| `testmonitor_users_list` | ✓ | |
| `testmonitor_requirements_list` | ✓ | |
| `testmonitor_testsuites_list` / `_create` | ✓ | ✓ |
| `testmonitor_testcases_list` / `_get` | ✓ | |
| `testmonitor_testcases_create` / `_bulk_create` / `_update` | | ✓ |
| `testmonitor_testruns_list` / `_get` / `_create` | ✓ | ✓ |
| `testmonitor_testresults_list` / `_submit` | ✓ | ✓ |
| `testmonitor_issues_list` / `_create` | ✓ | ✓ |

## Resources

- `testmonitor://run/{runId}/report` — Markdown summary of a run (counts, failed cases).

## Prompts

- `generate-acceptance-tests` — turn a requirement / user story into bulk-created test cases.
- `summarize-uat-feedback` — produce a delivery-ready UAT report from a run.
- `triage-failed-tests` — propose defects for each failed result.

## Develop

```bash
npm install
npm run build
TESTMONITOR_DOMAIN=... TESTMONITOR_TOKEN=... npm start
```

## License

MIT

