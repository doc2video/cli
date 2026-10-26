import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiRequestError, type Doc2VideoClient } from "./client.js";
import { collectFiles, MAX_PHOTOS, type LocalFile, type SkippedFile } from "./files.js";
import type { DocumentInfo, JobInfo, PhotoTreatment, ProjectDetail, ProjectSettings, SceneInfo, ScenePatch, Step } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The storyboard pipeline: everything up to a reviewable preview. */
export const STORYBOARD_STEPS: Step[] = ["script", "keyframes", "narration", "preview"];

/** Accept a project id, a unique id prefix (4+ chars), or an exact project name. */
export async function resolveProjectId(client: Doc2VideoClient, ref: string): Promise<string> {
  const needle = ref.trim();
  if (UUID_RE.test(needle)) return needle;

  const projects = await client.listProjects();
  const lower = needle.toLowerCase();
  const byName = projects.filter((p) => p.name.toLowerCase() === lower);
  const byPrefix = needle.length >= 4 ? projects.filter((p) => p.id.startsWith(lower)) : [];
  const matches = byName.length ? byName : byPrefix;

  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new ApiRequestError(404, "not_found", `No project matches "${ref}". Run \`d2v projects\` to list them.`);
  throw new ApiRequestError(400, "ambiguous_project",
    `"${ref}" matches ${matches.length} projects: ${matches.map((p) => `${p.name} (${p.id.slice(0, 8)})`).join(", ")}. Use the id.`);
}

export interface UploadResult {
  uploaded: DocumentInfo[];
  failed: { path: string; error: string }[];
  skipped: SkippedFile[];
  warnings: string[];
}

/** A public link to add as a source (the server fetches it), rather than a local path. */
export const isLink = (value: string) => /^https?:\/\//i.test(value.trim());

/** Upload files and folders to a project, a few at a time; http(s) links are added by the server. */
export async function uploadSources(
  client: Doc2VideoClient,
  projectId: string,
  paths: string[],
  onProgress?: (file: LocalFile | { name: string; path: string }, outcome: "uploaded" | "failed", error?: string) => void,
): Promise<UploadResult> {
  const links = paths.filter(isLink);
  const { files, skipped } = collectFiles(paths.filter((p) => !isLink(p)));
  const warnings: string[] = [];
  const photoCount = files.filter((f) => f.kind === "photo").length;
  if (photoCount > MAX_PHOTOS) {
    warnings.push(`${photoCount} photos found — the script generator considers the first ${MAX_PHOTOS}.`);
  }

  const uploaded: DocumentInfo[] = [];
  const failed: { path: string; error: string }[] = [];
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        uploaded.push(await client.uploadFile(projectId, file));
        onProgress?.(file, "uploaded");
      } catch (err) {
        failed.push({ path: file.path, error: (err as Error).message });
        onProgress?.(file, "failed", (err as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));

  for (const url of links) {
    const item = { name: url, path: url };
    try {
      uploaded.push(await client.importUrl(projectId, url.trim()));
      onProgress?.(item, "uploaded");
    } catch (err) {
      failed.push({ path: url, error: (err as Error).message });
      onProgress?.(item, "failed", (err as Error).message);
    }
  }

  return { uploaded, failed, skipped, warnings };
}

/**
 * Turn a photo reference into a scene patch: "none" (back to an AI visual), a document id,
 * a local file (uploaded first), a public link (added first), or a project photo's filename.
 */
export async function photoPatch(
  client: Doc2VideoClient,
  projectId: string,
  photo: string | null | undefined,
  treatment?: PhotoTreatment,
): Promise<ScenePatch["photo"] | undefined> {
  if (photo === undefined || photo === "") return treatment ? { treatment } : undefined;
  if (photo === null || photo.toLowerCase() === "none") return null;
  if (UUID_RE.test(photo)) return { document_id: photo, treatment };
  if (isLink(photo)) {
    const doc = await client.importUrl(projectId, photo.trim());
    if (doc.kind !== "photo") throw new ApiRequestError(400, "not_a_photo", `${photo} isn't a photo (it was added as a ${doc.kind} source).`);
    return { document_id: doc.id, treatment };
  }
  if (existsSync(photo)) {
    const upload = await uploadSources(client, projectId, [photo]);
    const doc = upload.uploaded[0];
    if (!doc) throw new ApiRequestError(400, "upload_failed", `Could not upload ${photo}: ${upload.failed[0]?.error ?? upload.skipped[0]?.reason}`);
    return { document_id: doc.id, treatment };
  }
  return { filename: photo, treatment };
}

