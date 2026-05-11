import { HttpClient, type MultipartFile } from "./http.js";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";

/**
 * Typed wrapper over the TestMonitor REST API (v1).
 *
 * Field names follow the OpenAPI document at https://docs.testmonitor.com/openapi.yaml.
 * Where the doc is open-ended we keep payloads loose so callers can pass through
 * extra fields. Status names for test results are mapped via per-project
 * test_result_statuses lookup (cached).
 */
export class TestMonitorClient {
  private readonly http: HttpClient;
  private readonly cache = new Map<string, unknown>();

  constructor(opts: { config: Config; logger: Logger }) {
    this.http = new HttpClient(opts);
  }

  // ---- Projects ----------------------------------------------------------
  listProjects(query?: { page?: number; limit?: number; query?: string }) {
    return this.http.json<Paginated<Project>>("/projects", { query });
  }
  getProject(id: number) {
    return this.http.json<Envelope<Project>>(`/projects/${id}`);
  }

  // ---- Per-project lookups ----------------------------------------------
  listMilestoneTypes(projectId: number) {
    return this.http.json<Paginated<NamedRef>>(
      `/project/${projectId}/milestone-types`,
    );
  }
  listTestResultStatuses(projectId: number) {
    return this.http.json<Paginated<NamedRef>>("/test-result-statuses", {
      query: { project_id: projectId },
    });
  }
  listIssueCategories(projectId: number) {
    return this.http.json<Paginated<NamedRef>>(
      `/project/${projectId}/issue-categories`,
    );
  }
  listIssueStatuses(projectId: number) {
    return this.http.json<Paginated<NamedRef>>(
      `/project/${projectId}/issue-statuses`,
    );
  }
  listIssuePriorities(projectId: number) {
    return this.http.json<Paginated<NamedRef>>(
      `/project/${projectId}/issue-priorities`,
    );
  }
  listRequirementTypes(projectId: number) {
    return this.http.json<Paginated<NamedRef>>(
      `/project/${projectId}/requirement-types`,
    );
  }

  // ---- Milestones --------------------------------------------------------
  listMilestones(projectId: number) {
    return this.http.json<Paginated<Milestone>>("/milestones", {
      query: { project_id: projectId },
    });
  }
  createMilestone(input: {
    project_id: number;
    name: string;
    milestone_type_id: number;
    description?: string;
    ends_at?: string;
  }) {
    return this.http.json<Envelope<Milestone>>("/milestones", {
      method: "POST",
      body: input,
    });
  }

  /** Get or create a default milestone for a project (looking up the first
   *  available milestone type). Used to make test-run creation ergonomic. */
  async ensureDefaultMilestone(projectId: number): Promise<Milestone> {
    const existing = await this.listMilestones(projectId);
    if (existing.data.length > 0) return existing.data[0]!;
    const types = await this.listMilestoneTypes(projectId);
    const typeId = types.data[0]?.id;
    if (!typeId) {
      throw new Error(
        `No milestone types are configured for project ${projectId}; create one in the TestMonitor UI first.`,
      );
    }
    const res = await this.createMilestone({
      project_id: projectId,
      name: "Default",
      milestone_type_id: typeId,
    });
    return res.data;
  }

  // ---- Users -------------------------------------------------------------
  listUsers() {
    return this.http.json<Paginated<User>>("/users");
  }
  async getCurrentUserId(): Promise<number | undefined> {
    const key = "me:id";
    const cached = this.cache.get(key) as number | undefined;
    if (cached) return cached;
    const res = await this.listUsers();
    const me = res.data.find((u) => (u as { me?: boolean }).me === true);
    if (me) this.cache.set(key, me.id);
    return me?.id;
  }

