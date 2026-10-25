import type { CostEstimate, CreditsSummary, JobInfo, ProjectDetail, ProjectSummary, SceneInfo, Voice } from "./types.js";

export const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

export function duration(seconds: number | null | undefined): string {
  if (!seconds) return "auto";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

export function formatJob(job: JobInfo): string {
  const scene = job.scene_number ? ` scene ${job.scene_number}` : "";
  const progress = job.status === "running" ? ` ${job.progress_pct}%` : "";
  const then = job.then.length ? ` → ${job.then.join(" → ")}` : "";
  const error = job.error_message ? `\n      ${job.error_message}` : "";
  return `${job.step}${scene}: ${job.status}${progress}${then}${error}`;
}

export function formatProjectList(projects: ProjectSummary[]): string {
  if (!projects.length) return "No projects yet. Create one with `d2v create \"Name\" ./folder`.";
  const rows = projects.map(
    (p) => `${p.id.slice(0, 8)}  ${pad(p.status, 10)}  ${pad(`${p.aspect_ratio} ${duration(p.target_duration_seconds)}`, 11)}  ${p.name}`,
  );
  return [`id        ${pad("status", 10)}  ${pad("format", 11)}  name`, ...rows].join("\n");
}

export function formatScene(scene: SceneInfo, opts: { full?: boolean } = {}): string {
  const photo = scene.photo ? `photo ${scene.photo.filename ?? "?"} (${scene.photo.treatment})` : "AI visual";
  const status = `${scene.status}${scene.approved ? ", approved" : ""}`;
  const head = `${String(scene.scene_number).padStart(2)}. ${scene.title}  [${status} · ${scene.visual_mode} · ${photo} · ${scene.duration_seconds ?? "?"}s]`;
  const narration = scene.narration_text ? (opts.full ? scene.narration_text : truncate(scene.narration_text, 110)) : "(no narration)";
  const lines = [head, `    “${narration}”`];
  if (opts.full && scene.visual_prompt) lines.push(`    visual: ${scene.visual_prompt}`);
  if (opts.full && scene.keyframe_url) lines.push(`    keyframe: ${scene.keyframe_url}`);
  if (scene.clip_failure) lines.push(`    clip failed (${scene.clip_failure.engine ?? "?"}): ${scene.clip_failure.reason}`);
  return lines.join("\n");
}

export function formatEstimate(est: CostEstimate & { purchased?: boolean; covered_cents?: number | null }): string {
  const label = (b: CostEstimate["breakdown"][number]) => (b.photo ? `${b.visual_mode} (your photo)` : b.visual_mode);
  const width = Math.max(9, ...est.breakdown.map((b) => label(b).length));
  const lines = est.breakdown.map((b) => `  ${pad(label(b), width)} ${b.scenes} × ${dollars(b.unit_cents)} = ${dollars(b.subtotal_cents)}`);
  if (est.subtotal_cents < est.minimum_cents) lines.push(`  (minimum charge ${dollars(est.minimum_cents)} — covers AI script, narration and assembly)`);
  lines.push(`  ${pad("total", width)} ${dollars(est.amount_cents)}${est.purchased ? "  — already purchased" : ""}`);
  if (est.purchased && est.covered_cents != null) {
    lines.push(`  Your purchase covers ${dollars(est.covered_cents)}; AI clips beyond that are paid from credits (with --use-credits).`);
  }
  return lines.join("\n");
}

export function formatProject(p: ProjectDetail): string {
  const s = p.settings;
  const counts = { document: 0, photo: 0, text: 0 };
  for (const d of p.documents) counts[d.kind]++;

  const lines = [
    `${p.name}${p.client_name ? ` — ${p.client_name}` : ""}  (${p.id})`,
    `  ${p.status} · ${p.aspect_ratio} · ${duration(p.target_duration_seconds)} · ${p.scenes.length} scenes · ${p.url}`,
    `  voice ${s.voice_name ?? "Rachel (default)"} · photos ${s.photo_treatment} · consistency ${s.storytelling_mode ? "on" : "off"}` +
      ` · ${p.purchased ? "purchased" : p.estimated_cost ? `unpaid (${dollars(p.estimated_cost.amount_cents)})` : "unpaid"}`,
    `  sources: ${counts.document} documents, ${counts.photo} photos, ${counts.text} written`,
  ];
  if (s.creative_direction) lines.push(`  direction: ${truncate(s.creative_direction, 160)}`);

  if (p.active_jobs.length) {
    lines.push("", "Running:");
    for (const j of p.active_jobs) lines.push(`  ${formatJob(j)}`);
  } else if (p.recent_jobs[0]?.status === "failed") {
    lines.push("", `Last job failed: ${formatJob(p.recent_jobs[0])}`);
  }

  if (p.scenes.length) {
    lines.push("", "Storyboard:");
    for (const scene of p.scenes) lines.push(formatScene(scene));
  }

  if (p.videos.preview?.url) lines.push("", `Preview: ${p.videos.preview.url}`);
  if (p.videos.final) lines.push(`Final video ready — \`d2v download ${p.id.slice(0, 8)}\``);

  if (p.next_steps.length) {
    lines.push("", "Next:");
    for (const n of p.next_steps) lines.push(`  • ${n.description}`);
  }
  return lines.join("\n");
}

export function formatCredits(c: CreditsSummary): string {
  const freeLeft = Math.max(c.free_storyboards.per_day - c.free_storyboards.used_today, 0);
  const lines = [
    `Balance: ${dollars(c.balance_cents)}`,
    `Free storyboards left today: ${freeLeft} of ${c.free_storyboards.per_day} (then ${dollars(c.storyboard_price_cents)} each from credits)`,
    `Add credits: d2v credits add ${c.top_up_amounts_cents.map((a) => a / 100).join("|")} --open`,
  ];
  if (c.recent.length) {
    lines.push("", "Recent:");
    for (const r of c.recent.slice(0, 8)) {
      const amount = `${r.amount_cents > 0 ? "+" : "-"}${dollars(Math.abs(r.amount_cents))}`;
      lines.push(`  ${r.created_at.slice(0, 10)}  ${pad(amount, 8)} ${r.description ?? r.kind}`);
    }
  }
  return lines.join("\n");
}

export function formatVoices(voices: Voice[]): string {
  return voices.map((v) => `${pad(v.name, 10)} ${pad(`${v.gender}, ${v.accent}`, 22)} ${v.description}`).join("\n");
}