export interface CreateOptions {
  paths?: string[];
  text?: string;
  /** Have AI write the source content from this description. */
  draftPrompt?: string;
  /** Start the storyboard pipeline once sources are in. */
  build?: boolean;
  /** Consent to pay $0.50 from credits if today's free storyboards are used up. */
  useCredits?: boolean;
  onProgress?: Parameters<typeof uploadSources>[3];
}

export async function createProjectWithSources(client: Doc2VideoClient, settings: ProjectSettings & { name: string }, opts: CreateOptions) {
  const created = await client.createProject(settings);
  const id = created.id;

  const upload = opts.paths?.length ? await uploadSources(client, id, opts.paths, opts.onProgress) : null;
  if (opts.text?.trim()) await client.addText(id, opts.text);
  const draft = opts.draftPrompt ? (await client.draft(id, opts.draftPrompt, true)).draft : null;

  const project = await client.getProject(id);
  let job: JobInfo | null = null;
  if (opts.build) {
    if (!project.documents.length) {
      throw new ApiRequestError(400, "no_sources", `Project ${id} was created but has no sources to build from.`);
    }
    job = await client.runStep(id, "script", STORYBOARD_STEPS.slice(1), opts.useCredits);
  }
  return { project, upload, draft, job };
}

/** Queue the storyboard chain, starting at `from` (default: the script). */
export async function buildStoryboard(client: Doc2VideoClient, projectId: string, from: Step = "script", useCredits = false) {
  const start = STORYBOARD_STEPS.indexOf(from);
  if (start === -1) throw new ApiRequestError(400, "invalid_step", `--from must be one of ${STORYBOARD_STEPS.join(", ")}`);
  return client.runStep(projectId, STORYBOARD_STEPS[start], STORYBOARD_STEPS.slice(start + 1), useCredits);
}

/** AI-engine scenes without a working clip from their engine (as the server decides). */
export function scenesNeedingClips(scenes: SceneInfo[]): SceneInfo[] {
  return scenes.filter(
    (s) =>
      (s.visual_mode === "veo3" || s.visual_mode === "runway") &&
      (!s.has_clip || !!s.clip_failure || (!!s.clip_engine && s.clip_engine !== s.visual_mode)),
  );
}

/**
 * Queue final production: AI clips (if any scene still needs one), then assembly. Requires
 * purchase. `useCredits`: consent to pay from credits for clips the purchase doesn't cover.
 */
export async function produce(client: Doc2VideoClient, projectId: string, useCredits = false, maxCreditsCents?: number) {
  const project = await client.getProject(projectId);
  if (!project.scenes.length) throw new ApiRequestError(400, "no_scenes", "Build the storyboard before producing the video.");
  return scenesNeedingClips(project.scenes).length
    ? client.runStep(projectId, "clips", ["assemble"], useCredits, maxCreditsCents)
    : client.runStep(projectId, "assemble");
}

/**
 * Whether the project is done processing. Between a chained job completing
 * and the worker queueing the next step there is a brief window with no
 * active job, so a completed job that still has `then` steps counts as busy.
 */
export function projectIdle(jobs: JobInfo[]): { idle: boolean; pendingChain: boolean } {
  if (jobs.some((j) => j.status === "queued" || j.status === "running")) return { idle: false, pendingChain: false };
  const latest = jobs[0];
  const pendingChain = !!latest && latest.status === "completed" && latest.then.length > 0 && !latest.error_message;
  return { idle: !pendingChain, pendingChain };
}

export interface WaitResult {
  done: boolean;
  timed_out: boolean;
  elapsed_seconds: number;
  /** Jobs that finished while waiting, oldest first. */
  finished: JobInfo[];
  project: ProjectDetail;
}

/** Poll until no jobs are queued/running (including pending chain steps), or until the timeout. */
export async function waitForProject(
  client: Doc2VideoClient,
  projectId: string,
  opts: { timeoutSeconds?: number; intervalSeconds?: number; onUpdate?: (active: JobInfo[]) => void } = {},
): Promise<WaitResult> {
  const timeoutMs = (opts.timeoutSeconds ?? 1800) * 1000;
  const intervalMs = (opts.intervalSeconds ?? (Number(process.env.D2V_POLL_INTERVAL_SECONDS) || 5)) * 1000;
  const started = Date.now();
  let pendingSince: number | null = null;
  let lastSignature = "";

  for (;;) {
    const jobs = await client.listJobs(projectId, { limit: 20 });
    const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
    const signature = active.map((j) => `${j.id}:${j.status}:${j.progress_pct}`).join("|");
    if (signature !== lastSignature) {
      lastSignature = signature;
      opts.onUpdate?.(active);
    }

    const { idle, pendingChain } = projectIdle(jobs);
    pendingSince = pendingChain ? pendingSince ?? Date.now() : null;
    // If the worker never picks up the chain (e.g. it restarted), stop waiting after a minute
    const stalled = pendingSince !== null && Date.now() - pendingSince > 60_000;
    const elapsed = Date.now() - started;

    if (idle || stalled || elapsed >= timeoutMs) {
      const finished = jobs
        .filter((j) => j.completed_at && new Date(j.completed_at).getTime() >= started - 1000)
        .reverse();
      return {
        done: idle || stalled,
        timed_out: !(idle || stalled),
        elapsed_seconds: Math.round(elapsed / 1000),
        finished,
        project: await client.getProject(projectId),
      };
    }
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, timeoutMs - elapsed)));
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9-_ ]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "project";
}

