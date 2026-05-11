# testmon-mcp

[![npm](https://img.shields.io/npm/v/@wyocode/testmon-mcp/alpha.svg)](https://www.npmjs.com/package/@wyocode/testmon-mcp)
[![CI](https://github.com/wyocode/testmon-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wyocode/testmon-mcp/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[TestMonitor](https://www.testmonitor.com/). Lets Claude, GitHub Copilot,
Cursor, etc. **author acceptance test cases** in TestMonitor and **read back
UAT feedback** from test runs, requirement coverage, and defects.

- Pure Node.js / TypeScript — distributed via `npx` or Docker.
- Auth: TestMonitor Personal Access Token (Bearer).
- Stdio transport (works with every major MCP client).
- Read-only mode for safe shared setups.
- 32 tools, 4 prompts, 2 resources. Supports image attachments (base64 or URL) for visual step instructions and requirement → test case coverage rollup.

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

All tools are prefixed with `testmonitor_`.

### Reads
- `projects_list`, `projects_get`
- `users_list`
- `milestones_list`, `milestone_types_list`
- `test_result_statuses_list`
- `issue_categories_list`, `issue_statuses_list`
- `testcase_folders_list`
- `testcases_list`, `testcases_get`
- `testcase_attachments_list`
- `testruns_list`, `testruns_get`
- `testresults_list`, `testresult_attachments_list`
- `issues_list`
- `requirements_list`, `requirements_get`, `requirement_types_list`
- `requirement_coverage` — rolls up linked test case statuses into pass/fail/not-run + a `complete` verdict.

### Writes (hidden when `TESTMONITOR_READONLY=true`)
- `testcases_create`, `testcases_bulk_create`, `testcases_update`
- `testcase_attachment_upload` — attach an image to a test case. Accepts `data_base64` (AI-generated images), `path` (local file on the MCP host), or `url` (public link).
- `testruns_create`
- `testresults_submit`
- `testresult_attachment_upload` — attach evidence to a result (`data_base64`, `path`, or `url`). Also required to submit a `Fail` result on tenants that mandate attachments.
- `issues_create`
- `requirements_create` (auto-resolves a default requirement type).

## Resources

- `testmonitor://project/{projectId}/run/{runId}/report` — Markdown summary of a run.
- `testmonitor://requirement/{requirementId}/coverage` — Markdown coverage report (linked test cases + verdict).

## Prompts

- `generate-acceptance-tests` — turn a requirement / user story into bulk-created test cases (links them back to the requirement, asks for screenshots on UI steps).
- `summarize-run` — produce a delivery-ready UAT report from a run.
- `triage-failures` — propose defects for each failed result.
- `check-requirement-coverage` — read the coverage resource and decide whether a requirement is met.

## Develop

```bash
npm install
npm run build
TESTMONITOR_DOMAIN=... TESTMONITOR_TOKEN=... npm start
```

## License

MIT

