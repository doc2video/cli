#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { ApiRequestError, CLI_VERSION, Doc2VideoClient } from "./client.js";
import { clearConfig, configPath, readConfig, resolveConfig, saveLogin, writeConfig } from "./config.js";
import { describeFiles } from "./files.js";
import * as fmt from "./format.js";
import { AGENT_GUIDE } from "./guide.js";
import { clientName, startDeviceLogin, waitForDeviceLogin } from "./login.js";
import {
  buildStoryboard,
  createProjectWithSources,
  downloadVideo,
  photoPatch,
  produce,
  pullStoryboard,
  resolveProjectId,
  STORYBOARD_STEPS,
  uploadSources,
  waitForProject,
  type UploadResult,
  type WaitResult,
} from "./ops.js";
import { STEPS, VISUAL_MODES, type JobInfo, type ProjectSettings, type ScenePatch, type Step, type VisualMode } from "./types.js";

// ── Plumbing ─────────────────────────────────────────────────────

class UsageError extends Error {}

type OptionSpec = { type: "string" | "boolean"; short?: string };
type Values = Record<string, string | boolean | undefined>;

interface Output {
  data: unknown;
  text: string;
  exitCode?: number;
}

interface Ctx {
  args: string[];
  opts: Values;
  client: () => Doc2VideoClient;
  project: (ref: string | undefined) => Promise<string>;
}

interface Command {
  usage: string;
  summary: string;
  help?: string;
  options?: Record<string, OptionSpec>;
  run: (ctx: Ctx) => Promise<Output>;
}

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean" },
  key: { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const SETTINGS_OPTIONS: Record<string, OptionSpec> = {
  client: { type: "string" },
  duration: { type: "string" },
  aspect: { type: "string" },
  direction: { type: "string" },
  voice: { type: "string" },
  stability: { type: "string" },
  consistency: { type: "boolean" },
  "no-consistency": { type: "boolean" },
  photos: { type: "string" },
  email: { type: "string" },
  phone: { type: "string" },
  website: { type: "string" },
};

const SETTINGS_HELP = `Settings:
  --client NAME            client name shown in the project
  --duration LEN           auto | 30s | 1m | 2m | 5m | 10m | seconds
  --aspect RATIO           9:16 (portrait) | 16:9 (landscape)
  --direction TEXT         creative direction: tone, style, focus, audience
  --voice NAME             narrator voice (see \`d2v voices\`)
  --stability 0-1          voice stability (default 0.5)
  --consistency / --no-consistency   reuse earlier keyframes for visual consistency
  --photos MODE            original (use photos as-is) | restyle (AI-enhance photos)
  --email / --phone / --website      contact details for the closing call to action`;

const WAIT_OPTIONS: Record<string, OptionSpec> = {
  wait: { type: "boolean", short: "w" },
  timeout: { type: "string" },
};

const log = (message: string) => process.stderr.write(message + "\n");
const str = (value: string | boolean | undefined) => (typeof value === "string" ? value : undefined);

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`Missing ${what}`);
  return value;
}

/** --max-credits in dollars ("1.15" or "$1.15") → cents; undefined when not given. */
function maxCredits(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const dollars = Number(value.trim().replace(/^\$/, ""));
  if (!Number.isFinite(dollars) || dollars < 0) throw new UsageError(`Invalid --max-credits "${value}" (dollars, e.g. 1.15)`);
  return Math.round(dollars * 100);
}

function sceneNumber(value: string | undefined): number {
  const n = Number(need(value, "scene number"));
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`Scene must be a number, got "${value}"`);
  return n;
}

function parseDuration(value: string): number {
  const v = value.trim().toLowerCase();
  if (v === "auto") return 0;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min)?$/);
  if (!m) throw new UsageError(`Invalid --duration "${value}" (use auto, 30s, 2m, or seconds)`);
  const n = Number(m[1]) * (m[2]?.startsWith("m") ? 60 : 1);
  return Math.round(n);
}

function parseAspect(value: string): "16:9" | "9:16" {
  const v = value.trim().toLowerCase();
  if (["16:9", "landscape", "wide", "horizontal"].includes(v)) return "16:9";
  if (["9:16", "portrait", "vertical", "tall"].includes(v)) return "9:16";
  throw new UsageError(`Invalid --aspect "${value}" (use 9:16 or 16:9)`);
}