  // ---- Requirements ------------------------------------------------------
  listRequirements(projectId: number, query?: string) {
    return this.http.json<Paginated<Requirement>>("/requirements", {
      query: { project_id: projectId, query },
    });
  }
  getRequirement(id: number) {
    return this.http.json<Envelope<Requirement>>(`/requirements/${id}`);
  }
  async createRequirement(input: {
    project_id: number;
    name: string;
    description?: string;
    requirement_type_id?: number;
    tags?: string[];
  }): Promise<Envelope<Requirement>> {
    let typeId = input.requirement_type_id;
    if (!typeId) {
      const cacheKey = `requirement-types:${input.project_id}`;
      let list = this.cache.get(cacheKey) as NamedRef[] | undefined;
      if (!list) {
        const r = await this.listRequirementTypes(input.project_id);
        list = r.data;
        this.cache.set(cacheKey, list);
      }
      if (list.length === 0)
        throw new Error("No requirement types configured for this project.");
      typeId = list[0]!.id;
    }
    return this.http.json<Envelope<Requirement>>("/requirements", {
      method: "POST",
      body: {
        project_id: input.project_id,
        name: input.name,
        description: input.description,
        requirement_type_id: typeId,
        tags: input.tags,
      },
    });
  }
  /** Get test cases linked to a requirement (each item includes latest `status`). */
  listRequirementTestCases(requirementId: number) {
    return this.http.json<Paginated<TestCase>>(
      `/requirement/${requirementId}/test-cases`,
    );
  }

