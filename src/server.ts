import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TestMonitorClient } from "./client/testmonitor.js";
import { TestMonitorApiError } from "./client/http.js";
import type { Config } from "./config.js";
import type { Logger } from "./util/logger.js";

interface BuildOptions {
  client: TestMonitorClient;
  config: Config;
  logger: Logger;
}

const PKG_NAME = "testmon-mcp";
const PKG_VERSION = "0.1.0";

export function buildServer(opts: BuildOptions): McpServer {
  const { client, config, logger } = opts;
  const server = new McpServer({ name: PKG_NAME, version: PKG_VERSION });

  const ok = (value: unknown) => ({
    content: [{ type: "text" as const, text: jsonBlock(value) }],
  });
  const err = (e: unknown) => {
    const msg =
      e instanceof TestMonitorApiError
        ? `TestMonitor API ${e.status}: ${stringify(e.body)}`
        : e instanceof Error
          ? e.message
          : String(e);
    logger.error("Tool error", msg);
    return {
      isError: true,
      content: [{ type: "text" as const, text: msg }],
    };
  };
  const wrap =
    <Args extends Record<string, unknown>>(fn: (args: Args) => Promise<unknown>) =>
    async (args: Args) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return err(e);
      }
    };
  const projectId = (input?: number) => {
    const id = input ?? config.defaultProjectId;
    if (!id) {
      throw new Error(
        "projectId is required (or set TESTMONITOR_DEFAULT_PROJECT_ID).",
      );
    }
    return id;
  };

  // ========================================================================
  // READ TOOLS
  // ========================================================================

  server.registerTool(
    "testmonitor_projects_list",
    {
      title: "List projects",
      description: "List TestMonitor projects accessible to the token.",
      inputSchema: {
        query: z.string().optional(),
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    wrap(async ({ query, page, limit }) =>
      client.listProjects({ query, page, limit }),
    ),
  );

  server.registerTool(
    "testmonitor_projects_get",
    {
      title: "Get project",
      description: "Get a single project by id.",
      inputSchema: { projectId: z.number().int().positive() },
    },
    wrap(async ({ projectId: id }) => client.getProject(id)),
  );

  server.registerTool(
    "testmonitor_milestones_list",
    {
      title: "List milestones",
      description: "List milestones for a project.",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) => client.listMilestones(projectId(id))),
  );

  server.registerTool(
    "testmonitor_milestone_types_list",
    {
      title: "List milestone types",
      description:
        "List configured milestone types for a project (lookup for creating milestones).",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) => client.listMilestoneTypes(projectId(id))),
  );

  server.registerTool(
    "testmonitor_test_result_statuses_list",
    {
      title: "List test result statuses",
      description:
        "List the test_result_status values configured for a project (passed, failed, blocked, etc.).",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) =>
      client.listTestResultStatuses(projectId(id)),
    ),
  );

  server.registerTool(
    "testmonitor_issue_categories_list",
    {
      title: "List issue categories",
      description: "Lookup values used when creating issues.",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) =>
      client.listIssueCategories(projectId(id)),
    ),
  );

  server.registerTool(
    "testmonitor_issue_statuses_list",
    {
      title: "List issue statuses",
      description: "Lookup values used when creating issues.",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) => client.listIssueStatuses(projectId(id))),
  );

  server.registerTool(
    "testmonitor_users_list",
    {
      title: "List users",
      description: "List users in the TestMonitor environment.",
      inputSchema: {},
    },
    wrap(async () => client.listUsers()),
  );

  server.registerTool(
    "testmonitor_requirements_list",
    {
      title: "List requirements",
      description: "List requirements / user stories for a project.",
      inputSchema: {
        projectId: z.number().int().positive().optional(),
        query: z.string().optional(),
      },
    },
    wrap(async ({ projectId: id, query }) =>
      client.listRequirements(projectId(id), query),
    ),
  );

  server.registerTool(
    "testmonitor_requirements_get",
    {
      title: "Get requirement",
      description:
        "Fetch a single requirement, including its latest status rollup.",
      inputSchema: { requirementId: z.number().int().positive() },
    },
    wrap(async ({ requirementId }) => client.getRequirement(requirementId)),
  );

  server.registerTool(
    "testmonitor_requirement_types_list",
    {
      title: "List requirement types",
      description: "Lookup for creating requirements.",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) =>
      client.listRequirementTypes(projectId(id)),
    ),
  );

  server.registerTool(
    "testmonitor_requirement_coverage",
    {
      title: "Requirement coverage report",
      description:
        "Return a coverage summary for a requirement: each linked test case with the latest run status, plus an overall pass/fail rollup. Use this to track whether a requirement is complete (all linked cases passed).",
      inputSchema: { requirementId: z.number().int().positive() },
    },
    wrap(async ({ requirementId }) => {
      const [req, cases] = await Promise.all([
        client.getRequirement(requirementId),
        client.listRequirementTestCases(requirementId),
      ]);
      let passed = 0;
      let failed = 0;
      let notRun = 0;
      const items = cases.data.map((tc) => {
        const statusName =
          (tc.status as { type?: { name?: string } } | null | undefined)?.type
            ?.name ?? null;
        if (!statusName) notRun++;
        else if (/pass/i.test(statusName)) passed++;
        else if (/fail/i.test(statusName)) failed++;
        return {
          id: tc.id,
          name: tc.name,
          latest_status: statusName,
        };
      });
      const total = items.length;
      return {
        requirement: {
          id: req.data.id,
          name: req.data.name,
          status:
            (req.data.status as { type?: { name?: string } } | null | undefined)
              ?.type?.name ?? null,
        },
        totals: {
          total,
          passed,
          failed,
          not_run: notRun,
          pass_rate: total > 0 ? Math.round((passed / total) * 100) : 0,
          complete: total > 0 && passed === total,
        },
        test_cases: items,
      };
    }),
  );

  server.registerTool(
    "testmonitor_testcase_attachments_list",
    {
      title: "List test case attachments",
      description:
        "List attachments (screenshots, reference files) attached to a test case.",
      inputSchema: { testCaseId: z.number().int().positive() },
    },
    wrap(async ({ testCaseId }) =>
      client.listTestCaseAttachments(testCaseId),
    ),
  );

  server.registerTool(
    "testmonitor_testresult_attachments_list",
    {
      title: "List test result attachments",
      description:
        "List attachments (e.g. failure screenshots) on a submitted test result.",
      inputSchema: { testResultId: z.number().int().positive() },
    },
    wrap(async ({ testResultId }) =>
      client.listTestResultAttachments(testResultId),
    ),
  );

  server.registerTool(
    "testmonitor_testcase_folders_list",
    {
      title: "List test case folders",
      description:
        "List test case folders (the hierarchy used to organize test cases).",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) =>
      client.listTestCaseFolders(projectId(id)),
    ),
  );

  server.registerTool(
    "testmonitor_testcases_list",
    {
      title: "List test cases",
      description: "List test cases, optionally filtered by folder or search.",
      inputSchema: {
        projectId: z.number().int().positive().optional(),
        folderId: z.number().int().nonnegative().optional(),
        search: z.string().optional(),
      },
    },
    wrap(async ({ projectId: id, folderId, search }) =>
      client.listTestCases(projectId(id), { folderId, search }),
    ),
  );

  server.registerTool(
    "testmonitor_testcases_get",
    {
      title: "Get test case",
      description: "Get a single test case by id.",
      inputSchema: { testCaseId: z.number().int().positive() },
    },
    wrap(async ({ testCaseId }) => client.getTestCase(testCaseId)),
  );

  server.registerTool(
    "testmonitor_testruns_list",
    {
      title: "List test runs",
      description: "List test runs for a project.",
      inputSchema: { projectId: z.number().int().positive().optional() },
    },
    wrap(async ({ projectId: id }) => client.listTestRuns(projectId(id))),
  );

  server.registerTool(
    "testmonitor_testruns_get",
    {
      title: "Get test run",
      description: "Get a single test run by id.",
      inputSchema: { runId: z.number().int().positive() },
    },
    wrap(async ({ runId }) => client.getTestRun(runId)),
  );

  server.registerTool(
    "testmonitor_testresults_list",
    {
      title: "List test results",
      description: "List test results for a run (UAT feedback).",
      inputSchema: {
        projectId: z.number().int().positive().optional(),
        runId: z.number().int().positive().optional(),
      },
    },
    wrap(async ({ projectId: id, runId }) =>
      client.listTestResults(projectId(id), runId),
    ),
  );

  server.registerTool(
    "testmonitor_issues_list",
    {
      title: "List issues",
      description: "List issues / defects in a project.",
      inputSchema: {
        projectId: z.number().int().positive().optional(),
        query: z.string().optional(),
      },
    },
    wrap(async ({ projectId: id, query }) =>
      client.listIssues(projectId(id), query),
    ),
  );

  // ========================================================================
  // WRITE TOOLS (skipped in read-only mode)
  // ========================================================================
  if (!config.readOnly) {
    const testCaseFields = {
      name: z.string().min(1).max(255),
      description: z.string().max(10_000).optional(),
      preconditions: z.string().max(10_000).optional(),
      expected_result: z.string().max(10_000).optional(),
      instructions: z.array(z.string().min(1)).optional()
        .describe("Ordered list of step instructions (one entry per step)."),
      test_case_folder_id: z.number().int().nonnegative().optional()
        .describe("Folder id (0 = root)."),
      duration: z.number().int().positive().optional(),
      draft: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      requirements: z.array(z.number().int().positive()).optional(),
    };

    server.registerTool(
      "testmonitor_testcase_folders_create",
      {
        title: "Create test case folder",
        description: "Create a new folder for organizing test cases.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          name: z.string().min(1),
          parent_id: z.number().int().positive().optional(),
        },
      },
      wrap(async ({ projectId: id, name, parent_id }) =>
        client.createTestCaseFolder({
          project_id: projectId(id),
          name,
          parent_id,
        }),
      ),
    );

    server.registerTool(
      "testmonitor_milestones_create",
      {
        title: "Create milestone",
        description:
          "Create a milestone. Requires milestone_type_id (use testmonitor_milestone_types_list).",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          name: z.string().min(1),
          milestone_type_id: z.number().int().positive(),
          description: z.string().optional(),
          ends_at: z.string().optional(),
        },
      },
      wrap(async ({ projectId: id, ...rest }) =>
        client.createMilestone({ project_id: projectId(id), ...rest }),
      ),
    );

    server.registerTool(
      "testmonitor_testcases_create",
      {
        title: "Create test case",
        description:
          "Create a single acceptance test case. Use bulk_create for multiple at once.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          ...testCaseFields,
        },
      },
      wrap(async ({ projectId: id, ...rest }) =>
        client.createTestCase({ project_id: projectId(id), ...rest }),
      ),
    );

    server.registerTool(
      "testmonitor_testcases_bulk_create",
      {
        title: "Bulk create test cases",
        description:
          "Create many acceptance test cases at once. The primary tool for turning a requirement / user story into a test suite. Each case can have a list of `instructions` (steps) and a single `expected_result`.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          cases: z.array(z.object(testCaseFields)).min(1).max(50),
        },
      },
      wrap(async ({ projectId: id, cases }) => {
        const pid = projectId(id);
        const created: unknown[] = [];
        const failed: { index: number; error: string }[] = [];
        for (let i = 0; i < cases.length; i++) {
          try {
            created.push(
              await client.createTestCase({ project_id: pid, ...cases[i]! }),
            );
          } catch (e) {
            failed.push({
              index: i,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return { created_count: created.length, failed, created };
      }),
    );

    server.registerTool(
      "testmonitor_testcases_update",
      {
        title: "Update test case",
        description: "Update fields on an existing test case.",
        annotations: { destructiveHint: false, idempotentHint: true },
        inputSchema: {
          testCaseId: z.number().int().positive(),
          patch: z.object(testCaseFields).partial(),
        },
      },
      wrap(async ({ testCaseId, patch }) =>
        client.updateTestCase(testCaseId, patch),
      ),
    );

    server.registerTool(
      "testmonitor_testruns_create",
      {
        title: "Create test run",
        description:
          "Create a new test run on a milestone, optionally seeded with test cases. If milestone_id is omitted the first milestone in the project is used (one is created with the first milestone type if none exist).",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          name: z.string().min(1).max(100),
          milestone_id: z.number().int().positive().optional(),
          test_case_ids: z.array(z.number().int().positive()).optional(),
          users: z.array(z.number().int().positive()).optional(),
          tags: z.array(z.string()).optional(),
          starts_at: z.string().optional(),
          ends_at: z.string().optional(),
          draft: z.boolean().optional(),
        },
      },
      wrap(
        async ({
          projectId: id,
          milestone_id,
          test_case_ids,
          users,
          ...rest
        }) => {
          let mid = milestone_id;
          if (!mid) {
            const m = await client.ensureDefaultMilestone(projectId(id));
            mid = m.id;
          }
          let assignedUsers = users;
          if (!assignedUsers || assignedUsers.length === 0) {
            const me = await client.getCurrentUserId();
            if (me) assignedUsers = [me];
          }
          return client.createTestRun({
            milestone_id: mid,
            test_cases: test_case_ids,
            users: assignedUsers,
            ...rest,
          });
        },
      ),
    );

    server.registerTool(
      "testmonitor_testresults_submit",
      {
        title: "Submit test result",
        description:
          "Submit a result for a test case in a run. Status accepts the human name (passed/failed/blocked/...) and is mapped to the project's test_result_status_id.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          test_run_id: z.number().int().positive(),
          test_case_id: z.number().int().positive(),
          status: z.string().min(1).describe("e.g. passed, failed, blocked, skipped"),
          description: z.string().optional(),
        },
      },
      wrap(async ({ projectId: id, ...rest }) =>
        client.submitTestResult({ project_id: projectId(id), ...rest }),
      ),
    );

    server.registerTool(
      "testmonitor_issues_create",
      {
        title: "Create issue",
        description:
          "Create an issue / defect, optionally linked to failing test result(s). Category and status default to the first configured value if not supplied.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          name: z.string().min(1).max(255),
          description: z.string().min(1).max(10_000),
          issue_category: z.string().optional(),
          issue_status: z.string().optional(),
          issue_priority: z.string().optional(),
          test_result_ids: z.array(z.number().int().positive()).optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      wrap(async ({ projectId: id, ...rest }) =>
        client.createIssue({ project_id: projectId(id), ...rest }),
      ),
    );

    server.registerTool(
      "testmonitor_requirements_create",
      {
        title: "Create requirement",
        description:
          "Create a requirement / user story. If `requirement_type_id` is omitted the first configured type is used.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          projectId: z.number().int().positive().optional(),
          name: z.string().min(1).max(100),
          description: z.string().max(10_000).optional(),
          requirement_type_id: z.number().int().positive().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      wrap(async ({ projectId: id, ...rest }) =>
        client.createRequirement({ project_id: projectId(id), ...rest }),
      ),
    );

    const attachmentSourceFields = {
      filename: z.string().optional()
        .describe("Filename for the upload (e.g. 'login-button.png')."),
      mime_type: z.string().optional()
        .describe("MIME type, e.g. 'image/png'. Inferred from URL header if omitted."),
      data_base64: z.string().optional()
        .describe("Raw file bytes encoded as base64 (preferred for AI-generated images)."),
      url: z.string().url().optional()
        .describe("Public URL the server should fetch the file from."),
    };

    server.registerTool(
      "testmonitor_testcase_attachment_upload",
      {
        title: "Upload test case attachment",
        description:
          "Attach an image or file to a test case (e.g. a screenshot showing what to click in a step). Provide either `data_base64` or `url`.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          testCaseId: z.number().int().positive(),
          ...attachmentSourceFields,
        },
      },
      wrap(async ({ testCaseId, ...src }) => {
        const file = await client.resolveAttachment(src);
        return client.uploadTestCaseAttachment(testCaseId, file);
      }),
    );

    server.registerTool(
      "testmonitor_testresult_attachment_upload",
      {
        title: "Upload test result attachment",
        description:
          "Attach an image or file (e.g. failure screenshot) to an existing test result. Provide either `data_base64` or `url`. Also required to submit a 'Fail' result on tenants that mandate attachments.",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          testResultId: z.number().int().positive(),
          ...attachmentSourceFields,
        },
      },
      wrap(async ({ testResultId, ...src }) => {
        const file = await client.resolveAttachment(src);
        return client.uploadTestResultAttachment(testResultId, file);
      }),
    );
  } else {
    logger.info("Read-only mode enabled — write tools are not registered.");
  }

  // ========================================================================
  // RESOURCES
  // ========================================================================

  server.registerResource(
    "run-report",
    new ResourceTemplate("testmonitor://project/{projectId}/run/{runId}/report", { list: undefined }),
    {
      title: "Test run report",
      description:
        "Markdown summary of a test run: status counts, failed cases, linked issues.",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const runId = Number(vars.runId);
      const pid = Number(vars.projectId);
      if (!Number.isFinite(runId) || !Number.isFinite(pid)) {
        throw new Error(`Invalid URI: ${uri.href}`);
      }
      const [run, results] = await Promise.all([
        client.getTestRun(runId),
        client.listTestResults(pid, runId),
      ]);
      const md = renderRunReport(run.data, results.data);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }],
      };
    },
  );

  server.registerResource(
    "requirement-coverage",
    new ResourceTemplate("testmonitor://requirement/{requirementId}/coverage", { list: undefined }),
    {
      title: "Requirement coverage",
      description:
        "Markdown coverage report for a requirement: each linked test case with its latest run status and an overall completion verdict.",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const requirementId = Number(vars.requirementId);
      if (!Number.isFinite(requirementId)) {
        throw new Error(`Invalid URI: ${uri.href}`);
      }
      const [req, cases] = await Promise.all([
        client.getRequirement(requirementId),
        client.listRequirementTestCases(requirementId),
      ]);
      const md = renderCoverageReport(req.data, cases.data);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }],
      };
    },
  );

  // ========================================================================
  // PROMPTS
  // ========================================================================

  server.registerPrompt(
    "generate-acceptance-tests",
    {
      title: "Generate acceptance tests",
      description:
        "Turn a requirement / user story into TestMonitor acceptance test cases.",
      argsSchema: {
        projectId: z.string().optional(),
        requirementText: z.string().optional(),
        requirementId: z.string().optional(),
      },
    },
    ({ projectId: pidArg, requirementText, requirementId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are an experienced QA analyst writing acceptance tests for TestMonitor.",
              "",
              "Goal: produce a set of clear, atomic acceptance test cases that cover the happy path, edge cases, and negative paths for the provided requirement.",
              "",
              "TestMonitor test-case shape:",
              "- `name`: short imperative",
              "- `description`: one-line summary",
              "- `preconditions`: optional setup",
              "- `instructions`: ordered string array — one entry per step (e.g. \"Navigate to /login\")",
              "- `expected_result`: a single string describing the overall expected outcome",
              "- `requirements`: array of requirement ids to link this case to (so completion can be tracked)",
              "",
              "Rules:",
              "1. Prefer 3–7 `instructions` per case. Split larger flows into multiple cases.",
              "2. Always include the source requirement id in `requirements: [id]` so coverage can be tracked.",
              "3. Use `testmonitor_testcases_bulk_create` to create the cases after the user approves.",
              "4. For steps that need a visual aid (e.g. 'click the green Submit button'), after creating the case call `testmonitor_testcase_attachment_upload` with `data_base64` (an image you generated/annotated) or `url` (e.g. a public screenshot). Reference the screenshot from the matching instruction text (e.g. 'Click Submit (see attachment login-submit.png)').",
              "5. Before creating, present the proposed cases as a Markdown table and ask for confirmation.",
              "",
              pidArg
                ? `Target project id: ${pidArg}.`
                : "Ask the user for the target project id if one isn't already set as default.",
              requirementId
                ? `Source requirement id: ${requirementId} — call \`testmonitor_requirements_list\` to fetch it.`
                : "",
              requirementText
                ? `Requirement text:\n\n${requirementText}`
                : "Ask the user to paste the requirement / user story.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "summarize-uat-feedback",
    {
      title: "Summarize UAT feedback",
      description: "Summarize a test run into delivery-ready UAT feedback.",
      argsSchema: { runId: z.string() },
    },
    ({ runId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Summarize TestMonitor run ${runId} as a UAT feedback report.`,
              "",
              "Steps:",
              `1. Read the resource \`testmonitor://project/{projectId}/run/${runId}/report\` (substitute the project id).`,
              `2. Call \`testmonitor_testresults_list\` with runId=${runId} for details.`,
              "3. Produce a Markdown report with:",
              "   - Overall verdict (Ready / Conditional / Blocked) and pass rate",
              "   - Top 5 blockers with reproduction steps",
              "   - Suggested next actions for the dev team",
              "   - Any open questions for the business",
              "Be concise; bullets over paragraphs.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "triage-failed-tests",
    {
      title: "Triage failed tests",
      description:
        "Propose defects for each failed result in a run; create them on approval.",
      argsSchema: { runId: z.string() },
    },
    ({ runId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Triage failed results in TestMonitor run ${runId}.`,
              "",
              `1. Call \`testmonitor_testresults_list\` with runId=${runId}.`,
              "2. For each result whose status name is \"failed\", draft an issue: name, description, optional priority.",
              "3. Show the user the list and wait for explicit approval before calling `testmonitor_issues_create` for each one (linking via `test_result_ids`).",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "check-requirement-coverage",
    {
      title: "Check requirement coverage",
      description:
        "Determine whether a requirement is fully tested and accepted.",
      argsSchema: { requirementId: z.string() },
    },
    ({ requirementId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Determine completion status of TestMonitor requirement ${requirementId}.`,
              "",
              "Steps:",
              `1. Read the resource \`testmonitor://requirement/${requirementId}/coverage\`.`,
              `2. If any test cases are \"not_run\", call \`testmonitor_requirement_coverage\` again after suggesting they be executed.`,
              "3. Report: total cases, passed, failed, not run, pass rate, and a clear verdict — 'Requirement met' only if all linked cases passed; otherwise 'Not met' with the specific blocking cases listed.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

function jsonBlock(value: unknown): string {
  return "```json\n" + stringify(value) + "\n```";
}
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderRunReport(
  run: { id: number; name: string; status?: string },
  results: Array<{
    test_case_id: number;
    test_result_status?: { name: string };
    description?: string;
    executed_at?: string;
    executed_by?: { name: string };
  }>,
): string {
  const counts: Record<string, number> = {};
  for (const r of results) {
    const s = r.test_result_status?.name ?? "unknown";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const total = results.length;
  const passed = Object.entries(counts).find(([k]) =>
    /pass/i.test(k),
  )?.[1] ?? 0;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
  const failed = results.filter((r) => /fail/i.test(r.test_result_status?.name ?? ""));

  const lines: string[] = [
    `# Test run ${run.id} — ${run.name}`,
    `Status: **${run.status ?? "unknown"}** · Pass rate: **${passRate}%** (${passed}/${total})`,
    "",
    "## Counts",
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
  ];
  if (failed.length > 0) {
    lines.push("", "## Failed cases");
    for (const f of failed) {
      lines.push(
        `- Test case ${f.test_case_id}` +
          (f.executed_by ? ` (by ${f.executed_by.name})` : "") +
          (f.description ? ` — ${f.description}` : ""),
      );
    }
  }
  return lines.join("\n");
}

function renderCoverageReport(
  req: {
    id: number;
    name: string;
    status?: { type?: { name?: string } } | null;
  },
  cases: Array<{
    id: number;
    name: string;
    status?: { type?: { name?: string } } | null;
  }>,
): string {
  let passed = 0;
  let failed = 0;
  let notRun = 0;
  const rows = cases.map((tc) => {
    const status = tc.status?.type?.name ?? null;
    if (!status) notRun++;
    else if (/pass/i.test(status)) passed++;
    else if (/fail/i.test(status)) failed++;
    return `| ${tc.id} | ${escapePipes(tc.name)} | ${status ?? "_not run_"} |`;
  });
  const total = cases.length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
  const verdict =
    total === 0
      ? "**No test cases linked** — requirement is not covered."
      : passed === total
        ? "**Requirement met** ✅ — all linked cases passed."
        : `**Not met** — ${failed} failed, ${notRun} not run.`;
  return [
    `# Requirement ${req.id} — ${req.name}`,
    `Current status: **${req.status?.type?.name ?? "unknown"}**`,
    "",
    verdict,
    `Pass rate: **${passRate}%** (${passed}/${total}) · failed: ${failed} · not run: ${notRun}`,
    "",
    "## Linked test cases",
    "| Id | Name | Latest status |",
    "|---:|------|---------------|",
    ...rows,
  ].join("\n");
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}
