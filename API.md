# doc2video REST API (v1)

Base URL: `https://doc2video.io/api/v1`. Everything the web editor can do, minus payment entry
(checkout happens on a Stripe page in the browser).

## Authentication

Send an API key on every request:

```
Authorization: Bearer d2v_xxxxxxxxxxxxxxxx
```

Keys have full access to the account. They are stored hashed, can be revoked from the dashboard,
and can't be used to create more keys. Requests from a signed-in browser session also work.

### Getting a key: one-click device login

Tools and agents should use the device login (OAuth 2.0 device authorization, RFC 8628) instead of
asking people to copy keys. The `d2v` CLI does this for you with `d2v login`.

1. `POST /auth/device` (no auth) with `{ "client_name": "My tool on laptop" }` →
   `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`.
2. Show the user `verification_uri_complete` (e.g. `https://doc2video.io/connect?code=BKTW-QXHM`).
   They sign in or sign up, check the code, and click **Approve**.
3. Poll `POST /auth/device/token` (no auth) with `{ "device_code": "…" }` every `interval`
   seconds. While waiting it returns 400 `authorization_pending` (or `slow_down`: poll less often);
   403 `access_denied` if the user clicked Deny; 400 `expired_token` after `expires_in` seconds.
   Once approved it returns `{ api_key, key_name, email }` — exactly once.

The key is named after `client_name` and appears on the dashboard's API page. Starting a login is
rate-limited per IP.

Or create a key by hand on the dashboard's **API** page (`/dashboard/api-keys`).

## Conventions

- JSON in, JSON out. Field names match the database (`snake_case`).
- Errors: `{ "error": { "code": "payment_required", "message": "…" } }` with a matching status.
  Common codes: `unauthorized`/`invalid_api_key` (401), `invalid_request` (400, with `issues`),
  `payment_required`/`unpaid_project_limit` (402), `not_found` (404), `job_in_progress` (409),
  `unsupported_file_type` (415).
- Unknown body fields are rejected, so typos surface as 400s.
- `:scene` is a scene **number** (`3`) or a scene id.
- Generation is asynchronous. Endpoints that start work return a **job**; poll it until
  `status` is `completed` or `failed`.

## Typical flow

```bash
API=https://doc2video.io/api/v1; AUTH="Authorization: Bearer $DOC2VIDEO_API_KEY"

# 1. Create a project
curl -s -X POST $API/projects -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Open House","target_duration_seconds":60,"aspect_ratio":"9:16","creative_direction":"Warm, inviting"}'

# 2. Upload a file: get a URL, PUT the bytes, register it
curl -s -X POST $API/projects/$ID/documents/upload-url -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"filename":"garden.jpg","size_bytes":482113}'
curl -s -X PUT "$UPLOAD_URL" -H "Content-Type: image/jpeg" --data-binary @garden.jpg
curl -s -X POST $API/projects/$ID/documents -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"storage_path":"'$STORAGE_PATH'","filename":"garden.jpg","content_type":"image/jpeg","size_bytes":482113}'

# 3. Build the storyboard as one server-side chain
curl -s -X POST $API/projects/$ID/jobs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"step":"script","then":["keyframes","narration","preview"]}'

# 4. Poll until idle, then review
curl -s "$API/projects/$ID/jobs?active=true" -H "$AUTH"
curl -s $API/projects/$ID -H "$AUTH"
```

## Endpoints

### Account

| | |
|---|---|
| `GET /me` | `{ id, email, is_superuser, auth }` |
| `GET /voices` | Narrator voices: `{ voices: [{ id, name, description, gender, accent }], default_voice_id }` |

### Projects

| | |
|---|---|
| `GET /projects` | `{ projects: [summary] }`, most recently updated first |
| `POST /projects` | Create. Body: settings (below), `name` required. Returns the project detail (201). |
| `GET /projects/:id` | Project detail (below) |
| `PATCH /projects/:id` | Update settings. Returns the project detail. |
| `DELETE /projects/:id` | Delete. 409 while jobs run; 403 for paid projects. |

