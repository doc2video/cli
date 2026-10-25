import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type {
  CostEstimate,
  CreditsSummary,
  DocumentInfo,
  JobInfo,
  ProjectDetail,
  ProjectSettings,
  ProjectSummary,
  SceneInfo,
  ScenePatch,
  Step,
  Voice,
} from "./types.js";
import type { LocalFile } from "./files.js";

/** This package's version (dist/client.js → ../package.json, which npm always ships). */
export const CLI_VERSION: string = createRequire(import.meta.url)("../package.json").version;

/**
 * Identifies this package to the API for channel attribution: `cli/<version>`,
 * or `mcp/<version>; agent=<client>` once an MCP client has connected.
 * DOC2VIDEO_REF (set by directory listings' install configs) tags where it came from.
 */
let clientTag = `cli/${CLI_VERSION}`;
export function setClientTag(tag: string): void {
  clientTag = tag;
}

/** An error response from the API, or a failure to reach it. */
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The error's extra fields, e.g. cost_cents and balance_cents on a 402. */
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class Doc2VideoClient {
  constructor(
    public baseUrl: string,
    private apiKey: string | null,
  ) {}

  setApiKey(apiKey: string | null): void {
    this.apiKey = apiKey;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new ApiRequestError(401, "no_api_key", "Not logged in. Run `d2v login` to connect your doc2video account " +
        "(or set DOC2VIDEO_API_KEY).");
    }
    return this.send<T>(method, path, body, true);
  }

  /** For the few endpoints that need no API key (the device-login flow). */
  publicRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, body, false);
  }

  private async send<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          "User-Agent": `d2v-cli/${CLI_VERSION}`,
          "X-D2V-Client": clientTag,
          ...(process.env.DOC2VIDEO_REF ? { "X-D2V-Ref": process.env.DOC2VIDEO_REF.slice(0, 40) } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
    } catch (err) {
      throw new ApiRequestError(0, "network_error", `Could not reach ${this.baseUrl}: ${(err as Error).message}`);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new ApiRequestError(res.status, "unexpected_response",
        `${this.baseUrl} redirected the API request (to ${res.headers.get("location") ?? "?"}) — is the doc2video API deployed there?`);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A redirect or HTML page usually means the server doesn't have the v1 API yet
      throw new ApiRequestError(res.status, "unexpected_response",
        `Unexpected ${res.status} response from ${this.baseUrl}/api/v1${path} — is the doc2video API deployed there?`);
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } | string } | null)?.error;
      const message = typeof err === "string" ? err : err?.message ?? `HTTP ${res.status}`;
      const code = typeof err === "object" && err?.code ? err.code : `http_${res.status}`;
      const { code: _c, message: _m, ...details } = typeof err === "object" && err ? (err as Record<string, unknown>) : {};
      throw new ApiRequestError(res.status, code, message, details);
    }
    return json as T;
  }

  // ── Account ──────────────────────────────────────────────────
  me() {
    return this.request<{ id: string; email: string; is_superuser: boolean; auth: string }>("GET", "/me");
  }

  async voices() {
    return (await this.request<{ voices: Voice[]; default_voice_id: string }>("GET", "/voices")).voices;
  }

  // ── Projects ─────────────────────────────────────────────────
  async listProjects() {
    return (await this.request<{ projects: ProjectSummary[] }>("GET", "/projects")).projects;
  }

  createProject(settings: ProjectSettings & { name: string }) {
    return this.request<ProjectDetail>("POST", "/projects", settings);
  }

  getProject(id: string) {
    return this.request<ProjectDetail>("GET", `/projects/${id}`);
  }

  updateProject(id: string, settings: ProjectSettings) {
    return this.request<ProjectDetail>("PATCH", `/projects/${id}`, settings);
  }

  deleteProject(id: string) {
    return this.request<{ deleted: true }>("DELETE", `/projects/${id}`);
  }

  // ── Sources ──────────────────────────────────────────────────
  /** Upload a local file: get a presigned URL, PUT the bytes to storage, register the document. */
  async uploadFile(projectId: string, file: LocalFile): Promise<DocumentInfo> {
    const target = await this.request<{ upload_url: string; storage_path: string; content_type: string }>(
      "POST",
      `/projects/${projectId}/documents/upload-url`,
      { filename: file.name, content_type: file.contentType, size_bytes: file.size },
    );

    const bytes = await readFile(file.path);
    let put: Response;
    try {
      put = await fetch(target.upload_url, { method: "PUT", headers: { "Content-Type": target.content_type }, body: bytes });
    } catch (err) {
      throw new ApiRequestError(0, "upload_failed", `Upload of ${file.name} failed: ${(err as Error).message}`);
    }
    if (!put.ok) throw new ApiRequestError(put.status, "upload_failed", `Upload of ${file.name} failed (HTTP ${put.status})`);

    const { document } = await this.request<{ document: DocumentInfo }>("POST", `/projects/${projectId}/documents`, {
      storage_path: target.storage_path,
      filename: file.name,
      content_type: target.content_type,
      size_bytes: file.size,
    });
    return document;
  }

  async addText(projectId: string, content: string, filename?: string) {
    const { document } = await this.request<{ document: DocumentInfo }>("POST", `/projects/${projectId}/documents`, {
      content,
      ...(filename ? { filename } : {}),
    });
    return document;
  }

  deleteDocument(projectId: string, documentId: string) {
    return this.request<{ deleted: true }>("DELETE", `/projects/${projectId}/documents/${documentId}`);
  }

  draft(projectId: string, prompt: string, save = true) {
    return this.request<{ draft: string; document: DocumentInfo | null }>("POST", `/projects/${projectId}/draft`, { prompt, save });
  }

  suggestDirection(projectId: string, preferences: unknown, save = false) {
    return this.request<{ creative_direction: string; saved: boolean }>(
      "POST",
      `/projects/${projectId}/creative-direction`,
      { preferences, save },
    );
  }

  // ── Pipeline ─────────────────────────────────────────────────
  async listJobs(projectId: string, opts: { active?: boolean; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.active) q.set("active", "true");
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return (await this.request<{ jobs: JobInfo[] }>("GET", `/projects/${projectId}/jobs${qs ? `?${qs}` : ""}`)).jobs;
  }

  /**
   * `useCredits`: consent to pay from credits when the step needs it — $0.50 for a storyboard
   * beyond today's free ones, or clips beyond what the purchase covers.
   */
  async runStep(projectId: string, step: Step, then: Step[] = [], useCredits = false, maxCreditsCents?: number) {
    return (
      await this.request<{ job: JobInfo }>("POST", `/projects/${projectId}/jobs`, {
        step,
        ...(then.length ? { then } : {}),
        ...(useCredits ? { use_credits: true } : {}),
        ...(useCredits && maxCreditsCents !== undefined ? { max_credits_cents: maxCreditsCents } : {}),
      })
    ).job;
  }

  // ── Scenes ───────────────────────────────────────────────────
  async scenes(projectId: string) {
    return (await this.request<{ scenes: SceneInfo[] }>("GET", `/projects/${projectId}/scenes`)).scenes;
  }

  updateScene(projectId: string, scene: number | string, patch: ScenePatch) {
    return this.request<{ scene: SceneInfo; notes: string[] }>("PATCH", `/projects/${projectId}/scenes/${scene}`, patch);
  }

  async regenerateKeyframe(projectId: string, scene: number | string, body: { direction?: string; mode?: "iterate" | "fresh" }) {
    return (await this.request<{ job: JobInfo }>("POST", `/projects/${projectId}/scenes/${scene}/keyframe`, body)).job;
  }

  narration(projectId: string, scene: number | string, body: { text?: string; prompt?: string; audio?: boolean }) {
    return this.request<{ narration_text: string; job: JobInfo | null }>("POST", `/projects/${projectId}/scenes/${scene}/narration`, body);
  }

  /**
   * `useCredits`: consent to pay from credits for a clip the purchase doesn't cover;
   * `maxCreditsCents`: the amount agreed to (the server asks again if it would cost more).
   */
  retryClip(projectId: string, scene: number | string, engine?: string, useCredits = false, maxCreditsCents?: number) {
    return this.request<{ action: string; engine: string; job: JobInfo | null }>(
      "POST",
      `/projects/${projectId}/scenes/${scene}/clip`,
      {
        ...(engine ? { engine } : {}),
        ...(useCredits ? { use_credits: true } : {}),
        ...(useCredits && maxCreditsCents !== undefined ? { max_credits_cents: maxCreditsCents } : {}),
      },
    );
  }

  // ── Billing & output ─────────────────────────────────────────
  estimate(projectId: string) {
    return this.request<CostEstimate & { purchased: boolean; covered_cents?: number | null }>("GET", `/projects/${projectId}/estimate`);
  }

  checkout(projectId: string) {
    return this.request<{ checkout_url: string; amount_cents: number }>("POST", `/projects/${projectId}/checkout`);
  }

  redeem(projectId: string, code: string) {
    return this.request<{ redeemed: true }>("POST", `/projects/${projectId}/redeem`, { code });
  }

  credits() {
    return this.request<CreditsSummary>("GET", "/credits");
  }

  creditCheckout(amountCents: number) {
    return this.request<{ checkout_url: string; amount_cents: number }>("POST", "/credits/checkout", { amount_cents: amountCents });
  }

  unlockWithCredits(projectId: string) {
    return this.request<{ unlocked: true; amount_cents: number; balance_cents: number }>(
      "POST",
      `/projects/${projectId}/unlock-with-credits`,
    );
  }

  download(projectId: string) {
    return this.request<{ download_url: string; video_id: string; filename: string; expires_in_seconds: number }>(
      "GET",
      `/projects/${projectId}/download`,
    );
  }
}
