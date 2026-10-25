import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiRequestError, CLI_VERSION, Doc2VideoClient, setClientTag } from "./client.js";
import { saveLogin, type PendingLogin, type ResolvedConfig } from "./config.js";
import { MCP_INSTRUCTIONS } from "./guide.js";
import { clientName, startDeviceLogin, waitForDeviceLogin } from "./login.js";
import {
  buildStoryboard,
  createProjectWithSources,
  downloadVideo,
  fetchKeyframeImages,
  photoPatch,
  produce,
  pullStoryboard,
  resolveProjectId,
  STORYBOARD_STEPS,
  uploadSources,
  waitForProject,
} from "./ops.js";
import { STEPS, VISUAL_MODES, type ProjectDetail, type ProjectSettings, type ScenePatch } from "./types.js";

const MAX_CREDITS_DESCRIPTION =
  "With use_credits: the amount the user agreed to, in cents (the cost_cents you were quoted). If the call would cost more, it asks again instead of charging.";

const USE_CREDITS_DESCRIPTION =
  "Pay from the user's credits when the call needs it: $0.50 for a storyboard beyond today's free ones, or AI clips " +
  "beyond what the purchase covers (the credits_confirm_required error says how much). Only set true after the user " +
  "agreed to spend that amount.";

/** Keep image responses well under client message limits. */
const MAX_IMAGE_PAYLOAD_BYTES = 8 * 1024 * 1024;

const project = z.string().describe("Project id, 8-character id prefix, or exact project name");
const scene = z.number().int().min(1).describe("Scene number (1, 2, 3…)");
const stepEnum = z.enum(STEPS as [string, ...string[]]);

const settingsShape = {
  client_name: z.string().optional().describe("Client or brand name"),
  duration_seconds: z.number().int().min(0).max(1800).optional().describe("Target length in seconds; 0 = AI picks from the content"),
  aspect_ratio: z.enum(["9:16", "16:9"]).optional().describe("9:16 portrait (Reels/TikTok/Shorts) or 16:9 landscape (YouTube/presentations)"),
  creative_direction: z.string().optional().describe("Tone, visual style, focus, audience, things to avoid"),
  voice: z.string().optional().describe("Narrator voice name or id (see d2v_list_voices)"),
  voice_stability: z.number().min(0).max(1).optional(),
  consistency: z.boolean().optional().describe("Keep characters/style consistent by referencing earlier keyframes (default on)"),
  photo_treatment: z.enum(["original", "restyle"]).optional().describe("How user photos become visuals: original = the photo itself, restyle = AI-enhanced from the photo"),
  contact_email: z.string().optional().describe("Shown in the closing call to action"),
  contact_phone: z.string().optional(),
  contact_website: z.string().optional(),
};

type SettingsArgs = { [K in keyof typeof settingsShape]?: z.infer<(typeof settingsShape)[K]> } & { name?: string };

function toSettings(a: SettingsArgs): ProjectSettings {
  const s: ProjectSettings = {};
  if (a.name !== undefined) s.name = a.name;
  if (a.client_name !== undefined) s.client_name = a.client_name || null;
  if (a.duration_seconds !== undefined) s.target_duration_seconds = a.duration_seconds;
  if (a.aspect_ratio !== undefined) s.aspect_ratio = a.aspect_ratio;
  if (a.creative_direction !== undefined) s.creative_direction = a.creative_direction || null;
  if (a.voice !== undefined) s.voice = a.voice;
  if (a.voice_stability !== undefined) s.voice_stability = a.voice_stability;
  if (a.consistency !== undefined) s.storytelling_mode = a.consistency;
  if (a.photo_treatment !== undefined) s.photo_treatment = a.photo_treatment;
  if (a.contact_email !== undefined) s.contact_email = a.contact_email || null;
  if (a.contact_phone !== undefined) s.contact_phone = a.contact_phone || null;
  if (a.contact_website !== undefined) s.contact_website = a.contact_website || null;
  return s;
}

const json = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

