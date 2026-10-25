/** Response shapes of the doc2video v1 API (see src/lib/api/serialize.ts in the app). */

export type Step = "script" | "keyframes" | "narration" | "preview" | "clips" | "assemble";
export const STEPS: Step[] = ["script", "keyframes", "narration", "preview", "clips", "assemble"];

export type VisualMode = "still" | "kenburns" | "runway" | "veo3";
export const VISUAL_MODES: VisualMode[] = ["still", "kenburns", "runway", "veo3"];

export type PhotoTreatment = "original" | "restyle";

export interface ProjectSummary {
  id: string;
  name: string;
  client_name: string | null;
  status: string;
  aspect_ratio: "16:9" | "9:16";
  target_duration_seconds: number;
  scene_count: number | null;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentInfo {
  id: string;
  filename: string;
  kind: "photo" | "document" | "text";
  source_type: string;
  mime_type: string;
  file_size_bytes: number;
  created_at: string;
}

export interface SceneInfo {
  id: string;
  scene_number: number;
  title: string;
  status: string;
  approved: boolean;
  duration_seconds: number | null;
  narration_text: string | null;
  visual_prompt: string | null;
  visual_mode: VisualMode;
  ai_visual_mode: VisualMode | null;
  photo: { document_id: string; filename: string | null; treatment: PhotoTreatment } | null;
  keyframe_url: string | null;
  narration_audio_url: string | null;
  has_clip: boolean;
  /** The engine that made the clip (runway | veo3). */
  clip_engine?: string | null;
  clip_failure: { reason: string; engine: string | null; retry_count: number } | null;
  updated_at: string;
}

export interface JobInfo {
  id: string;
  step: string;
  status: "queued" | "running" | "completed" | "failed";
  progress_pct: number;
  error_message: string | null;
  scene_number: number | null;
  then: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface VideoInfo {
  id: string;
  kind: "preview" | "final";
  file_size_bytes: number;
  resolution: string;
  created_at: string;
  url: string | null;
}

export interface CostEstimate {
  amount_cents: number;
  subtotal_cents: number;
  minimum_cents: number;
  scene_count: number;
  /** photo: true for scenes showing the user's photo as-is (no AI image charge). */
  breakdown: { visual_mode: string; photo: boolean; scenes: number; unit_cents: number; subtotal_cents: number }[];
}

export interface ProjectDetail extends ProjectSummary {
  settings: {
    creative_direction: string | null;
    storytelling_mode: boolean;
    photo_treatment: PhotoTreatment;
    voice_id: string | null;
    voice_name: string | null;
    voice_stability: number | null;
    contact: { email: string | null; phone: string | null; website: string | null };
  };
  purchased: boolean;
  estimated_cost: CostEstimate | null;
  documents: DocumentInfo[];
  scenes: SceneInfo[];
  active_jobs: JobInfo[];
  recent_jobs: JobInfo[];
  videos: { preview: VideoInfo | null; final: VideoInfo | null };
  next_steps: { action: string; description: string }[];
}

export interface CreditsSummary {
  balance_cents: number;
  storyboard_price_cents: number;
  free_storyboards: { used_today: number; per_day: number };
  top_up_amounts_cents: number[];
  add_credits_url: string;
  recent: { amount_cents: number; kind: string; project_id: string | null; description: string | null; created_at: string }[];
}

export interface Voice {
  id: string;
  name: string;
  description: string;
  gender: string;
  accent: string;
}

/** Settings accepted by POST/PATCH /projects. */
export interface ProjectSettings {
  name?: string;
  client_name?: string | null;
  target_duration_seconds?: number;
  aspect_ratio?: "16:9" | "9:16";
  creative_direction?: string | null;
  storytelling_mode?: boolean;
  photo_treatment?: PhotoTreatment;
  voice?: string;
  voice_stability?: number;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_website?: string | null;
}

export interface ScenePatch {
  title?: string;
  narration_text?: string;
  visual_mode?: VisualMode;
  approved?: boolean;
  photo?: { document_id?: string; filename?: string; treatment?: PhotoTreatment } | null;
}