async function fetchToFile(url: string, path: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
  return Number(res.headers.get("content-length") ?? 0);
}

/**
 * Download the storyboard for offline review: each scene's keyframe image plus
 * a storyboard.md with titles, modes, photos and narration. Useful for agents
 * (like Claude Code) that can read image files.
 */
export async function pullStoryboard(client: Doc2VideoClient, projectId: string, outDir?: string) {
  const project = await client.getProject(projectId);
  const dir = resolve(outDir ?? `d2v-${slug(project.name)}`);
  await mkdir(dir, { recursive: true });

  const images: { scene_number: number; path: string }[] = [];
  const failures: string[] = [];
  for (const scene of project.scenes) {
    if (!scene.keyframe_url) continue;
    const path = join(dir, `scene_${String(scene.scene_number).padStart(2, "0")}.png`);
    try {
      await fetchToFile(scene.keyframe_url, path);
      images.push({ scene_number: scene.scene_number, path });
    } catch (err) {
      failures.push(`scene ${scene.scene_number}: ${(err as Error).message}`);
    }
  }

  const lines = [
    `# ${project.name} — storyboard`,
    "",
    `Project: ${project.id} · ${project.status} · ${project.aspect_ratio} · ${project.scenes.length} scenes`,
  ];
  if (project.settings.creative_direction) lines.push("", `Creative direction: ${project.settings.creative_direction}`);
  if (project.videos.preview?.url) lines.push("", `Preview video: ${project.videos.preview.url}`);

  for (const s of project.scenes) {
    const img = images.find((i) => i.scene_number === s.scene_number);
    lines.push(
      "",
      `## Scene ${s.scene_number}: ${s.title}`,
      "",
      `- Status: ${s.status}${s.approved ? " (approved)" : ""} · Visual: ${s.visual_mode} · ${s.duration_seconds ?? "?"}s`,
      s.photo ? `- Photo: ${s.photo.filename ?? s.photo.document_id} (${s.photo.treatment})` : "- Photo: none (AI-generated visual)",
      img ? `- Keyframe: ${img.path}` : "- Keyframe: not generated yet",
    );
    if (s.clip_failure) lines.push(`- Clip failed: ${s.clip_failure.reason}`);
    lines.push("", `Narration: ${s.narration_text ?? "(none)"}`, "", `Visual prompt: ${s.visual_prompt ?? "(none)"}`);
  }
  const markdownPath = join(dir, "storyboard.md");
  await writeFile(markdownPath, lines.join("\n") + "\n", "utf-8");

  return { dir, markdown_path: markdownPath, images, failures };
}

/** Download the final video (requires purchase). */
export async function downloadVideo(client: Doc2VideoClient, projectId: string, outPath?: string) {
  const { download_url, filename } = await client.download(projectId);
  const path = resolve(outPath ?? (filename || "video.mp4"));
  await fetchToFile(download_url, path);
  return { path };
}

/**
 * Fetch keyframes as base64 for an MCP image response. Uses the site's image
 * optimizer for a small WebP thumbnail, falling back to the original PNG.
 */
export async function fetchKeyframeImages(client: Doc2VideoClient, scenes: SceneInfo[]) {
  const results: { scene_number: number; mimeType: string; data: string }[] = [];
  for (const scene of scenes) {
    if (!scene.keyframe_url) continue;
    const thumb = `${client.baseUrl}/_next/image?url=${encodeURIComponent(scene.keyframe_url)}&w=828&q=70`;
    let res = await fetch(thumb, { headers: { Accept: "image/webp,image/jpeg" } }).catch(() => null);
    if (!res?.ok) res = await fetch(scene.keyframe_url).catch(() => null);
    if (!res?.ok) continue;
    const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0];
    results.push({ scene_number: scene.scene_number, mimeType, data: Buffer.from(await res.arrayBuffer()).toString("base64") });
  }
  return results;
}