**Settings** (all optional on PATCH):

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `client_name` | string \| null | |
| `target_duration_seconds` | int 0–1800 | `0` = AI picks the length from the content. Default 0. |
| `aspect_ratio` | `"9:16"` \| `"16:9"` | Default `9:16` |
| `creative_direction` | string \| null | Tone, style, focus, audience |
| `storytelling_mode` | boolean | Reuse earlier keyframes for visual consistency (default true) |
| `photo_treatment` | `"original"` \| `"restyle"` | Default for scenes the AI assigns a photo to |
| `voice` | string | Voice id or name from `/voices` |
| `voice_stability` | number 0–1 | |
| `contact_email`, `contact_phone`, `contact_website` | string \| null | Used in the closing call to action |

**Project detail** = summary (`id, name, client_name, status, aspect_ratio,
target_duration_seconds, scene_count, url, created_at, updated_at`) plus:

- `settings` — creative direction, voice, photo treatment, contact info
- `purchased`, `estimated_cost`
- `documents[]` — `{ id, filename, kind: "document"|"photo"|"text", mime_type, file_size_bytes }`
- `scenes[]` — see Scenes
- `active_jobs[]`, `recent_jobs[]`
- `videos.preview` (with a public `url`), `videos.final` (download via `/download`)
- `next_steps[]` — `{ action, description }` hints for what to do next

Project `status`: `draft → scripting → reviewing ↔ generating → producing → completed`, or `failed`.

### Sources

| | |
|---|---|
| `GET /projects/:id/documents` | `{ documents }` |
| `POST /projects/:id/documents/upload-url` | `{ filename, content_type?, size_bytes? }` → `{ upload_url, storage_path, content_type, method: "PUT", expires_in_seconds }`. PUT the bytes to `upload_url` with that `Content-Type`. |
| `POST /projects/:id/documents` | Register an upload `{ storage_path, filename, content_type?, size_bytes? }`, **or** add text `{ content, filename?, replace? }`. 201 `{ document }`. |
| `DELETE /projects/:id/documents/:documentId` | Remove a source |
| `POST /projects/:id/draft` | `{ prompt, save? = true }` → `{ draft, document }`. AI-writes the source content. |
| `POST /projects/:id/creative-direction` | `{ preferences?, save? = false }` → `{ creative_direction, saved }` |

Supported uploads: documents `pdf docx pptx md txt csv json`; photos `jpg jpeg png webp heic heif`; up to
100 MB each; text content up to 200 KB. The script generator considers up to 50 photos.

### Jobs

| | |
|---|---|
| `GET /projects/:id/jobs?active=true&limit=20` | `{ jobs }`, newest first |
| `POST /projects/:id/jobs` | `{ step, then?, use_credits?, max_credits_cents? }` → 201 `{ job }` |
| `GET /projects/:id/jobs/:jobId` | `{ job }` |

