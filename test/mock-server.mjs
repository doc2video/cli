// In-memory stand-in for the doc2video v1 API, with a simulated worker.
// Each poll of the jobs list advances the oldest unfinished job one state
// (queued → running → completed). A completed job's `then` chain is queued
// one poll later, reproducing the real worker's brief gap between steps.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export const TEST_KEY = "d2v_test_key";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function startMockServer() {
  // devices: device_code -> { userCode, clientName, decision: null | "approved" | "denied", consumed }
  // creditsMode: null (storyboards free) | "confirm" (needs use_credits) | "required" (balance too low)
  const state = { projects: new Map(), uploads: new Map(), requests: [], devices: new Map(), balanceCents: 0, creditsMode: null };
  /** Play the browser: approve or deny the device login with this user code. */
  state.decideDevice = (userCode, decision) => {
    for (const d of state.devices.values()) if (d.userCode === userCode) d.decision = decision;
  };
  let base = "";

  const now = () => new Date().toISOString();
  // Like the server: consent covers the amount quoted (max_credits_cents), if one is given
  const clipsConsented = (body) =>
    body.use_credits && (body.max_credits_cents === undefined || body.max_credits_cents >= state.clipsExtraCents);
  const clipsExtraDetails = () => ({ reason: "clips", cost_cents: state.clipsExtraCents, balance_cents: state.balanceCents });
  const clipsExtraMessage = () =>
    `These clips cost $${(state.clipsExtraCents / 100).toFixed(2)} more than your purchase covers. ` +
    `Pay $${(state.clipsExtraCents / 100).toFixed(2)} from your credits (balance $${(state.balanceCents / 100).toFixed(2)})?`;

  function job(projectId, step, then = []) {
    return { id: randomUUID(), project_id: projectId, step, status: "queued", progress_pct: 0, error_message: null,
      scene_number: null, then, created_at: now(), started_at: null, completed_at: null, pendingChain: null };
  }

  function detail(p) {
    const preview = p.previewReady ? { id: "v1", kind: "preview", file_size_bytes: 1, resolution: "1080p", created_at: now(), url: `${base}/files/preview.mp4` } : null;
    return {
      id: p.id, name: p.name, client_name: null, status: p.status, aspect_ratio: p.aspect_ratio,
      target_duration_seconds: p.target_duration_seconds, scene_count: p.scenes.length, url: `${base}/projects/${p.id}`,
      created_at: p.created_at, updated_at: now(),
      settings: { creative_direction: p.creative_direction ?? null, storytelling_mode: true, photo_treatment: "original",
        voice_id: null, voice_name: null, voice_stability: null, contact: { email: null, phone: null, website: null } },
      purchased: p.purchased,
      estimated_cost: p.scenes.length ? { amount_cents: 299, subtotal_cents: 165, minimum_cents: 299, scene_count: p.scenes.length, breakdown: [] } : null,
      documents: p.documents, scenes: p.scenes,
      active_jobs: p.jobs.filter((j) => j.status === "queued" || j.status === "running"),
      recent_jobs: [...p.jobs].reverse().slice(0, 10),
      videos: { preview, final: null },
      next_steps: [],
    };
  }

  function tick(p) {
    // Queue chains that completed on a previous tick
    for (const j of p.jobs) {
      if (j.pendingChain) {
        const [next, ...rest] = j.pendingChain;
        j.pendingChain = null;
        p.jobs.push(job(p.id, next, rest));
        return;
      }
    }
    const current = p.jobs.find((j) => j.status === "queued" || j.status === "running");
    if (!current) return;
    if (current.status === "queued") {
      Object.assign(current, { status: "running", progress_pct: 50, started_at: now() });
      return;
    }
    Object.assign(current, { status: "completed", progress_pct: 100, completed_at: now() });
    if (current.step === "script") {
      p.scenes = [1, 2, 3].map((n) => ({
        id: randomUUID(), scene_number: n, title: `Scene ${n}`, status: "pending", approved: false, duration_seconds: 10,
        narration_text: `Narration ${n}`, visual_prompt: `Visual ${n}`, visual_mode: "kenburns", ai_visual_mode: "kenburns",
        photo: null, keyframe_url: null, narration_audio_url: null, has_clip: false, clip_failure: null, updated_at: now(),
      }));
      p.status = "reviewing";
    }
    if (current.step === "keyframes") for (const s of p.scenes) { s.keyframe_url = `${base}/files/kf_${s.scene_number}.png`; s.status = "ready"; }
    if (current.step === "preview") p.previewReady = true;
    if (current.then.length) current.pendingChain = current.then;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw.length && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : null });

    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    const fail = (status, code, message, details = {}) => send(status, { error: { code, message, ...details } });

    if (url.pathname.startsWith("/upload/")) {
      state.uploads.set(decodeURIComponent(url.pathname.slice(8)), raw.length);
      return send(200, "", "text/plain");
    }
    if (url.pathname.startsWith("/files/")) return send(200, PNG, "image/png");
    if (!url.pathname.startsWith("/api/v1")) return send(404, "not found", "text/plain");
    // Device login (no auth)
    if (req.method === "POST" && url.pathname === "/api/v1/auth/device") {
      const body = state.requests.at(-1).body ?? {};
      const deviceCode = `dev_${randomUUID()}`;
      const userCode = `BKTW-${String(state.devices.size).padStart(4, "Q")}`;
      state.devices.set(deviceCode, { userCode, clientName: body.client_name, decision: null, consumed: false });
      return send(201, { device_code: deviceCode, user_code: userCode, verification_uri: `${base}/connect`,
        verification_uri_complete: `${base}/connect?code=${userCode}`, expires_in: 600, interval: 0.05 });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/auth/device/token") {
      const d = state.devices.get((state.requests.at(-1).body ?? {}).device_code);
      if (!d) return fail(400, "invalid_device_code", "Unknown login request.");
      if (d.decision === "denied") return fail(403, "access_denied", "The login request was denied in the browser.");
      if (d.consumed) return fail(400, "already_used", "This login was already completed.");
      if (d.decision !== "approved") return fail(400, "authorization_pending", "Waiting for approval in the browser.");
      d.consumed = true;
      return send(200, { api_key: TEST_KEY, key_name: d.clientName, email: "test@example.com" });
    }

    if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return fail(401, "invalid_api_key", "bad key");

    const body = state.requests.at(-1).body ?? {};
    const parts = url.pathname.slice("/api/v1".length).split("/").filter(Boolean);
    const p = parts[0] === "projects" && parts[1] ? state.projects.get(parts[1]) : null;
    if (parts[0] === "projects" && parts[1] && !p) return fail(404, "not_found", "Project not found");

    const route = `${req.method} /${parts.map((x, i) => (i === 1 && p ? ":id" : x)).join("/")}`;
    switch (true) {
      case route === "GET /me":
        return send(200, { id: "u1", email: "test@example.com", is_superuser: false, auth: "api_key" });
      case route === "GET /projects":
        return send(200, { projects: [...state.projects.values()].map(detail) });
      case route === "POST /projects": {
        const id = randomUUID();
        const project = { id, name: body.name, status: "draft", aspect_ratio: body.aspect_ratio ?? "9:16",
          target_duration_seconds: body.target_duration_seconds ?? 0, creative_direction: body.creative_direction,
          created_at: now(), documents: [], scenes: [], jobs: [], purchased: false, previewReady: false };
        state.projects.set(id, project);
        return send(201, detail(project));
      }
      case route === "GET /projects/:id":
        return send(200, detail(p));
      case route === "POST /projects/:id/documents/upload-url":
        return send(200, { upload_url: `${base}/upload/${encodeURIComponent(body.filename)}`, storage_path: `uploads/u1/${p.id}/${body.filename}`,
          content_type: body.content_type, expires_in_seconds: 3600, method: "PUT" });
      case route === "POST /projects/:id/documents": {
        const kind = body.content ? "text" : body.content_type.startsWith("image/") ? "photo" : "document";
        const doc = { id: randomUUID(), filename: body.filename ?? "Written Content", kind, source_type: body.content ? "text" : "upload",
          mime_type: body.content_type ?? "text/plain", file_size_bytes: body.size_bytes ?? 0, created_at: now() };
        p.documents.push(doc);
        return send(201, { document: doc });
      }
      case route === "GET /projects/:id/jobs": {
        tick(p);
        let jobs = [...p.jobs].reverse();
        if (url.searchParams.get("active") === "true") jobs = jobs.filter((j) => j.status === "queued" || j.status === "running");
        return send(200, { jobs: jobs.map(({ pendingChain, ...j }) => j) });
      }
      case route === "POST /projects/:id/jobs": {
        if (["clips", "assemble"].includes(body.step) && !p.purchased) return fail(402, "payment_required", "Payment required before generating clips or assembling the final video.");
        if (body.step === "script" && state.freeLimitReached) return fail(429, "free_daily_limit", "You've used today's free storyboards (2 per day).");
        if (body.step === "script" && state.creditsMode === "required") {
          return fail(402, "credits_required", `Another storyboard costs $0.50 in credits and your balance is $${(state.balanceCents / 100).toFixed(2)}.`);
        }
        if (body.step === "script" && state.creditsMode === "confirm") {
          if (!body.use_credits) return fail(402, "credits_confirm_required", "This one costs $0.50 from your credits. Confirm to continue.");
          state.balanceCents -= 50;
        }
        // clipsExtraCents: clips cost this much beyond what the purchase covers
        if (body.step === "clips" && state.clipsExtraCents) {
          if (!clipsConsented(body)) return fail(402, "credits_confirm_required", clipsExtraMessage(), clipsExtraDetails());
          state.balanceCents -= state.clipsExtraCents;
        }
        const j = job(p.id, body.step, body.then ?? []);
        p.jobs.push(j);
        return send(201, { job: j });
      }
      case route.startsWith("PATCH /projects/:id/scenes/"): {
        const s = p.scenes.find((x) => x.scene_number === Number(parts[3]));
        if (body.photo) s.photo = { document_id: body.photo.document_id ?? "doc", filename: body.photo.filename ?? "uploaded.png", treatment: body.photo.treatment ?? "original" };
        if (body.visual_mode) s.visual_mode = body.visual_mode;
        return send(200, { scene: s, notes: body.photo ? ["Regenerate this scene's keyframe (POST .../keyframe) to apply the photo change."] : [] });
      }
      case route.endsWith("/clip") && req.method === "POST": {
        if (!p.purchased) return fail(402, "payment_required", "Payment required before generating clips or assembling the final video.");
        if (state.clipsExtraCents) {
          if (!clipsConsented(body)) return fail(402, "credits_confirm_required", clipsExtraMessage(), clipsExtraDetails());
          state.balanceCents -= state.clipsExtraCents;
        }
        const j = job(p.id, "clips");
        j.scene_number = Number(parts[3]);
        p.jobs.push(j);
        return send(200, { action: "queued", engine: body.engine ?? "veo3", job: j });
      }
      case route.endsWith("/keyframe") && req.method === "POST": {
        const j = job(p.id, "regen_keyframe");
        j.scene_number = Number(parts[3]);
        p.jobs.push(j);
        return send(201, { job: j });
      }
      case route === "GET /credits":
        return send(200, { balance_cents: state.balanceCents, storyboard_price_cents: 50, free_storyboards: { used_today: 2, per_day: 2 },
          top_up_amounts_cents: [500, 1000, 2500], add_credits_url: `${base}/dashboard#credits`,
          recent: [{ amount_cents: 1000, kind: "topup", project_id: null, description: "Added $10.00", created_at: now() }] });
      case route === "POST /credits/checkout":
        if (![500, 1000, 2500].includes(body.amount_cents)) return fail(400, "invalid_request", "Choose one of: $5.00, $10.00, $25.00");
        return send(200, { checkout_url: `${base}/stripe/checkout/${body.amount_cents}`, amount_cents: body.amount_cents });
      case route === "POST /projects/:id/unlock-with-credits":
        if (state.balanceCents < 299) return fail(402, "credits_required", "Unlocking this project costs $2.99 in credits.");
        state.balanceCents -= 299;
        p.purchased = true;
        return send(200, { unlocked: true, amount_cents: 299, balance_cents: state.balanceCents });
      case route === "GET /projects/:id/estimate":
        return send(200, { purchased: p.purchased, amount_cents: 299, subtotal_cents: 165, minimum_cents: 299, scene_count: 3, breakdown: [] });
      default:
        return fail(404, "not_found", `mock has no route ${route}`);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
