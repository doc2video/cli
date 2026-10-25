---
name: doc2video-cli
description: "Create and steer videos on doc2video.io (the hosted service) with the d2v CLI, from a local folder of documents and/or photos. Use when the user wants a video made from files or photos in a folder via doc2video, asks to review or change a doc2video storyboard, scene, narration or keyframe, or wants to produce/download a doc2video video. Not for the local AIworkforce video pipeline."
---

# doc2video via the `d2v` CLI

`d2v` drives doc2video.io: it uploads the user's files, runs the AI pipeline on doc2video's
servers, and lets you steer each scene. Run `d2v guide` for the full workflow; this is the short
version.

## Before you start

- `d2v whoami` — if it fails, connect the account: run `d2v login --start --json`, show the user
  the `verification_url` (they sign in or sign up and click Approve; the code should match), then
  run `d2v login --wait`. Don't ask the user to paste a key.
- Settle the basics with the user if they haven't said: length (`--duration 30s|1m|2m|5m|auto`),
  orientation (`--aspect 9:16` for Reels/TikTok/Shorts, `16:9` for YouTube/presentations), and the
  tone or focus (`--direction`). Photos are used as-is by default; `--photos restyle` AI-enhances them.

## Build the storyboard

```bash
d2v create "<name>" <folder> --duration 1m --aspect 9:16 --direction "<tone/focus>" --build --json
```

The build (script → keyframes → narration → preview) takes several minutes on the server. Wait with
`d2v wait <project> --timeout 9m --json` in a loop (exit code 4 = still running; call again), or run
it in the background. Don't re-run `build` while it's in progress.

## Review with the user

1. `d2v show <project>` — scenes, narration, preview URL, next steps.
2. `d2v pull <project> --out d2v-review` — then read the `scene_XX.png` images and
   `storyboard.md` so you can judge the visuals yourself.
3. Summarize scene by scene, flag weak spots (off-brand images, wrong photo, clunky narration),
   and share the preview URL.

## Steer

```bash
d2v keyframe  <p> <n> "<what to change>"       # edit the image (or --fresh for a new one)
d2v narration <p> <n> --prompt "<direction>"   # AI rewrite + new audio (or --text "exact words")
d2v scene     <p> <n> --engine veo3            # still | kenburns | runway | veo3
d2v scene     <p> <n> --photo <file|none> [--photo-treatment restyle]
d2v set       <p> --voice <name>               # project-wide; then: d2v run <p> narration
d2v run       <p> preview --wait               # refresh the preview after edits
```

Batch independent scene edits, then refresh the preview once.

## Money: always ask first

Clips, final assembly and download require a purchase. Run `d2v estimate <p>`, tell the user the
price, and only on their go-ahead run `d2v buy <p> --open` (they pay in their browser),
`d2v buy <p> --credits` (from their prepaid credits) or `d2v redeem <p> <code>` with a code they
gave you. Then `d2v produce <p>` and wait, and finally `d2v download <p>`. Exit code 3 means
payment is required — don't retry, ask the user.

Unpaid projects get 2 free storyboards and 20 scene redos per day. A further storyboard costs
$0.50 of credits: the command exits 3 with the price — ask the user, and add `--use-credits` only
if they agree. `d2v credits` shows the balance; `d2v credits add 5 --open` lets them top up.

Use `--json` whenever you need to read results; projects can be referenced by 8-char id prefix.