Steps, in pipeline order: `script`, `keyframes`, `narration`, `preview`, `clips`, `assemble`.
`clips` and `assemble` require a purchase (402 otherwise). Only one job per step can be active (409).
`clips` makes an AI clip for every `runway`/`veo3` scene that doesn't have a working one from its
engine yet, and can't appear in `then` (start it on its own, e.g. `{ "step": "clips", "then":
["assemble"] }`), because clips beyond what the purchase covers need consent (see
[What a purchase covers](#what-a-purchase-covers)).

`then` chains steps on the server: when the job completes cleanly the worker queues the next
step with the rest of the chain. A chain stops if a step reports failures (e.g. keyframes failed
for some scenes); the job's `error_message` says which. While polling, a just-completed job whose
`then` is non-empty means the next step is about to be queued.

**Job**: `{ id, step, status: queued|running|completed|failed, progress_pct, error_message,
scene_number, then, created_at, started_at, completed_at }`. A `completed` job can still carry an
`error_message` for partial failures.

### Scenes

| | |
|---|---|
| `GET /projects/:id/scenes` | `{ scenes }` |
| `GET /projects/:id/scenes/:scene` | `{ scene, notes }` |
| `PATCH /projects/:id/scenes/:scene` | `{ title?, narration_text?, visual_mode?, approved?, photo? }` → `{ scene, notes }` |
| `POST /projects/:id/scenes/:scene/keyframe` | `{ direction?, mode?: "iterate"\|"fresh" }` → 201 `{ job }` |
| `POST /projects/:id/scenes/:scene/narration` | `{ text? \| prompt?, audio? = true }` → `{ narration_text, job }` |
| `POST /projects/:id/scenes/:scene/clip` | `{ engine?, use_credits?, max_credits_cents? }` → `{ action, engine, job }` |

- `visual_mode`: `still`, `kenburns` (pan/zoom), `runway` (AI video), `veo3` (best AI video).
- `photo`: `{ document_id | filename, treatment? }` features a project photo; `{ treatment }`
  changes how the current photo is treated; `null` returns to an AI-generated visual. Then
  regenerate the keyframe with `{ "mode": "fresh" }`.
- Keyframe `iterate` edits the current image and needs a `direction`; `fresh` makes a new one
  from the scene description plus the direction. Any direction on a photo used as-is switches
  that scene to `restyle` (AI has now worked on it, so it's priced like an AI image).
- Narration: `text` saves exact words, `prompt` has AI rewrite them; either way TTS cleanup is
  applied and, unless `audio: false`, the voice-over is regenerated. An empty body re-voices the
  current text.
- `notes` lists follow-ups, e.g. that narration audio is now out of date.
- `clip` makes a new AI clip for one scene: a retry after a failure (free), or a new take or a
  different engine (`runway`/`veo3`), which may cost credits. `engine: "still"|"kenburns"` drops
  the clip instead.

**Scene**: `{ id, scene_number, title, status, approved, duration_seconds, narration_text,
visual_prompt, visual_mode, ai_visual_mode, photo: { document_id, filename, treatment } | null,
keyframe_url, narration_audio_url, has_clip, clip_engine, clip_failure, updated_at }`.
`clip_engine` is the engine that made the current clip.

Scene edits affect only that scene; run `preview` again to see them in the video.

### Billing and output

| | |
|---|---|
| `GET /projects/:id/estimate` | `{ purchased, amount_cents, subtotal_cents, minimum_cents, scene_count, breakdown[], covered_cents }` — `covered_cents`: what the purchase covers (null until bought) |
| `POST /projects/:id/checkout` | `{ checkout_url, amount_cents }` — open in a browser to pay |
| `POST /projects/:id/redeem` | `{ code }` → `{ redeemed: true }` |
| `POST /projects/:id/unlock-with-credits` | → `{ unlocked: true, amount_cents, balance_cents }` — pay the project's price from credits |
| `GET /projects/:id/download` | `{ download_url, video_id, filename, expires_in_seconds }` — latest final video, requires purchase |

### Credits

Prepaid credits pay for storyboards beyond the daily free ones ($0.50 each) and can unlock
finished projects, with no checkout in between. People top up in the browser.

| | |
|---|---|
| `GET /credits` | `{ balance_cents, storyboard_price_cents, free_storyboards: { used_today, per_day }, top_up_amounts_cents, add_credits_url, recent[] }` |
| `POST /credits/checkout` | `{ amount_cents: 500 \| 1000 \| 2500 }` → `{ checkout_url, amount_cents }` — the user pays in the browser |

Spending always needs explicit consent. When today's free storyboards are used up, starting a
`script` step returns:

- 402 `credits_confirm_required` (with `cost_cents`, `balance_cents`) if the balance covers it —
  ask the user, then repeat the request with `"use_credits": true`; or
- 402 `credits_required` (with `add_credits_url`) if it doesn't.

A storyboard paid with credits that fails is refunded automatically.

### What a purchase covers

A purchase (Stripe, credits or a promo code) covers the project at the price it was bought for.
Each AI clip uses part of that. Producing the project as it was priced is covered, and so is
choosing a cheaper AI engine for a scene before its clip is made (that leaves room for others).
Making the rest of a scene cheaper after buying (e.g. swapping its AI image for your photo) doesn't
free room for clips. Two things cost extra, paid from credits:

- the project now costs more than the purchase covers (pricier engines, or more AI scenes, chosen
  after buying): the difference;
- a new clip for a scene that already has a working one (a new take, or another engine): that
  clip's price ($0.30 runway, $1.44 veo3), less any room the purchase still has.

Starting `clips` (or a scene's `clip`) then returns 402 `credits_confirm_required` with
`cost_cents`, `balance_cents`, `covered_cents` and the `clips` it would make. Ask the user, then
repeat with `"use_credits": true, "max_credits_cents": <cost_cents>`: if the price has changed
meanwhile you're asked again instead of charged. (`use_credits` alone accepts whatever it costs
at that moment.) `credits_required` means the balance is too low. A clip that fails gives its
share back, so retrying it is free.

`clips` with nothing to make (every AI scene has its clip) returns 409 `nothing_to_make`, unless
it has a `then` chain (e.g. `assemble`), which then runs. Rebuilding the storyboard starts its
scenes without clips; their clips are new AI work.

### Refunds

Refunds are issued in Stripe; doc2video applies them automatically:

- A refunded credit top-up is deducted from the balance (partial refunds deduct their part). If
  the credits were already spent the balance goes negative, and spending stays blocked until it's
  positive again.
- A fully refunded video purchase locks the project again (`purchased: false`): no more clips,
  assembly or downloads until it's bought again, and queued `clips`/`assemble` jobs are canceled
  (they show as `failed`). A partial refund leaves it unlocked.
- If a refund fails or is canceled in Stripe, it's undone: deducted credits come back and a
  locked project is unlocked again.

Pricing is per scene, and only AI work is charged. Scenes with an AI-generated (or AI-restyled)
image: still $0.45, kenburns $0.55, runway $0.75, veo3 $1.89. Scenes showing the user's photo
as-is: still and kenburns free; runway $0.30 and veo3 $1.44 (the AI clip only). Each `breakdown`
entry has `photo: true` for as-is photo scenes. Minimum charge $2.99 per video (covers the AI
script, narration and assembly). Superusers bypass payment gates.

## Limits

- **Unpaid projects:** at most 2 past the draft stage; starting a third `script` returns 402
  `unpaid_project_limit`.
- **Free work per day** (unpaid projects only; paid projects are never limited), per user per
  24 hours:
  - 2 storyboard builds (`script` runs, new or rebuilt).
  - 20 regenerations: redoing one scene's keyframe or narration, or re-running the `keyframes` or
    `narration` step for the whole project. The steps a build chains on its own (`then`) don't
    count — only edits do.

  Beyond the free storyboards, a storyboard costs $0.50 of credits (402
  `credits_confirm_required` / `credits_required`; see Credits). Beyond the free regenerations:
  429 `free_daily_limit`. When the site-wide daily allowance of free storyboards is used up,
  storyboards need credits for the rest of the day.
- **Request rate:** 120 requests per minute per user and 300 per minute per IP; the
  unauthenticated device-login endpoints allow 30 per minute per IP. Over the limit: 429
  `rate_limited` with a `Retry-After` header.
- **API keys:** up to 10 active per account.

A 429 is never fixed by retrying immediately: back off, or tell the user. The `d2v` CLI exits with
code 5 on a 429.

## Client identification (optional)

Integrations can say who they are so usage can be attributed by channel:

```
X-D2V-Client: my-integration/1.2
X-D2V-Ref: partner-name
```

The `d2v` package sends `cli/<version>` or `mcp/<version>; agent=<MCP client name>`, plus
`X-D2V-Ref` when `DOC2VIDEO_REF` is set in its environment (directory listings set this in their
install config).
