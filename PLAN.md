# TestMonitor MCP Server — Build Plan

## 1. Goal

Build a **Model Context Protocol (MCP) server** that wraps the
[TestMonitor REST API](https://docs.testmonitor.com/) so that AI assistants
(Claude Desktop, GitHub Copilot, Cursor, etc.) can:

1. **Author acceptance test scripts / test cases** directly inside TestMonitor
   from a chat conversation (turning requirements or user stories into
   structured test cases, suites, and runs).
2. **Retrieve feedback** from executed test runs (results, defects, comments,
   attachments) and feed it back into the development loop to accelerate
   delivery and UAT cycles.

Distribution targets:

- `npx @your-scope/testmon-mcp` — zero-install run via npm registry.
- `docker run ghcr.io/your-org/testmon-mcp` — containerized run.
- Local `node dist/index.js` for development.

---

## 2. Tech Stack

| Concern              | Choice                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| Language             | TypeScript (Node ≥ 20)                                                  |
| MCP SDK              | `@modelcontextprotocol/sdk`                                             |
| Transport            | `stdio` (primary, for Claude/Copilot); optional `http+sse` for remote   |
| HTTP client          | `undici` (built-in `fetch` works too)                                   |
| Schema / validation  | `zod` (also used to derive MCP tool input schemas)                      |
| Config               | Env vars (`TESTMONITOR_DOMAIN`, `TESTMONITOR_TOKEN`)                    |
| Build                | `tsup` → ESM + single CLI bin                                           |
| Lint/format          | `eslint` + `prettier`                                                   |
| Tests                | `vitest` + `msw` for API mocking                                        |
| Container            | Multi-stage `Dockerfile` on `node:20-alpine`                            |
| CI/CD                | GitHub Actions — lint, test, publish to npm + GHCR on tag               |

---

## 3. TestMonitor API Notes

- Base URL: `https://{domain}/api/v1` (e.g. `acme.testmonitor.com`).
- Auth: `Authorization: Bearer <Personal Access Token>` (created in account
  settings → API).
- HTTPS only, JSON in/out, standard REST verbs and status codes.
- Official npm helpers exist (`@testmonitor/testmonitor-cli`, test-automation
  packages); we will call the REST API directly to stay generic, but mirror
  their resource model.

Key resources we will expose (subset to start, expand later):

- Projects, Milestones
- Requirements / User Stories
- Test Cases, Test Suites
- Test Runs, Test Results
- Issues / Defects
- Users, Comments, Attachments

---

## 4. Repository Layout

```
testmon-mcp/
├─ src/
│  ├─ index.ts                # CLI bin, boots MCP server over stdio
│  ├─ server.ts               # MCP server wiring (tools/resources/prompts)
│  ├─ config.ts               # env parsing + validation (zod)
│  ├─ client/
│  │  ├─ http.ts              # thin fetch wrapper (auth, retry, errors)
│  │  └─ testmonitor.ts       # typed API client (projects, testcases, runs…)
│  ├─ tools/                  # one file per MCP tool group
│  │  ├─ projects.ts
│  │  ├─ testcases.ts
│  │  ├─ testruns.ts
│  │  ├─ results.ts
│  │  └─ issues.ts
│  ├─ resources/              # MCP resources (read-only browsable data)
│  │  └─ project-overview.ts
│  ├─ prompts/                # MCP prompts (reusable assistant playbooks)
│  │  ├─ generate-acceptance-tests.ts
│  │  └─ summarize-uat-feedback.ts
│  └─ util/
│     ├─ logger.ts
│     └─ markdown.ts
├─ test/
├─ Dockerfile
├─ .dockerignore
├─ package.json
├─ tsconfig.json
├─ tsup.config.ts
├─ README.md
└─ PLAN.md
```

---

## 5. MCP Surface

### 5.1 Tools (write + query actions)

Naming convention: `testmonitor.<resource>.<verb>`.

**Discovery**

- `testmonitor.projects.list`
- `testmonitor.projects.get` (id)
- `testmonitor.milestones.list` (projectId)
- `testmonitor.users.list`

**Authoring acceptance tests**

- `testmonitor.requirements.list` (projectId, query?)
- `testmonitor.testcases.list` (projectId, suiteId?, query?)
- `testmonitor.testcases.create`
  - input: `projectId`, `name`, `description`, `preconditions?`, `steps[]` (action + expected), `priority?`, `labels?`, `requirementIds?`
- `testmonitor.testcases.update`
- `testmonitor.testsuites.create` / `list`
- `testmonitor.testcases.bulkCreate` — accepts an array; primary tool the LLM uses after parsing a user story.

**Execution & feedback**

- `testmonitor.testruns.list` (projectId, status?)
- `testmonitor.testruns.create` (projectId, name, testCaseIds[], milestoneId?)
- `testmonitor.testresults.list` (runId)
- `testmonitor.testresults.submit` (runId, testCaseId, status: passed|failed|blocked|skipped, notes?, evidenceUrls?)
- `testmonitor.issues.list` (projectId, filter?)
- `testmonitor.issues.create` (linked to failed result)

### 5.2 Resources (read-only, addressable)

- `testmonitor://project/{id}/overview`
- `testmonitor://run/{id}/report` — rendered Markdown summary of a run for the LLM to ingest.
- `testmonitor://testcase/{id}`

### 5.3 Prompts (reusable playbooks)

- **`generate-acceptance-tests`**
  Args: `projectId`, `requirementText` (or `requirementId`).
  Guides the model to produce Gherkin-style or step/expected-result test cases
  and call `testcases.bulkCreate`.
- **`summarize-uat-feedback`**
  Args: `runId`. Pulls results + linked issues and asks the model to produce
  a delivery-ready feedback report (blockers, regressions, suggested fixes).
- **`triage-failed-tests`**
  Args: `runId`. For each failed result, propose a defect and optionally call
  `issues.create`.

---

## 6. Configuration

Environment variables (validated at startup with `zod`):

| Var                       | Required | Notes                                              |
| ------------------------- | -------- | -------------------------------------------------- |
| `TESTMONITOR_DOMAIN`      | yes      | e.g. `acme.testmonitor.com`                        |
| `TESTMONITOR_TOKEN`       | yes      | Personal Access Token (Bearer)                     |
| `TESTMONITOR_DEFAULT_PROJECT_ID` | no | Lets prompts omit `projectId`                  |
| `TESTMONITOR_TIMEOUT_MS`  | no       | Default 15000                                      |
| `LOG_LEVEL`               | no       | `info` \| `debug` \| `error`                       |
| `MCP_TRANSPORT`           | no       | `stdio` (default) \| `http`                        |
| `MCP_HTTP_PORT`           | no       | Used when transport = http                         |

Secrets are never logged. The token is read from env only — never accepted as
a tool argument from the LLM (prevents prompt-injection exfiltration).

---

## 7. Security & Safety

- **Read vs. write split:** support a `TESTMONITOR_READONLY=true` flag that
  hides all `create`/`update`/`delete` tools — recommended default for shared
  Copilot setups.
- **Confirmation hints:** destructive tools include `annotations.destructiveHint`
  and `annotations.requiresConfirmation` per MCP spec.
- **Rate-limit handling:** honor `Retry-After`, exponential backoff for 429/5xx.
- **Input validation:** every tool input is a zod schema; reject unknown fields.
- **Prompt-injection hygiene:** API responses inserted into tool output are
  wrapped in fenced JSON blocks; URLs/HTML are not auto-followed.
- **OWASP:** no dynamic URL building from untrusted strings, path params are
  encoded, TLS enforced.

---

## 8. Deployment

### 8.1 npm

```jsonc
// package.json (excerpt)
{
  "name": "@your-scope/testmon-mcp",
  "bin": { "testmon-mcp": "dist/index.js" },
  "engines": { "node": ">=20" }
}
```

Yes — the entire server is plain **Node.js / TypeScript**, so `npm publish`
ships it to the public npm registry and `npx` runs it with zero install on
any machine that has Node ≥ 20. No native deps, no Python, no extra runtime.

#### Option A — PAT inline in `mcp.json` (simplest, self-contained)

Good for personal machines / quick starts. The token lives in the config file
itself, so the file must be treated as a secret (don't commit it).

```jsonc
// .vscode/mcp.json  or  ~/.config/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "testmonitor": {
      "command": "npx",
      "args": ["-y", "@your-scope/testmon-mcp"],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN":  "tm_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

#### Option B — PAT from the OS environment (recommended for shared/committed configs)

The config is safe to commit; the secret stays in your shell / OS keychain.

```jsonc
{
  "mcpServers": {
    "testmonitor": {
      "command": "npx",
      "args": ["-y", "@your-scope/testmon-mcp"],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN": "${env:TESTMONITOR_TOKEN}"
      }
    }
  }
}
```

#### Option C — VS Code `inputs` prompt (no plaintext anywhere)

VS Code / Copilot `mcp.json` supports `inputs` that prompt once and store in
the secret store:

```jsonc
{
  "inputs": [
    { "id": "tmToken", "type": "promptString", "description": "TestMonitor PAT", "password": true }
  ],
  "servers": {
    "testmonitor": {
      "command": "npx",
      "args": ["-y", "@your-scope/testmon-mcp"],
      "env": {
        "TESTMONITOR_DOMAIN": "acme.testmonitor.com",
        "TESTMONITOR_TOKEN": "${input:tmToken}"
      }
    }
  }
}
```

> The server reads the PAT only from `process.env.TESTMONITOR_TOKEN`, so all
> three options work without code changes. Pinning a version is recommended
> for reproducibility: `"args": ["-y", "@your-scope/testmon-mcp@1.2.3"]`.

### 8.2 Docker

```dockerfile
# Dockerfile (sketch)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --production

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
```

Client config:

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
      ]
    }
  }
}
```

### 8.3 CI

GitHub Actions workflow:

1. `lint` + `test` on PR.
2. On tag `v*.*.*`: build, publish to npm (`--access public`), build & push
   multi-arch image to GHCR.

---

## 9. Milestones

| # | Milestone                    | Output                                                       |
| - | ---------------------------- | ------------------------------------------------------------ |
| 1 | Skeleton                     | repo, tsconfig, MCP server boots over stdio, `ping` tool     |
| 2 | TestMonitor client           | typed client + auth + error mapping + unit tests             |
| 3 | Read tools                   | projects/testcases/testruns/results list & get               |
| 4 | Authoring tools              | `testcases.create` + `bulkCreate`, suites, requirements link |
| 5 | Execution feedback           | results submit, run report resource, issues create           |
| 6 | Prompts                      | `generate-acceptance-tests`, `summarize-uat-feedback`        |
| 7 | Packaging                    | npm bin + Dockerfile + README quickstart                     |
| 8 | CI/CD                        | GitHub Actions: test, publish npm, push GHCR                 |
| 9 | Hardening                    | readonly mode, rate-limit, retry, telemetry off-by-default   |

---

## 10. Open Questions

1. Exact TestMonitor field names for `steps` / `preconditions` — confirm
   against the OpenAPI document (downloadable from the docs site) before
   freezing tool schemas.
2. Do we need OAuth / SSO in addition to Personal Access Tokens? (PAT is
   sufficient for v1.)
3. Multi-tenant: should one server instance support multiple `domain`s, or
   require one process per environment? (v1: one per env, simpler & safer.)
4. Should we ship a thin wrapper around `@testmonitor/testmonitor-cli`
   instead of re-implementing HTTP calls? (Decision: direct REST for
   flexibility; revisit if CLI covers everything.)

---

## 11. Next Step

Implement Milestone 1 (skeleton + stdio MCP server + `testmonitor.projects.list`
as the first real tool) so the end-to-end loop from Claude/Copilot → MCP →
TestMonitor can be smoke-tested before expanding the surface.
