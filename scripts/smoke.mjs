// Live end-to-end smoke test against a real TestMonitor environment.
// Required env: TESTMONITOR_DOMAIN, TESTMONITOR_TOKEN
// Usage: node scripts/smoke.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, LOG_LEVEL: "info" },
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, 30_000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
function pass(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) { console.log(`  FAIL  ${name}: ${err?.message ?? err}`); process.exitCode = 1; }

const previewLen = 240;
function preview(s) {
  s = typeof s === "string" ? s : JSON.stringify(s);
  return (s.length > previewLen ? s.slice(0, previewLen) + "…" : s).replace(/\n/g, " ");
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(r.content?.[0]?.text ?? "isError");
  return r.content?.[0]?.text ?? "";
}
async function callShow(name, args) {
  try { const t = await call(name, args); pass(name); console.log("        " + preview(t)); return t; }
  catch (e) { fail(name, e); return ""; }
}
function jsonOut(text) {
  // tool output is wrapped in a ```json fenced block
  const m = text.match(/```json\n([\s\S]+?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}

async function run() {
  console.log("== testmon-mcp live smoke test ==");

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  pass(`initialize -> ${init.serverInfo.name} v${init.serverInfo.version}`);
  notify("notifications/initialized");

  const tools = await rpc("tools/list", {});
  pass(`tools/list -> ${tools.tools.length} tools`);
  const prompts = await rpc("prompts/list", {});
  pass(`prompts/list -> ${prompts.prompts.length} prompts`);

  // -- READS ----------------------------------------------------------------
  const projectsText = await callShow("testmonitor_projects_list", {});
  const projects = jsonOut(projectsText);
  const projectId = projects?.data?.[0]?.id;
  if (!projectId) { fail("no project found", "stop"); child.stdin.end(); return; }
  console.log(`        using projectId=${projectId}`);

  await callShow("testmonitor_milestones_list", { projectId });
  await callShow("testmonitor_milestone_types_list", { projectId });
  await callShow("testmonitor_test_result_statuses_list", { projectId });
  await callShow("testmonitor_issue_categories_list", { projectId });
  await callShow("testmonitor_issue_statuses_list", { projectId });
  await callShow("testmonitor_testcase_folders_list", { projectId });
  await callShow("testmonitor_testcases_list", { projectId });
  await callShow("testmonitor_testruns_list", { projectId });
  await callShow("testmonitor_requirements_list", { projectId });
  await callShow("testmonitor_requirement_types_list", { projectId });
  await callShow("testmonitor_users_list", {});

  // -- WRITES ---------------------------------------------------------------
  console.log("\n-- write flow --");
  const stamp = Date.now();

  // create a requirement first so test cases can be linked back
  const reqText = await call("testmonitor_requirements_create", {
    projectId,
    name: `Login flow ${stamp}`,
    description: "Users must be able to sign in securely.",
  }).catch((e) => { fail("requirements_create", e); return ""; });
  const requirementId = jsonOut(reqText)?.data?.id;
  requirementId ? pass(`requirements_create -> ${requirementId}`)
                : fail("requirements_create", "no requirement id");

  // bulk-create acceptance test cases linked to the requirement
  const bulkText = await call("testmonitor_testcases_bulk_create", {
    projectId,
    cases: [
      {
        name: `Login with valid credentials ${stamp}`,
        description: "User can sign in with correct email/password.",
        preconditions: "User account exists and is active.",
        instructions: [
          "Navigate to /login",
          "Enter a valid email",
          "Enter the correct password",
          "Click Sign in (see attached screenshot)",
        ],
        expected_result: "User is redirected to the dashboard.",
        requirements: requirementId ? [requirementId] : undefined,
      },
      {
        name: `Login with invalid password ${stamp}`,
        description: "Clear error shown on bad password.",
        instructions: [
          "Navigate to /login",
          "Enter a valid email",
          "Enter a wrong password",
          "Click Sign in",
        ],
        expected_result: "Inline error 'Invalid credentials' is shown and the user stays on /login.",
        requirements: requirementId ? [requirementId] : undefined,
      },
    ],
  }).catch((e) => { fail("testcases_bulk_create", e); return ""; });
  const bulk = jsonOut(bulkText);
  const createdIds = (bulk?.created ?? []).map((c) => c?.data?.id).filter(Boolean);
  if (createdIds.length === 2) pass(`testcases_bulk_create -> ${createdIds.join(",")}`);
  else fail("testcases_bulk_create", `got ${createdIds.length} cases`);

  // upload a tiny PNG (1×1 transparent pixel) as a step screenshot
  if (createdIds[0]) {
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const attText = await call("testmonitor_testcase_attachment_upload", {
      testCaseId: createdIds[0],
      filename: `step-screenshot-${stamp}.png`,
      mime_type: "image/png",
      data_base64: png1x1,
    }).catch((e) => { fail("testcase_attachment_upload", e); return ""; });
    const attId = jsonOut(attText)?.data?.id;
    attId ? pass(`testcase_attachment_upload (base64) -> attachment ${attId}`)
          : fail("testcase_attachment_upload (base64)", "no attachment id");

    // also exercise the local-path upload mode
    if (createdIds[1]) {
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpPath = path.join(os.tmpdir(), `mcp-smoke-${stamp}.png`);
      await fs.writeFile(tmpPath, Buffer.from(png1x1, "base64"));
      const pathText = await call("testmonitor_testcase_attachment_upload", {
        testCaseId: createdIds[1],
        path: tmpPath,
      }).catch((e) => { fail("testcase_attachment_upload (path)", e); return ""; });
      const pathAttId = jsonOut(pathText)?.data?.id;
      pathAttId ? pass(`testcase_attachment_upload (path) -> attachment ${pathAttId}`)
                : fail("testcase_attachment_upload (path)", "no attachment id");
      await fs.unlink(tmpPath).catch(() => {});
    }

    await callShow("testmonitor_testcase_attachments_list", { testCaseId: createdIds[0] });
  }

  // create a run with those cases (milestone auto-resolved)
  const runText = await call("testmonitor_testruns_create", {
    projectId,
    name: `MCP Smoke Run ${stamp}`,
    test_case_ids: createdIds,
  }).catch((e) => { fail("testruns_create", e); return ""; });
  const runId = jsonOut(runText)?.data?.id;
  runId ? pass(`testruns_create -> ${runId}`) : fail("testruns_create", "no run id");

  if (runId && createdIds.length >= 2) {
    // submit results
    await callShow("testmonitor_testresults_submit", {
      projectId,
      test_run_id: runId,
      test_case_id: createdIds[0],
      status: "passed",
      description: "Verified manually.",
    });
    const failedResText = await call("testmonitor_testresults_submit", {
      projectId,
      test_run_id: runId,
      test_case_id: createdIds[1],
      status: "caution",
      description: "Error message styled incorrectly.",
    }).catch((e) => { fail("testresults_submit caution", e); return ""; });
    const failedResultId = jsonOut(failedResText)?.data?.id;
    failedResultId ? pass(`testresults_submit caution -> result ${failedResultId}`)
                   : fail("testresults_submit caution", "no result id");

    await callShow("testmonitor_testresults_list", { projectId, runId });

    // create a linked issue
    await callShow("testmonitor_issues_create", {
      projectId,
      name: `Login error styling regression ${stamp}`,
      description: "Inline error not visually distinct enough on /login.",
      test_result_ids: failedResultId ? [failedResultId] : undefined,
    });

    // read run-report resource
    const report = await rpc("resources/read", {
      uri: `testmonitor://project/${projectId}/run/${runId}/report`,
    });
    const md = report?.contents?.[0]?.text ?? "";
    md.startsWith("# Test run") ? pass("resources/read run-report")
                                : fail("resources/read run-report", md);
    console.log("        " + preview(md));

    // upload an attachment to the failing result so it can carry evidence
    if (failedResultId) {
      const png1x1 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      await callShow("testmonitor_testresult_attachment_upload", {
        testResultId: failedResultId,
        filename: `failure-${stamp}.png`,
        mime_type: "image/png",
        data_base64: png1x1,
      });
    }

    // requirement coverage rollup
    if (requirementId) {
      const covText = await callShow("testmonitor_requirement_coverage", { requirementId });
      const cov = jsonOut(covText);
      cov?.totals
        ? pass(`coverage totals -> ${JSON.stringify(cov.totals)}`)
        : fail("coverage totals", "missing");

      const covResource = await rpc("resources/read", {
        uri: `testmonitor://requirement/${requirementId}/coverage`,
      });
      const covMd = covResource?.contents?.[0]?.text ?? "";
      covMd.startsWith("# Requirement")
        ? pass("resources/read requirement-coverage")
        : fail("resources/read requirement-coverage", covMd);
      console.log("        " + preview(covMd));
    }
  }

  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  console.log("== done ==");
}

run().catch((e) => { console.error(e); process.exitCode = 1; child.kill(); });