function settingsFrom(opts: Values): ProjectSettings {
  const s: ProjectSettings = {};
  if (str(opts.name)) s.name = str(opts.name);
  if (opts.client !== undefined) s.client_name = str(opts.client) || null;
  if (str(opts.duration)) s.target_duration_seconds = parseDuration(str(opts.duration)!);
  if (str(opts.aspect)) s.aspect_ratio = parseAspect(str(opts.aspect)!);
  if (opts.direction !== undefined) s.creative_direction = str(opts.direction) || null;
  if (str(opts.voice)) s.voice = str(opts.voice);
  if (str(opts.stability)) {
    const n = Number(opts.stability);
    if (!(n >= 0 && n <= 1)) throw new UsageError("--stability must be between 0 and 1");
    s.voice_stability = n;
  }
  if (opts.consistency) s.storytelling_mode = true;
  if (opts["no-consistency"]) s.storytelling_mode = false;
  if (str(opts.photos)) {
    if (!["original", "restyle"].includes(str(opts.photos)!)) throw new UsageError("--photos must be original or restyle");
    s.photo_treatment = str(opts.photos) as "original" | "restyle";
  }
  if (opts.email !== undefined) s.contact_email = str(opts.email) || null;
  if (opts.phone !== undefined) s.contact_phone = str(opts.phone) || null;
  if (opts.website !== undefined) s.contact_website = str(opts.website) || null;
  return s;
}

function timeoutFrom(opts: Values): number {
  const t = str(opts.timeout);
  if (!t) return 1800;
  const n = parseDuration(t);
  if (!n) throw new UsageError("--timeout must be a positive duration (e.g. 600, 10m)");
  return n;
}

