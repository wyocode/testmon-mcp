import { request } from "undici";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { baseUrl } from "../config.js";
import type { Logger } from "../util/logger.js";

export class TestMonitorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    public readonly path: string,
  ) {
    super(`TestMonitor API ${status} ${statusText} on ${path}`);
    this.name = "TestMonitorApiError";
  }
}

export interface HttpClientOptions {
  config: Config;
  logger: Logger;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * Override content-type. JSON by default when body is present.
   * Use "form" for endpoints that expect multipart/form-data when no files
   * are attached (TestMonitor's Laravel-based API accepts form-encoded
   * payloads for these endpoints).
   */
  bodyMode?: "json" | "form";
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

export class HttpClient {
  private readonly base: string;
  constructor(private readonly opts: HttpClientOptions) {
    this.base = baseUrl(opts.config);
  }

  async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", query, body, bodyMode } = options;
    const url = this.buildUrl(path, query);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const started = Date.now();

      const headers: Record<string, string> = {
        authorization: `Bearer ${this.opts.config.token}`,
        accept: "application/json",
        "user-agent": "testmon-mcp/0.1",
      };
      let payload: string | undefined;
      if (body !== undefined) {
        if (bodyMode === "form") {
          headers["content-type"] = "application/x-www-form-urlencoded";
          payload = toForm(body as Record<string, unknown>);
        } else {
          headers["content-type"] = "application/json";
          payload = JSON.stringify(body);
        }
      }

      try {
        const res = await request(url, {
          method,
          headers,
          body: payload,
          bodyTimeout: this.opts.config.timeoutMs,
          headersTimeout: this.opts.config.timeoutMs,
        });

        const status = res.statusCode;
        const text = await res.body.text();
        const parsed = parseJson(text);

        this.opts.logger.debug(
          `${method} ${path} -> ${status} (${Date.now() - started}ms)`,
        );

        if (status >= 200 && status < 300) {
          return parsed as T;
        }
        if (RETRYABLE_STATUS.has(status) && attempt <= MAX_RETRIES) {
          const retryAfter = Number(res.headers["retry-after"]);
          const delay = Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : backoff(attempt);
          this.opts.logger.warn(
            `Retrying ${method} ${path} after ${delay}ms (status ${status}, attempt ${attempt})`,
          );
          await sleep(delay);
          continue;
        }
        throw new TestMonitorApiError(
          status,
          String(res.headers["x-status-text"] ?? ""),
          parsed,
          path,
        );
      } catch (err) {
        if (err instanceof TestMonitorApiError) throw err;
        if (attempt <= MAX_RETRIES) {
          const delay = backoff(attempt);
          this.opts.logger.warn(
            `Network error on ${method} ${path}; retrying in ${delay}ms`,
            (err as Error).message,
          );
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.base}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** POST multipart/form-data. Used for file uploads (attachments). */
  async multipart<T>(
    path: string,
    parts: Record<string, string | number | MultipartFile>,
  ): Promise<T> {
    const url = this.buildUrl(path);
    const boundary = `----testmonMcp${randomBytes(8).toString("hex")}`;
    const body = buildMultipart(boundary, parts);
    const res = await request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.config.token}`,
        accept: "application/json",
        "user-agent": "testmon-mcp/0.1",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      bodyTimeout: this.opts.config.timeoutMs,
      headersTimeout: this.opts.config.timeoutMs,
    });
    const status = res.statusCode;
    const text = await res.body.text();
    const parsed = parseJson(text);
    if (status >= 200 && status < 300) return parsed as T;
    throw new TestMonitorApiError(status, "", parsed, path);
  }
}

export interface MultipartFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

function buildMultipart(
  boundary: string,
  parts: Record<string, string | number | MultipartFile>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts)) {
    if (value === undefined || value === null) continue;
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (typeof value === "object") {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n` +
            `Content-Type: ${value.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(value.data);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function backoff(attempt: number): number {
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Encode object as application/x-www-form-urlencoded; arrays become `key[]=value`. */
function toForm(obj: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(`${k}[]`, String(item));
    } else if (typeof v === "object") {
      params.set(k, JSON.stringify(v));
    } else {
      params.set(k, String(v));
    }
  }
  return params.toString();
}