function errorResult(err: unknown): CallToolResult {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiRequestError && err.status === 401) {
    message += " Call d2v_connect_account to connect the user's doc2video account.";
  }
  if (err instanceof ApiRequestError && err.status === 429) {
    message += " Don't retry right away; tell the user (a daily free limit or rate limit was reached).";
  }
  if (err instanceof ApiRequestError && err.code === "credits_confirm_required") {
    const cost = typeof err.details.cost_cents === "number" ? err.details.cost_cents : null;
    message += cost === null
      ? " Ask the user whether to spend that amount of their credits; only if they agree, call again with use_credits: true."
      : ` Ask the user whether to spend $${(cost / 100).toFixed(2)} of their credits; only if they agree, call again with ` +
        `use_credits: true and max_credits_cents: ${cost} (if the price changed meanwhile, you'll be asked again).`;
  } else if (err instanceof ApiRequestError && err.code === "credits_required") {
    message += " Tell the user; if they want to continue today, d2v_add_credits_link gives them a link to add credits.";
  } else if (err instanceof ApiRequestError && err.status === 402) {
    message += " The user must unlock the project first: show d2v_estimate_cost, then (only if they ask) d2v_create_checkout_link, d2v_unlock_with_credits or d2v_redeem_promo_code.";
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** A compact status for polling, instead of the whole project. */
function status(p: ProjectDetail) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    url: p.url,
    scene_count: p.scenes.length,
    failed_scenes: p.scenes.filter((s) => s.status === "failed").map((s) => s.scene_number),
    active_jobs: p.active_jobs,
    last_job: p.recent_jobs[0] ?? null,
    preview_url: p.videos.preview?.url ?? null,
    final_video_ready: !!p.videos.final,
    purchased: p.purchased,
    next_steps: p.next_steps,
  };
}