function openUrl(url: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  // No browser launcher (servers, sandboxes) is fine: the URL is printed too
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function uploadText(result: UploadResult | null): string {
  if (!result) return "";
  const lines = [`Uploaded ${result.uploaded.length} file(s).`];
  for (const f of result.failed) lines.push(`  ✗ ${f.path}: ${f.error}`);
  for (const s of result.skipped) lines.push(`  skipped ${s.path} — ${s.reason}`);
  for (const w of result.warnings) lines.push(`  note: ${w}`);
  return lines.join("\n");
}

function onUploadProgress(file: { name: string }, outcome: string, error?: string) {
  log(outcome === "uploaded" ? `  ↑ ${file.name}` : `  ✗ ${file.name}: ${error}`);
}

function logActive(active: JobInfo[]) {
  const time = new Date().toLocaleTimeString();
  if (!active.length) return;
  log(`[${time}] ${active.map(fmt.formatJob).join(" | ")}`);
}

async function waitOutput(ctx: Ctx, projectId: string, base?: Output): Promise<Output> {
  log("Waiting for jobs to finish (Ctrl+C stops waiting; the work continues on the server)…");
  const result: WaitResult = await waitForProject(ctx.client(), projectId, { timeoutSeconds: timeoutFrom(ctx.opts), onUpdate: logActive });
  const finished = result.finished.map((j) => `  ${fmt.formatJob(j)}`);
  const header = result.timed_out
    ? `Still running after ${result.elapsed_seconds}s — check again with \`d2v wait ${projectId.slice(0, 8)}\`.`
    : `Done in ${result.elapsed_seconds}s.`;
  const text = [base?.text, header, ...(finished.length ? ["Finished:", ...finished] : []), "", fmt.formatProject(result.project)]
    .filter((l) => l !== undefined)
    .join("\n");
  return {
    data: base ? { ...(base.data as object), wait: result } : result,
    text,
    exitCode: result.timed_out ? 4 : undefined,
  };
}

async function maybeWait(ctx: Ctx, projectId: string, base: Output): Promise<Output> {
  return ctx.opts.wait ? waitOutput(ctx, projectId, base) : base;
}

const short = (id: string) => id.slice(0, 8);

// ── Commands ─────────────────────────────────────────────────────

const COMMANDS: Record<string, Command> = {
  login: {
    usage: "d2v login [--no-browser] | d2v login --start / --wait | d2v login --key d2v_...",
    summary: "Connect your doc2video account (opens the browser to approve)",
    help: `  (no flags)     open the approval page in your browser and wait for you to approve
  --no-browser   print the link instead of opening it
  --start        for agents: print the link and code, then exit (finish with --wait)
  --wait         for agents: wait for the approval started by --start (--timeout, default 10m)
  --key KEY      use an existing API key from the dashboard's API page instead`,
    options: {
      start: { type: "boolean" },
      wait: { type: "boolean" },
      "no-browser": { type: "boolean" },
      timeout: { type: "string" },
    },
    async run({ opts }) {
      const baseUrl = resolveConfig({ url: str(opts.url) }).baseUrl;
      const timeout = str(opts.timeout) ? timeoutFrom(opts) : 600;
      const done = (result: { email: string; keyName?: string }, url: string) => ({
        data: { email: result.email, key_name: result.keyName ?? null, base_url: url, config: configPath() },
        text: `Logged in as ${result.email} at ${url}.\nKey saved to ${configPath()}`,
      });

      // An existing key from the dashboard
      if (str(opts.key)) {
        const me = await new Doc2VideoClient(baseUrl, str(opts.key)!).me();
        saveLogin(str(opts.key)!, baseUrl);
        return done({ email: me.email }, baseUrl);
      }

      // Agents, step 2: finish a login started with --start
      if (opts.wait) {
        const pending = readConfig().pendingLogin;
        if (!pending) throw new UsageError("No login in progress. Run `d2v login --start` first.");
        log(`Waiting for approval at ${pending.verificationUrl} (code ${pending.userCode})…`);
        const result = await waitForDeviceLogin(pending, timeout);
        saveLogin(result.apiKey, pending.baseUrl);
        return done(result, pending.baseUrl);
      }

      const pending = await startDeviceLogin(baseUrl, clientName("d2v CLI"));

      // Agents, step 1: hand the link to the user and exit
      if (opts.start) {
        writeConfig({ ...readConfig(), pendingLogin: pending });
        return {
          data: {
            verification_url: pending.verificationUrl,
            user_code: pending.userCode,
            expires_at: pending.expiresAt,
            next: "Ask the user to open verification_url and click Approve, then run `d2v login --wait`.",
          },
          text: `Open this link and click Approve:\n  ${pending.verificationUrl}\nCheck the code matches: ${pending.userCode}\nThen run: d2v login --wait`,
        };
      }

      // Interactive: open the browser and wait
      log(`Approve this login in your browser:\n  ${pending.verificationUrl}\nCode: ${pending.userCode} (check it matches the page)`);
      if (!opts["no-browser"]) openUrl(pending.verificationUrl);
      log("Waiting for approval… (Ctrl+C to cancel)");
      const result = await waitForDeviceLogin(pending, timeout);
      saveLogin(result.apiKey, baseUrl);
      return done(result, baseUrl);
    },
  },

  logout: {
    usage: "d2v logout",
    summary: "Forget the saved API key",
    async run() {
      clearConfig();
      return { data: { logged_out: true }, text: "Logged out." };
    },
  },

  whoami: {
    usage: "d2v whoami",
    summary: "Show the account and server in use",
    async run({ client, opts }) {
      const cfg = resolveConfig({ key: str(opts.key), url: str(opts.url) });
      const me = await client().me();
      return { data: { ...me, base_url: cfg.baseUrl, key_source: cfg.keySource }, text: `${me.email} on ${cfg.baseUrl} (key from ${cfg.keySource})` };
    },
  },

  voices: {
    usage: "d2v voices",
    summary: "List narrator voices",
    async run({ client }) {
      const voices = await client().voices();
      return { data: { voices }, text: fmt.formatVoices(voices) };
    },
  },

  projects: {
    usage: "d2v projects",
    summary: "List your projects",
    async run({ client }) {
      const projects = await client().listProjects();
      return { data: { projects }, text: fmt.formatProjectList(projects) };
    },
  },

  create: {
    usage: "d2v create <name> [files or folders...] [settings] [--text TEXT] [--draft PROMPT] [--build] [--wait]",
    summary: "Create a project from a folder of documents and/or photos",
    help: `${SETTINGS_HELP}

Sources:
  files/folders            uploaded (folders recursively); photos are featured in scenes
  --text TEXT              add written content
  --draft PROMPT           have AI write the content from a description

  --build                  start the storyboard: script → keyframes → narration → preview
  --use-credits            if today's free storyboards are used up, pay $0.50 from credits
  --wait, -w               wait for the build to finish (--timeout, default 30m)

Example:
  d2v create "Spring Open House" ./open-house --duration 1m --aspect 9:16 \\
    --direction "Warm, inviting, highlight the garden" --build --wait`,
    options: {
      ...SETTINGS_OPTIONS,
      ...WAIT_OPTIONS,
      text: { type: "string" },
      draft: { type: "string" },
      build: { type: "boolean" },
      "use-credits": { type: "boolean" },
    },
    async run(ctx) {
      const [name, ...paths] = ctx.args;
      const settings = { ...settingsFrom(ctx.opts), name: need(name, "project name") };
      if (!paths.length && !str(ctx.opts.text) && !str(ctx.opts.draft) && ctx.opts.build) {
        throw new UsageError("Nothing to build from — pass files/folders, --text, or --draft");
      }

      const result = await createProjectWithSources(ctx.client(), settings, {
        paths,
        text: str(ctx.opts.text),
        draftPrompt: str(ctx.opts.draft),
        build: !!ctx.opts.build,
        useCredits: !!ctx.opts["use-credits"],
        onProgress: onUploadProgress,
      });

      const p = result.project;
      const text = [
        `Created ${p.name} (${p.id})`,
        p.url,
        uploadText(result.upload),
        result.draft ? "AI drafted the source content." : "",
        result.job
          ? `Building storyboard: ${fmt.formatJob(result.job)}`
          : `Next: d2v build ${short(p.id)} --wait`,
      ].filter(Boolean).join("\n");
      const out = { data: result, text };
      return result.job ? maybeWait(ctx, p.id, out) : out;
    },
  },

  show: {
    usage: "d2v show <project> [--full]",
    summary: "Project status, storyboard and suggested next steps",
    options: { full: { type: "boolean" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const project = await ctx.client().getProject(id);
      const text = ctx.opts.full
        ? [fmt.formatProject({ ...project, scenes: [] }), "", ...project.scenes.map((s) => fmt.formatScene(s, { full: true }))].join("\n")
        : fmt.formatProject(project);
      return { data: project, text };
    },
  },

  open: {
    usage: "d2v open <project>",
    summary: "Open the project in your browser",
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const { url } = await ctx.client().getProject(id);
      openUrl(url);
      return { data: { url }, text: url };
    },
  },

  set: {
    usage: "d2v set <project> [--name NAME] [settings]",
    summary: "Change project settings",
    help: SETTINGS_HELP,
    options: { ...SETTINGS_OPTIONS, name: { type: "string" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const settings = settingsFrom(ctx.opts);
      if (!Object.keys(settings).length) throw new UsageError("No settings given. See `d2v set --help`.");
      const project = await ctx.client().updateProject(id, settings);
      const hint = project.scenes.length
        ? "\nSettings apply to steps you run from now on (e.g. `d2v run <p> narration` after a voice change)."
        : "";
      return { data: project, text: `Updated ${Object.keys(settings).join(", ")}.${hint}` };
    },
  },

  add: {
    usage: "d2v add <project> [files or folders...] [--text TEXT]",
    summary: "Upload more documents/photos or add written content",
    options: { text: { type: "string" } },
    async run(ctx) {
      const [ref, ...paths] = ctx.args;
      const id = await ctx.project(ref);
      if (!paths.length && !str(ctx.opts.text)) throw new UsageError("Pass files/folders or --text");
      const upload = paths.length ? await uploadSources(ctx.client(), id, paths, onUploadProgress) : null;
      const textDoc = str(ctx.opts.text) ? await ctx.client().addText(id, str(ctx.opts.text)!) : null;
      const text = [uploadText(upload), textDoc ? "Added written content." : ""].filter(Boolean).join("\n");
      return { data: { upload, text_document: textDoc }, text: text || "Nothing added." };
    },
  },

  remove: {
    usage: "d2v remove <project> <document id or filename>",
    summary: "Remove a source document or photo",
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const target = need(ctx.args[1], "document id or filename").toLowerCase();
      const { documents } = await ctx.client().getProject(id);
      const doc = documents.find((d) => d.id === target) ?? documents.find((d) => d.filename.toLowerCase() === target);
      if (!doc) throw new UsageError(`No source named "${ctx.args[1]}" in this project`);
      await ctx.client().deleteDocument(id, doc.id);
      return { data: { deleted: doc }, text: `Removed ${doc.filename}.` };
    },
  },

  draft: {
    usage: "d2v draft <project> <description...> [--no-save]",
    summary: "Have AI write the source content from a description",
    options: { "no-save": { type: "boolean" } },
    async run(ctx) {
      const [ref, ...words] = ctx.args;
      const id = await ctx.project(ref);
      const prompt = need(words.join(" ").trim(), "description");
      const result = await ctx.client().draft(id, prompt, !ctx.opts["no-save"]);
      return { data: result, text: `${result.draft}\n\n${result.document ? "Saved as the project's AI content brief." : "(not saved)"}` };
    },
  },

  direction: {
    usage: "d2v direction <project> [preferences...] [--save]",
    summary: "Suggest a creative direction from your sources",
    options: { save: { type: "boolean" } },
    async run(ctx) {
      const [ref, ...words] = ctx.args;
      const id = await ctx.project(ref);
      const notes = words.join(" ").trim();
      const result = await ctx.client().suggestDirection(id, notes ? { notes } : {}, !!ctx.opts.save);
      return { data: result, text: `${result.creative_direction}\n\n${result.saved ? "Saved." : "Not saved — rerun with --save, or `d2v set <p> --direction \"...\"`."}` };
    },
  },

  build: {
    usage: "d2v build <project> [--from STEP] [--force] [--wait]",
    summary: "Generate the storyboard: script → keyframes → narration → preview",
    help: `  --from STEP    start at keyframes, narration or preview instead of the script
  --force        regenerate the script even though scenes already exist
  --use-credits  if today's free storyboards are used up, pay $0.50 from credits
  --wait, -w     wait for it to finish (--timeout, default 30m)`,
    options: { ...WAIT_OPTIONS, from: { type: "string" }, force: { type: "boolean" }, "use-credits": { type: "boolean" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const from = (str(ctx.opts.from) ?? "script") as Step;
      if (!STORYBOARD_STEPS.includes(from)) throw new UsageError(`--from must be one of ${STORYBOARD_STEPS.join(", ")}`);
      if (from === "script" && !ctx.opts.force) {
        const { scenes } = await ctx.client().getProject(id);
        if (scenes.length) {
          throw new UsageError(`This project already has ${scenes.length} scenes. Rebuilding the script replaces them — ` +
            "pass --force, or use --from keyframes|narration|preview.");
        }
      }
      const job = await buildStoryboard(ctx.client(), id, from, !!ctx.opts["use-credits"]);
      return maybeWait(ctx, id, { data: { job }, text: `Queued ${fmt.formatJob(job)}` });
    },
  },

  run: {
    usage: "d2v run <project> <step> [--then step,step] [--wait]",
    summary: `Run one pipeline step (${STEPS.join(", ")})`,
    options: { ...WAIT_OPTIONS, then: { type: "string" }, "use-credits": { type: "boolean" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const step = need(ctx.args[1], "step") as Step;
      const then = (str(ctx.opts.then) ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Step[];
      for (const s of [step, ...then]) if (!STEPS.includes(s)) throw new UsageError(`Unknown step "${s}". Steps: ${STEPS.join(", ")}`);
      const job = await ctx.client().runStep(id, step, then, !!ctx.opts["use-credits"]);
      return maybeWait(ctx, id, { data: { job }, text: `Queued ${fmt.formatJob(job)}` });
    },
  },

  wait: {
    usage: "d2v wait <project> [--timeout 30m]",
    summary: "Wait until the project's jobs finish",
    options: { timeout: { type: "string" } },
    async run(ctx) {
      return waitOutput(ctx, await ctx.project(ctx.args[0]));
    },
  },

  scenes: {
    usage: "d2v scenes <project> [--full]",
    summary: "List scenes with narration",
    options: { full: { type: "boolean" } },
    async run(ctx) {
      const scenes = await ctx.client().scenes(await ctx.project(ctx.args[0]));
      return { data: { scenes }, text: scenes.map((s) => fmt.formatScene(s, { full: !!ctx.opts.full })).join("\n") || "No scenes yet." };
    },
  },

  scene: {
    usage: "d2v scene <project> <n> [--title T] [--narration TEXT] [--engine MODE] [--approve|--unapprove] [--photo FILE|none] [--photo-treatment original|restyle]",
    summary: "Edit one scene",
    help: `  --engine MODE            still | kenburns | runway | veo3
  --narration TEXT         replace the narration text (then: d2v narration <p> <n> to re-voice)
  --photo FILE             feature a photo (a project photo's filename, or a local file to upload)
  --photo none             go back to an AI-generated visual
  --photo-treatment MODE   original (photo as-is) | restyle (AI-enhanced)
  --no-regen               don't regenerate the keyframe after a photo change`,
    options: {
      title: { type: "string" },
      narration: { type: "string" },
      engine: { type: "string" },
      approve: { type: "boolean" },
      unapprove: { type: "boolean" },
      photo: { type: "string" },
      "photo-treatment": { type: "string" },
      "no-regen": { type: "boolean" },
    },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const n = sceneNumber(ctx.args[1]);
      const client = ctx.client();
      const patch: ScenePatch = {};
      const o = ctx.opts;

      if (str(o.title)) patch.title = str(o.title);
      if (str(o.narration)) patch.narration_text = str(o.narration);
      if (str(o.engine)) {
        if (!VISUAL_MODES.includes(str(o.engine) as VisualMode)) throw new UsageError(`--engine must be one of ${VISUAL_MODES.join(", ")}`);
        patch.visual_mode = str(o.engine) as VisualMode;
      }
      if (o.approve) patch.approved = true;
      if (o.unapprove) patch.approved = false;

      const treatment = str(o["photo-treatment"]) as "original" | "restyle" | undefined;
      if (treatment && !["original", "restyle"].includes(treatment)) throw new UsageError("--photo-treatment must be original or restyle");
      const photo = await photoPatch(client, id, str(o.photo), treatment);
      if (photo !== undefined) patch.photo = photo;

      if (!Object.keys(patch).length) throw new UsageError("Nothing to change. See `d2v scene --help`.");
      const result = await client.updateScene(id, n, patch);
      const job = patch.photo !== undefined && !o["no-regen"] ? await client.regenerateKeyframe(id, n, { mode: "fresh" }) : null;
      const notes = job ? result.notes.filter((note) => !note.includes("keyframe")) : result.notes;

      const text = [fmt.formatScene(result.scene), ...notes.map((note) => `note: ${note}`), job ? `Regenerating keyframe: ${fmt.formatJob(job)}` : ""]
        .filter(Boolean)
        .join("\n");
      return { data: { ...result, job }, text };
    },
  },

  keyframe: {
    usage: "d2v keyframe <project> <n> [direction...] [--fresh] [--wait]",
    summary: "Regenerate a scene's image (edit it, or --fresh for a new one)",
    options: { ...WAIT_OPTIONS, fresh: { type: "boolean" }, direction: { type: "string" } },
    async run(ctx) {
      const [ref, sn, ...words] = ctx.args;
      const id = await ctx.project(ref);
      const direction = str(ctx.opts.direction) ?? (words.join(" ").trim() || undefined);
      const job = await ctx.client().regenerateKeyframe(id, sceneNumber(sn), {
        direction,
        mode: ctx.opts.fresh || !direction ? "fresh" : "iterate",
      });
      return maybeWait(ctx, id, { data: { job }, text: `Queued ${fmt.formatJob(job)}` });
    },
  },

  narration: {
    usage: "d2v narration <project> <n> [--text TEXT | --prompt DIRECTION] [--no-audio] [--wait]",
    summary: "Change a scene's narration and regenerate its voice-over",
    help: `  --text TEXT        exact words to say
  --prompt TEXT      have AI rewrite the narration (e.g. "shorter, more urgent")
  (neither)          re-voice the current text
  --no-audio         save text only, don't regenerate audio`,
    options: { ...WAIT_OPTIONS, text: { type: "string" }, prompt: { type: "string" }, "no-audio": { type: "boolean" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const result = await ctx.client().narration(id, sceneNumber(ctx.args[1]), {
        text: str(ctx.opts.text),
        prompt: str(ctx.opts.prompt),
        audio: !ctx.opts["no-audio"],
      });
      const text = `“${result.narration_text}”${result.job ? `\nQueued ${fmt.formatJob(result.job)}` : ""}`;
      return result.job ? maybeWait(ctx, id, { data: result, text }) : { data: result, text };
    },
  },

  clip: {
    usage: "d2v clip <project> <n> [--engine runway|veo3|kenburns|still] [--use-credits]",
    summary: "Retry a scene's AI video clip (optionally on another engine)",
    help: `  --engine MODE  runway | veo3 for a new AI clip; kenburns | still drop the clip
  --use-credits  pay from credits if the purchase doesn't cover this clip (a pricier engine,
                 or a new take of a working clip); a failed clip's retry is free
  --max-credits  with --use-credits, the most to charge in dollars (e.g. 1.44)`,
    options: { engine: { type: "string" }, "use-credits": { type: "boolean" }, "max-credits": { type: "string" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const result = await ctx.client().retryClip(
        id,
        sceneNumber(ctx.args[1]),
        str(ctx.opts.engine),
        !!ctx.opts["use-credits"],
        maxCredits(ctx.opts["max-credits"]),
      );
      return { data: result, text: result.job ? `Queued ${fmt.formatJob(result.job)}` : `Scene now uses ${result.engine} (no clip needed).` };
    },
  },

  pull: {
    usage: "d2v pull <project> [--out DIR]",
    summary: "Download keyframes + storyboard.md for review",
    options: { out: { type: "string", short: "o" } },
    async run(ctx) {
      const result = await pullStoryboard(ctx.client(), await ctx.project(ctx.args[0]), str(ctx.opts.out));
      const text = [`Saved ${result.images.length} keyframe(s) and storyboard.md to ${result.dir}`, ...result.failures.map((f) => `  ✗ ${f}`)].join("\n");
      return { data: result, text };
    },
  },

  estimate: {
    usage: "d2v estimate <project>",
    summary: "Price to unlock clips, final assembly and download",
    async run(ctx) {
      const est = await ctx.client().estimate(await ctx.project(ctx.args[0]));
      return { data: est, text: fmt.formatEstimate(est) };
    },
  },

  credits: {
    usage: "d2v credits | d2v credits add <5|10|25> [--open]",
    summary: "Show your credit balance, or add credits (you pay in the browser)",
    help: `Credits pay for storyboards beyond the daily free ones ($0.50 each, with --use-credits)
and can unlock finished videos (d2v buy <p> --credits).`,
    options: { open: { type: "boolean" } },
    async run(ctx) {
      if (ctx.args[0] === "add") {
        const dollarsWanted = Number(need(ctx.args[1], "amount: 5, 10 or 25"));
        const result = await ctx.client().creditCheckout(Math.round(dollarsWanted * 100));
        if (ctx.opts.open) openUrl(result.checkout_url);
        return {
          data: result,
          text: `Add ${fmt.dollars(result.amount_cents)} of credits: ${result.checkout_url}${ctx.opts.open ? "\nOpened in your browser." : ""}`,
        };
      }
      if (ctx.args[0]) throw new UsageError(`Unknown credits command "${ctx.args[0]}". Use \`d2v credits\` or \`d2v credits add 5\`.`);
      const summary = await ctx.client().credits();
      return { data: summary, text: fmt.formatCredits(summary) };
    },
  },

  buy: {
    usage: "d2v buy <project> [--open] [--credits]",
    summary: "Unlock a project: Stripe checkout link (you pay in the browser), or --credits to pay from your balance",
    options: { open: { type: "boolean" }, credits: { type: "boolean" } },
    async run(ctx) {
      if (ctx.opts.credits) {
        const result = await ctx.client().unlockWithCredits(await ctx.project(ctx.args[0]));
        return {
          data: result,
          text: `Unlocked for ${fmt.dollars(result.amount_cents)} in credits (balance now ${fmt.dollars(result.balance_cents)}). Next: d2v produce <p> --wait`,
        };
      }
      const result = await ctx.client().checkout(await ctx.project(ctx.args[0]));
      if (ctx.opts.open) openUrl(result.checkout_url);
      return { data: result, text: `Checkout (${fmt.dollars(result.amount_cents)}): ${result.checkout_url}${ctx.opts.open ? "\nOpened in your browser." : ""}` };
    },
  },

  redeem: {
    usage: "d2v redeem <project> <code>",
    summary: "Unlock a project with a promo code",
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const result = await ctx.client().redeem(id, need(ctx.args[1], "promo code"));
      return { data: result, text: `Code redeemed — project unlocked. Next: d2v produce ${short(id)} --wait` };
    },
  },

  produce: {
    usage: "d2v produce <project> [--use-credits] [--wait]",
    summary: "Generate AI clips and assemble the final video (requires purchase)",
    help: `  --use-credits  pay from credits for clips the purchase doesn't cover (a pricier engine
                 chosen after buying, or a new take of a clip). Run once without it to see the
                 amount; --max-credits 1.15 caps the charge at what you saw
  --wait, -w     wait for it to finish (--timeout, default 30m)`,
    options: { ...WAIT_OPTIONS, "use-credits": { type: "boolean" }, "max-credits": { type: "string" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      const job = await produce(ctx.client(), id, !!ctx.opts["use-credits"], maxCredits(ctx.opts["max-credits"]));
      return maybeWait(ctx, id, { data: { job }, text: `Queued ${fmt.formatJob(job)}` });
    },
  },

  download: {
    usage: "d2v download <project> [--out FILE.mp4]",
    summary: "Download the final video",
    options: { out: { type: "string", short: "o" } },
    async run(ctx) {
      const result = await downloadVideo(ctx.client(), await ctx.project(ctx.args[0]), str(ctx.opts.out));
      return { data: result, text: `Saved ${result.path}` };
    },
  },

  delete: {
    usage: "d2v delete <project> --yes",
    summary: "Delete a project (not allowed for paid projects)",
    options: { yes: { type: "boolean" } },
    async run(ctx) {
      const id = await ctx.project(ctx.args[0]);
      if (!ctx.opts.yes) throw new UsageError("This permanently deletes the project and its storyboard. Pass --yes to confirm.");
      await ctx.client().deleteProject(id);
      return { data: { deleted: id }, text: `Deleted ${id}.` };
    },
  },

  mcp: {
    usage: "d2v mcp",
    summary: "Run as an MCP server over stdio (for Claude Desktop/Code, Codex, ChatGPT…)",
    async run({ opts }) {
      const { startMcpServer } = await import("./mcp.js");
      await startMcpServer(resolveConfig({ key: str(opts.key), url: str(opts.url) }));
      return { data: null, text: "" };
    },
  },

  guide: {
    usage: "d2v guide",
    summary: "How to drive doc2video (for people and AI agents)",
    async run() {
      return { data: { guide: AGENT_GUIDE }, text: AGENT_GUIDE };
    },
  },
};

const ALIASES: Record<string, string> = { ls: "projects", list: "projects", status: "show", rm: "delete", new: "create", storyboard: "build" };

function mainHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return `d2v ${CLI_VERSION} — doc2video from the command line

Usage: d2v <command> [args] [--json]

Commands:
${rows.join("\n")}

Global options:
  --json         machine-readable output on stdout
  --key KEY      API key (or DOC2VIDEO_API_KEY, or \`d2v login\`)
  --url URL      server (default https://doc2video.io, or DOC2VIDEO_URL)

Start here: d2v guide`;
}

function commandHelp(cmd: Command): string {
  return [`Usage: ${cmd.usage}`, "", cmd.summary, cmd.help ? `\n${cmd.help}` : ""].join("\n").trimEnd();
}

// ── Entry ────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    const target = first === "help" && rest[0] ? COMMANDS[ALIASES[rest[0]] ?? rest[0]] : undefined;
    console.log(target ? commandHelp(target) : mainHelp());
    return 0;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    console.log(CLI_VERSION);
    return 0;
  }

  const name = ALIASES[first] ?? first;
  const command = COMMANDS[name];
  const json = argv.includes("--json");

  try {
    if (!command) throw new UsageError(`Unknown command "${first}". Run \`d2v help\`.`);

    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...command.options }, allowPositionals: true, strict: true });
    } catch (err) {
      throw new UsageError(`${(err as Error).message}\n\n${commandHelp(command)}`);
    }
    const opts = parsed.values as Values;
    if (opts.help) {
      console.log(commandHelp(command));
      return 0;
    }

    let client: Doc2VideoClient | null = null;
    const getClient = () => {
      if (!client) {
        const cfg = resolveConfig({ key: str(opts.key), url: str(opts.url) });
        client = new Doc2VideoClient(cfg.baseUrl, cfg.apiKey);
      }
      return client;
    };

    const output = await command.run({
      args: parsed.positionals,
      opts,
      client: getClient,
      project: (ref) => resolveProjectId(getClient(), need(ref, "project (id, id prefix, or name)")),
    });

    if (name !== "mcp") {
      if (json) console.log(JSON.stringify(output.data, null, 2));
      else if (output.text) console.log(output.text);
    }
    return output.exitCode ?? 0;
  } catch (err) {
    const isUsage = err instanceof UsageError;
    const apiErr = err instanceof ApiRequestError ? err : null;
    const exitCode = isUsage ? 2 : apiErr?.status === 402 ? 3 : apiErr?.status === 429 ? 5 : 1;
    let message = (err as Error).message;
    if (apiErr?.code === "credits_confirm_required") {
      const cost = typeof apiErr.details.cost_cents === "number" ? apiErr.details.cost_cents : null;
      message += cost === null || apiErr.details.reason !== "clips"
        ? "\nRerun with --use-credits to pay for it from your credits."
        : `\nRerun with --use-credits --max-credits ${(cost / 100).toFixed(2)} to pay for it from your credits.`;
    } else if (apiErr?.code === "credits_required") {
      message += "\nAdd credits with `d2v credits add 5 --open`, or try again tomorrow.";
    } else if (apiErr?.status === 402) {
      message += "\nUnlock the project first: `d2v estimate <p>`, then `d2v buy <p> --open` (or `--credits`), or `d2v redeem <p> CODE`.";
    }

    if (json) {
      console.log(JSON.stringify({ error: { code: isUsage ? "usage" : apiErr?.code ?? "error", status: apiErr?.status, message } }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    if (!isUsage && !apiErr) console.error((err as Error).stack);
    return exitCode;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