  // ---- Attachments -------------------------------------------------------
  /** Resolve a file source (base64 data or URL) into an in-memory MultipartFile. */
  async resolveAttachment(input: {
    filename?: string;
    mime_type?: string;
    data_base64?: string;
    url?: string;
  }): Promise<MultipartFile> {
    if (input.data_base64) {
      return {
        filename: input.filename ?? "upload.bin",
        contentType: input.mime_type ?? "application/octet-stream",
        data: Buffer.from(input.data_base64, "base64"),
      };
    }
    if (input.url) {
      const res = await fetch(input.url);
      if (!res.ok)
        throw new Error(`Failed to download attachment from ${input.url}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const guessedName =
        input.filename ??
        (decodeURIComponent(new URL(input.url).pathname.split("/").pop() || "") ||
          "upload.bin");
      const ct =
        input.mime_type ??
        res.headers.get("content-type")?.split(";")[0] ??
        "application/octet-stream";
      return { filename: guessedName, contentType: ct, data: buf };
    }
    throw new Error("Provide either data_base64 or url for the attachment.");
  }
  uploadTestCaseAttachment(testCaseId: number, file: MultipartFile) {
    return this.http.multipart<Envelope<Attachment>>(
      `/test-case/${testCaseId}/attachments`,
      { file },
    );
  }
  listTestCaseAttachments(testCaseId: number) {
    return this.http.json<Paginated<Attachment>>(
      `/test-case/${testCaseId}/attachments`,
    );
  }
  uploadTestResultAttachment(testResultId: number, file: MultipartFile) {
    return this.http.multipart<Envelope<Attachment>>(
      `/test-result/${testResultId}/attachments`,
      { file },
    );
  }
  listTestResultAttachments(testResultId: number) {
    return this.http.json<Paginated<Attachment>>(
      `/test-result/${testResultId}/attachments`,
    );
  }

  // ---- Test Case Folders (replaces deprecated Test Suites) --------------
  listTestCaseFolders(projectId: number) {
    return this.http.json<Paginated<TestCaseFolder>>("/test-case/folders", {
      query: { project_id: projectId },
    });
  }
  createTestCaseFolder(input: {
    project_id: number;
    name: string;
    parent_id?: number;
  }) {
    return this.http.json<Envelope<TestCaseFolder>>("/test-case/folders", {
      method: "POST",
      body: input,
    });
  }

  // ---- Test Cases --------------------------------------------------------
  listTestCases(
    projectId: number,
    query?: { folderId?: number; search?: string },
  ) {
    return this.http.json<Paginated<TestCase>>("/test-cases", {
      query: {
        project_id: projectId,
        test_case_folder_id: query?.folderId,
        query: query?.search,
      },
    });
  }
  getTestCase(id: number) {
    return this.http.json<Envelope<TestCase>>(`/test-cases/${id}`);
  }
  createTestCase(input: TestCaseInput) {
    return this.http.json<Envelope<TestCase>>("/test-cases", {
      method: "POST",
      body: input,
    });
  }
  updateTestCase(id: number, input: Partial<TestCaseInput>) {
    return this.http.json<Envelope<TestCase>>(`/test-cases/${id}`, {
      method: "PATCH",
      body: input,
    });
  }

  // ---- Test Runs ---------------------------------------------------------
  listTestRuns(projectId: number) {
    return this.http.json<Paginated<TestRun>>("/test-runs", {
      query: { project_id: projectId },
    });
  }
  getTestRun(id: number) {
    return this.http.json<Envelope<TestRun>>(`/test-runs/${id}`);
  }
  createTestRun(input: {
    milestone_id: number;
    name: string;
    test_cases?: number[];
    users?: number[];
    tags?: string[];
    starts_at?: string;
    ends_at?: string;
    draft?: boolean;
  }) {
    return this.http.json<Envelope<TestRun>>("/test-runs", {
      method: "POST",
      body: input,
    });
  }

  // ---- Test Results ------------------------------------------------------
  listTestResults(projectId: number, runId?: number) {
    return this.http.json<Paginated<TestResult>>("/test-results", {
      query: { project_id: projectId, test_run_id: runId },
    });
  }

  /** Submit a test result. Accepts a friendly status name (passed/failed/...)
   *  which is mapped to the project's test_result_status_id. */
  async submitTestResult(input: {
    project_id: number;
    test_run_id: number;
    test_case_id: number;
    status: "passed" | "failed" | "blocked" | "skipped" | "not_run" | string;
    description?: string;
  }): Promise<Envelope<TestResult>> {
    const statusId = await this.resolveResultStatusId(
      input.project_id,
      input.status,
    );
    return this.http.json<Envelope<TestResult>>("/test-results", {
      method: "POST",
      bodyMode: "form",
      body: {
        test_run_id: input.test_run_id,
        test_case_id: input.test_case_id,
        test_result_status_id: statusId,
        description: input.description,
      },
    });
  }

  private async resolveResultStatusId(
    projectId: number,
    status: string,
  ): Promise<number> {
    const key = `result-statuses:${projectId}`;
    let list = this.cache.get(key) as NamedRef[] | undefined;
    if (!list) {
      const res = await this.listTestResultStatuses(projectId);
      list = res.data;
      this.cache.set(key, list);
    }
    const norm = status.toLowerCase().replace(/[_\s-]/g, "");
    const match = list.find((s) => {
      const n = s.name.toLowerCase().replace(/[_\s-]/g, "");
      return (
        n === norm ||
        n.startsWith(norm) ||
        norm.startsWith(n) ||
        String(s.id) === status
      );
    });
    if (!match) {
      throw new Error(
        `Unknown test result status "${status}". Available: ${list.map((s) => s.name).join(", ")}`,
      );
    }
    return match.id;
  }

  // ---- Issues / Defects --------------------------------------------------
  listIssues(projectId: number, query?: string) {
    return this.http.json<Paginated<Issue>>("/issues", {
      query: { project_id: projectId, query },
    });
  }

  /** Create an issue. Looks up category & status by name if not given as ids. */
  async createIssue(input: {
    project_id: number;
    name: string;
    description: string;
    issue_category?: string;
    issue_category_id?: number;
    issue_status?: string;
    issue_status_id?: number;
    issue_priority?: string;
    issue_priority_id?: number;
    test_result_ids?: number[];
    tags?: string[];
  }): Promise<Envelope<Issue>> {
    const categoryId =
      input.issue_category_id ??
      (await this.resolveByName(
        `issue-categories:${input.project_id}`,
        () => this.listIssueCategories(input.project_id),
        input.issue_category ?? "",
        "issue category",
      ));
    const statusId =
      input.issue_status_id ??
      (await this.resolveByName(
        `issue-statuses:${input.project_id}`,
        () => this.listIssueStatuses(input.project_id),
        input.issue_status ?? "",
        "issue status",
      ));
    const priorityId =
      input.issue_priority_id ??
      (input.issue_priority
        ? await this.resolveByName(
            `issue-priorities:${input.project_id}`,
            () => this.listIssuePriorities(input.project_id),
            input.issue_priority,
            "issue priority",
          )
        : undefined);

    return this.http.json<Envelope<Issue>>("/issues", {
      method: "POST",
      body: {
        project_id: input.project_id,
        name: input.name,
        description: input.description,
        issue_category_id: categoryId,
        issue_status_id: statusId,
        issue_priority_id: priorityId,
        test_results: input.test_result_ids,
        tags: input.tags,
      },
    });
  }

  private async resolveByName(
    cacheKey: string,
    fetcher: () => Promise<Paginated<NamedRef>>,
    nameOrFirst: string,
    label: string,
  ): Promise<number> {
    let list = this.cache.get(cacheKey) as NamedRef[] | undefined;
    if (!list) {
      const res = await fetcher();
      list = res.data;
      this.cache.set(cacheKey, list);
    }
    if (list.length === 0) {
      throw new Error(`No ${label} values configured for this project.`);
    }
    if (!nameOrFirst) return list[0]!.id; // default to first
    const norm = nameOrFirst.toLowerCase().replace(/[_\s-]/g, "");
    const match = list.find(
      (s) =>
        s.name.toLowerCase().replace(/[_\s-]/g, "") === norm ||
        String(s.id) === nameOrFirst,
    );
    if (!match) {
      throw new Error(
        `Unknown ${label} "${nameOrFirst}". Available: ${list.map((s) => s.name).join(", ")}`,
      );
    }
    return match.id;
  }
}

// --- Types ----------------------------------------------------------------

export interface Envelope<T> {
  data: T;
}
export interface Paginated<T> {
  data: T[];
  meta?: { current_page?: number; last_page?: number; total?: number };
  links?: Record<string, string>;
}

export interface NamedRef {
  id: number;
  name: string;
}
export interface Project extends NamedRef {
  description?: string | null;
  key?: string;
}
export interface Milestone extends NamedRef {
  project_id?: number;
  milestone_type_id?: number;
  ends_at?: string | null;
}
export interface User extends NamedRef {
  email?: string;
}
export interface Requirement extends NamedRef {
  description?: string;
  project_id?: number;
  requirement_type_id?: number;
  status?: { type?: NamedRef; test_result_status_id?: number } | null;
  test_cases_count?: number;
}
export interface TestCaseFolder extends NamedRef {
  parent_id?: number | null;
  project_id?: number;
}
export interface TestCase extends NamedRef {
  description?: string;
  preconditions?: string;
  expected_result?: string;
  instructions?: string[];
  project_id?: number;
  test_case_folder_id?: number;
  tags?: string[];
  status?: {
    test_result_status_id?: number;
    type?: NamedRef;
  } | null;
}
export interface TestCaseInput {
  project_id: number;
  name: string;
  description?: string;
  preconditions?: string;
  expected_result?: string;
  instructions?: string[];
  test_case_folder_id?: number;
  duration?: number;
  draft?: boolean;
  tags?: string[];
  requirements?: number[];
  applications?: number[];
}
export interface TestRun extends NamedRef {
  milestone_id?: number;
  status?: string;
  created_at?: string;
}
export interface TestResult {
  id: number;
  test_run_id: number;
  test_case_id: number;
  test_result_status_id?: number;
  test_result_status?: NamedRef;
  description?: string;
  executed_at?: string;
  executed_by?: NamedRef;
}
export interface Issue extends NamedRef {
  description?: string;
  project_id?: number;
  issue_status?: NamedRef;
  issue_category?: NamedRef;
  issue_priority?: NamedRef;
}

export interface Attachment {
  id: number;
  name: string;
  mime_type?: string;
  size?: number;
  url?: string;
  thumbnail_url?: string;
}