export async function startMcpServer(cfg: ResolvedConfig): Promise<void> {
  const client = new Doc2VideoClient(cfg.baseUrl, cfg.apiKey);
  const server = new McpServer({ name: "doc2video", version: CLI_VERSION }, { instructions: MCP_INSTRUCTIONS });

  // Tell the API which agent is driving (Claude Code, Codex, Cursor…) once it has introduced itself
  setClientTag(`mcp/${CLI_VERSION}`);
  server.server.oninitialized = () => {
    const agent = server.server.getClientVersion()?.name;
    if (agent) setClientTag(`mcp/${CLI_VERSION}; agent=${agent.replace(/[;\r\n]/g, "").slice(0, 60)}`);
  };
  const resolve = (ref: string) => resolveProjectId(client, ref);

  // Every tool reports failures as an MCP tool error the model can read and act on.
  const register = ((name: string, config: unknown, cb: (...args: unknown[]) => Promise<CallToolResult>) =>
    server.registerTool(name, config as never, (async (...args: unknown[]) => {
      try {
        return await cb(...args);
      } catch (err) {
        return errorResult(err);
      }
    }) as never)) as unknown as typeof server.registerTool;

  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  // ── Account ──────────────────────────────────────────────────

  // A device login started by one d2v_connect_account call and finished by a later one
  let pendingLogin: PendingLogin | null = null;

  register("d2v_connect_account", {
    title: "Connect doc2video account",
    description:
      "Connect this server to the user's doc2video account. Call it first when other tools say the user is not logged in. " +
      "It returns a link: ask the user to open it, sign in or sign up, and click Approve, then call this tool again to finish.",
    inputSchema: {
      wait_seconds: z.number().int().min(0).max(120).optional().describe("How long to wait for approval on this call (default 30)"),
    },
    annotations: write,
  }, async (a) => {
    if (client.hasApiKey()) {
      try {
        return json({ connected: true, email: (await client.me()).email });
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.status !== 401) throw err;
      }
    }

    if (!pendingLogin || Date.parse(pendingLogin.expiresAt) < Date.now()) {
      const via = server.server.getClientVersion()?.name ?? "MCP client";
      pendingLogin = await startDeviceLogin(cfg.baseUrl, clientName(`${via} via d2v`));
      return json({
        connected: false,
        verification_url: pendingLogin.verificationUrl,
        user_code: pendingLogin.userCode,
        expires_at: pendingLogin.expiresAt,
        next: "Ask the user to open verification_url, sign in (or sign up), check the code matches and click Approve. Then call d2v_connect_account again.",
      });
    }

    const pending = pendingLogin;
    try {
      const result = await waitForDeviceLogin(pending, a.wait_seconds ?? 30);
      saveLogin(result.apiKey, pending.baseUrl);
      client.setApiKey(result.apiKey);
      pendingLogin = null;
      return json({ connected: true, email: result.email });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "login_timeout") {
        return json({
          connected: false,
          still_waiting: true,
          verification_url: pending.verificationUrl,
          user_code: pending.userCode,
          next: "Not approved yet. Remind the user to open the link and click Approve, then call d2v_connect_account again.",
        });
      }
      pendingLogin = null; // expired or denied: the next call starts over
      throw err;
    }
  });

  // ── Discovery ────────────────────────────────────────────────

  register("d2v_list_projects", {
    title: "List projects",
    description: "List the user's doc2video projects (id, name, status, format).",
    inputSchema: {},
    annotations: readOnly,
  }, async () => json({ projects: await client.listProjects() }));

  register("d2v_get_project", {
    title: "Get project",
    description: "Full project detail: settings, sources, every scene (narration, visual mode, photo, keyframe URL), jobs, preview/final video, cost estimate and suggested next steps.",
    inputSchema: { project },
    annotations: readOnly,
  }, async (a) => json(await client.getProject(await resolve(a.project))));

  register("d2v_list_voices", {
    title: "List narrator voices",
    description: "Narrator voices available for projects.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => json({ voices: await client.voices() }));

  // ── Create & sources ─────────────────────────────────────────

  register("d2v_create_project", {
    title: "Create project",
    description:
      "Create a video project from local files and folders (uploaded from this machine), written text, or an AI draft prompt. " +
      "Photos (jpg/png/webp/heic) are featured in scenes; documents (pdf/docx/pptx/md/txt/csv/json) supply the story. " +
      "Set build: true to start generating the storyboard right away (then poll d2v_wait).",
    inputSchema: {
      name: z.string().min(1).describe("Project name"),
      sources: z.array(z.string()).optional().describe("Absolute paths of local files or folders to upload"),
      text: z.string().optional().describe("Written content to use as a source"),
      draft_prompt: z.string().optional().describe("Have AI write the source content from this description"),
      build: z.boolean().optional().describe("Start the storyboard pipeline immediately (default false)"),
      use_credits: z.boolean().optional().describe(USE_CREDITS_DESCRIPTION),
      ...settingsShape,
    },
    annotations: write,
  }, async (a) => {
    const result = await createProjectWithSources(client, { ...toSettings(a), name: a.name }, {
      paths: a.sources,
      text: a.text,
      draftPrompt: a.draft_prompt,
      build: a.build,
      useCredits: a.use_credits,
    });
    return json({ project: status(result.project), sources: result.project.documents, upload: result.upload, job: result.job });
  });

  register("d2v_add_sources", {
    title: "Add sources",
    description: "Upload more local files/folders or add written content to a project. Rebuild the storyboard afterwards for them to take effect.",
    inputSchema: {
      project,
      sources: z.array(z.string()).optional().describe("Absolute paths of local files or folders"),
      text: z.string().optional().describe("Written content to add"),
    },
    annotations: write,
  }, async (a) => {
    const id = await resolve(a.project);
    const upload = a.sources?.length ? await uploadSources(client, id, a.sources) : null;
    const textDoc = a.text ? await client.addText(id, a.text) : null;
    return json({ upload, text_document: textDoc });
  });

  register("d2v_remove_source", {
    title: "Remove source",
    description: "Delete a source document or photo from a project, by document id or filename.",
    inputSchema: { project, document: z.string().describe("Document id or filename") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (a) => {
    const id = await resolve(a.project);
    const { documents } = await client.getProject(id);
    const target = a.document.toLowerCase();
    const doc = documents.find((d) => d.id === target) ?? documents.find((d) => d.filename.toLowerCase() === target);
    if (!doc) throw new Error(`No source named "${a.document}" in this project`);
    await client.deleteDocument(id, doc.id);
    return json({ deleted: doc });
  });

  register("d2v_update_project", {
    title: "Update project settings",
    description: "Change project settings. They apply to steps run afterwards (e.g. run narration again after a voice change).",
    inputSchema: { project, name: z.string().optional(), ...settingsShape },
    annotations: write,
  }, async (a) => json(status(await client.updateProject(await resolve(a.project), toSettings(a)))));

  register("d2v_draft_content", {
    title: "AI-draft source content",
    description: "Have AI write the video's source content from a short description (saved as the project's AI content brief by default).",
    inputSchema: { project, prompt: z.string().min(10), save: z.boolean().optional().describe("Default true") },
    annotations: write,
  }, async (a) => json(await client.draft(await resolve(a.project), a.prompt, a.save ?? true)));

  register("d2v_suggest_creative_direction", {
    title: "Suggest creative direction",
    description: "Suggest a creative direction from the project's sources and optional preferences; save: true stores it on the project.",
    inputSchema: { project, preferences: z.string().optional(), save: z.boolean().optional() },
    annotations: write,
  }, async (a) =>
    json(await client.suggestDirection(await resolve(a.project), a.preferences ? { notes: a.preferences } : {}, a.save ?? false)));

  // ── Pipeline ─────────────────────────────────────────────────

  register("d2v_build_storyboard", {
    title: "Build storyboard",
    description:
      "Queue the storyboard chain on the server: script → keyframes → narration → preview. `from` starts later in the chain. " +
      "Starting from the script replaces existing scenes, so it needs force: true when scenes exist. Poll d2v_wait afterwards.",
    inputSchema: {
      project,
      from: z.enum(STORYBOARD_STEPS as [string, ...string[]]).optional(),
      force: z.boolean().optional(),
      use_credits: z.boolean().optional().describe(USE_CREDITS_DESCRIPTION),
    },
    annotations: write,
  }, async (a) => {
    const id = await resolve(a.project);
    const from = (a.from ?? "script") as (typeof STORYBOARD_STEPS)[number];
    if (from === "script" && !a.force) {
      const { scenes } = await client.getProject(id);
      if (scenes.length) throw new Error(`Project already has ${scenes.length} scenes; rebuilding the script replaces them. Pass force: true, or from: keyframes|narration|preview.`);
    }
    return json({ job: await buildStoryboard(client, id, from, a.use_credits) });
  });

  register("d2v_run_step", {
    title: "Run pipeline step",
    description: `Queue one pipeline step (${STEPS.join(", ")}), optionally chaining more with \`then\`. clips and assemble require purchase. Poll d2v_wait afterwards.`,
    inputSchema: {
      project,
      step: stepEnum,
      then: z.array(stepEnum).optional(),
      use_credits: z.boolean().optional().describe(USE_CREDITS_DESCRIPTION),
      max_credits_cents: z.number().int().min(0).optional().describe(MAX_CREDITS_DESCRIPTION),
    },
    annotations: write,
  }, async (a) =>
    json({ job: await client.runStep(await resolve(a.project), a.step as never, (a.then ?? []) as never, a.use_credits, a.max_credits_cents) }));

  register("d2v_wait", {
    title: "Wait for jobs",
    description:
      "Block until the project's queued/running jobs finish or timeout_seconds passes (default 50), then return status. " +
      "If done is false, call again. Storyboards take several minutes.",
    inputSchema: { project, timeout_seconds: z.number().int().min(5).max(600).optional() },
    annotations: readOnly,
  }, async (a) => {
    const result = await waitForProject(client, await resolve(a.project), { timeoutSeconds: a.timeout_seconds ?? 50 });
    return json({ done: result.done, elapsed_seconds: result.elapsed_seconds, finished_jobs: result.finished, ...status(result.project) });
  });

  // ── Scenes ───────────────────────────────────────────────────

  register("d2v_view_storyboard", {
    title: "View storyboard",
    description: "See scene keyframe images with their titles and narration. Pass `scenes` to view specific scene numbers (default: all).",
    inputSchema: { project, scenes: z.array(z.number().int().min(1)).optional() },
    annotations: readOnly,
  }, async (a) => {
    const p = await client.getProject(await resolve(a.project));
    const wanted = a.scenes?.length ? p.scenes.filter((s) => a.scenes!.includes(s.scene_number)) : p.scenes;
    const content: CallToolResult["content"] = [
      { type: "text", text: `${p.name} — ${p.scenes.length} scenes, ${p.aspect_ratio}${p.videos.preview?.url ? `, preview video: ${p.videos.preview.url}` : ""}` },
    ];
    const images = await fetchKeyframeImages(client, wanted);
    let bytes = 0;
    const skipped: number[] = [];
    for (const s of wanted) {
      content.push({
        type: "text",
        text: `Scene ${s.scene_number}: ${s.title} [${s.status} · ${s.visual_mode} · ${s.photo ? `photo ${s.photo.filename} (${s.photo.treatment})` : "AI visual"}]\nNarration: ${s.narration_text ?? "(none)"}`,
      });
      const img = images.find((i) => i.scene_number === s.scene_number);
      if (!img) {
        content.push({ type: "text", text: "(no keyframe yet)" });
      } else if (bytes + img.data.length > MAX_IMAGE_PAYLOAD_BYTES) {
        skipped.push(s.scene_number);
      } else {
        bytes += img.data.length;
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }
    if (skipped.length) content.push({ type: "text", text: `Images for scenes ${skipped.join(", ")} omitted to keep the response small — call again with scenes: [${skipped.join(", ")}].` });
    return { content };
  });

  register("d2v_update_scene", {
    title: "Update scene",
    description:
      "Edit one scene: title, narration text (re-voice with d2v_update_narration), visual engine, approval, or photo. " +
      "photo accepts a project photo's filename, a document id, an absolute local file path (uploaded), or \"none\" for an AI visual. " +
      "A photo change regenerates the keyframe unless regenerate_keyframe is false.",
    inputSchema: {
      project,
      scene,
      title: z.string().optional(),
      narration_text: z.string().optional(),
      visual_mode: z.enum(VISUAL_MODES as [string, ...string[]]).optional().describe("still | kenburns (pan/zoom) | runway (AI video) | veo3 (best AI video)"),
      approved: z.boolean().optional(),
      photo: z.string().optional(),
      photo_treatment: z.enum(["original", "restyle"]).optional(),
      regenerate_keyframe: z.boolean().optional(),
    },
    annotations: write,
  }, async (a) => {
    const id = await resolve(a.project);
    const patch: ScenePatch = {};
    if (a.title !== undefined) patch.title = a.title;
    if (a.narration_text !== undefined) patch.narration_text = a.narration_text;
    if (a.visual_mode !== undefined) patch.visual_mode = a.visual_mode as ScenePatch["visual_mode"];
    if (a.approved !== undefined) patch.approved = a.approved;
    const photo = await photoPatch(client, id, a.photo, a.photo_treatment);
    if (photo !== undefined) patch.photo = photo;

    const result = await client.updateScene(id, a.scene, patch);
    const job = photo !== undefined && a.regenerate_keyframe !== false
      ? await client.regenerateKeyframe(id, a.scene, { mode: "fresh" })
      : null;
    return json({ ...result, keyframe_job: job });
  });

  register("d2v_regenerate_keyframe", {
    title: "Regenerate keyframe",
    description:
      "Regenerate one scene's image. With a direction and mode iterate (default when a keyframe exists) the current image is edited; " +
      "mode fresh creates a new image from the scene description (plus direction). Run the preview step afterwards to update the video.",
    inputSchema: {
      project,
      scene,
      direction: z.string().optional().describe("What to change, e.g. \"golden-hour light, add the storefront sign\""),
      mode: z.enum(["iterate", "fresh"]).optional(),
    },
    annotations: write,
  }, async (a) => {
    const id = await resolve(a.project);
    const mode = a.mode ?? (a.direction ? "iterate" : "fresh");
    return json({ job: await client.regenerateKeyframe(id, a.scene, { direction: a.direction, mode }) });
  });

  register("d2v_update_narration", {
    title: "Update narration",
    description:
      "Change a scene's narration and regenerate its voice-over: pass exact `text`, or a `prompt` for an AI rewrite, or neither to just re-voice. " +
      "regenerate_audio: false saves text only.",
    inputSchema: { project, scene, text: z.string().optional(), prompt: z.string().optional(), regenerate_audio: z.boolean().optional() },
    annotations: write,
  }, async (a) =>
    json(await client.narration(await resolve(a.project), a.scene, { text: a.text, prompt: a.prompt, audio: a.regenerate_audio ?? true })));

  register("d2v_retry_clip", {
    title: "Retry AI clip",
    description: "Retry a scene's failed AI video clip, optionally on another engine (still/kenburns drop the clip). AI clips " +
      "require purchase; retrying a failed clip is free, while a pricier engine or a new take of a working clip may cost credits.",
    inputSchema: {
      project,
      scene,
      engine: z.enum(VISUAL_MODES as [string, ...string[]]).optional(),
      use_credits: z.boolean().optional().describe(USE_CREDITS_DESCRIPTION),
      max_credits_cents: z.number().int().min(0).optional().describe(MAX_CREDITS_DESCRIPTION),
    },
    annotations: write,
  }, async (a) => json(await client.retryClip(await resolve(a.project), a.scene, a.engine, a.use_credits, a.max_credits_cents)));

  register("d2v_pull_storyboard", {
    title: "Save storyboard locally",
    description: "Download every keyframe PNG plus a storyboard.md (titles, narration, prompts) to a local folder.",
    inputSchema: { project, output_dir: z.string().optional().describe("Defaults to ./d2v-<project-name>") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (a) => json(await pullStoryboard(client, await resolve(a.project), a.output_dir)));

  // ── Billing & output ─────────────────────────────────────────

  register("d2v_estimate_cost", {
    title: "Estimate cost",
    description: "Price to unlock AI clips, final assembly and download, broken down by each scene's visual engine. Only AI work is charged: photos used as-is are free except for AI video clips.",
    inputSchema: { project },
    annotations: readOnly,
  }, async (a) => json(await client.estimate(await resolve(a.project))));

  register("d2v_create_checkout_link", {
    title: "Create checkout link",
    description: "Create a Stripe checkout URL for the user to open and pay in their browser. Only call when the user asks to purchase.",
    inputSchema: { project },
    annotations: write,
  }, async (a) => json(await client.checkout(await resolve(a.project))));

  register("d2v_get_credits", {
    title: "Get credits",
    description: "The user's prepaid credit balance, free storyboards left today, and recent credit activity.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => json(await client.credits()));

  register("d2v_add_credits_link", {
    title: "Add credits link",
    description: "Create a Stripe checkout link for the user to add $5, $10 or $25 of credits in their browser. Only when the user asks.",
    inputSchema: { amount_dollars: z.union([z.literal(5), z.literal(10), z.literal(25)]) },
    annotations: write,
  }, async (a) => json(await client.creditCheckout(a.amount_dollars * 100)));

  register("d2v_unlock_with_credits", {
    title: "Unlock with credits",
    description: "Unlock a project (AI clips, final assembly, download) by paying its price from the user's credits. Only when the user asks; show d2v_estimate_cost first.",
    inputSchema: { project },
    annotations: write,
  }, async (a) => json(await client.unlockWithCredits(await resolve(a.project))));

  register("d2v_redeem_promo_code", {
    title: "Redeem promo code",
    description: "Unlock a project with a promo code the user provided (one code per account).",
    inputSchema: { project, code: z.string().min(1) },
    annotations: write,
  }, async (a) => json(await client.redeem(await resolve(a.project), a.code)));

  register("d2v_produce_video", {
    title: "Produce final video",
    description: "Generate AI clips for veo3/runway scenes (if needed) then assemble the final video. Requires purchase; only call when the user asks. " +
      "Clips beyond what the purchase covers (engines changed to pricier ones after buying) need the user's OK to pay from credits. Poll d2v_wait afterwards.",
    inputSchema: {
      project,
      use_credits: z.boolean().optional().describe(USE_CREDITS_DESCRIPTION),
      max_credits_cents: z.number().int().min(0).optional().describe(MAX_CREDITS_DESCRIPTION),
    },
    annotations: write,
  }, async (a) => json({ job: await produce(client, await resolve(a.project), a.use_credits, a.max_credits_cents) }));

  register("d2v_download_video", {
    title: "Download final video",
    description: "Save the final MP4 to this machine (requires purchase).",
    inputSchema: { project, output_path: z.string().optional().describe("Defaults to <project name>.mp4 in the working directory") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (a) => json(await downloadVideo(client, await resolve(a.project), a.output_path)));

  await server.connect(new StdioServerTransport());
  process.stderr.write(`doc2video MCP server ${CLI_VERSION} ready (${cfg.baseUrl}${cfg.apiKey ? "" : ", not logged in yet — call d2v_connect_account or run d2v login"})\n`);
}
