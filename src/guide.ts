/** Sent to MCP clients as server instructions. */
export const MCP_INSTRUCTIONS = `doc2video turns the user's documents and photos into a narrated, AI-produced video.

Typical flow:
0. If a tool says the user is not logged in, call d2v_connect_account, give the user the link it
   returns (they sign in or sign up and click Approve), then call it again to finish.
1. d2v_create_project with the user's local folder/files in \`sources\` (photos are featured in scenes,
   documents supply the story) and build: true. Ask about length (duration_seconds), orientation
   (aspect_ratio) and tone (creative_direction) if the user hasn't said.
2. The storyboard builds on the server (script → keyframes → narration → preview) over several
   minutes. Call d2v_wait repeatedly until done is true.
3. d2v_view_storyboard to see the keyframe images and narration, then summarize for the user and
   share the preview_url. Steer with d2v_regenerate_keyframe, d2v_update_narration and
   d2v_update_scene, then d2v_run_step step=preview to refresh the preview video.
4. Final production costs money: show d2v_estimate_cost and let the user decide. Only call
   d2v_create_checkout_link (the user pays in their browser), d2v_unlock_with_credits,
   d2v_redeem_promo_code or d2v_produce_video when the user asks. Then d2v_wait and d2v_download_video.

Free allowance: 2 storyboards and 20 scene redos per day on unpaid projects. A further storyboard
costs $0.50 of prepaid credits: tools return credits_confirm_required — ask the user, and only with
their OK call again with use_credits: true. d2v_get_credits shows the balance; d2v_add_credits_link
lets the user top up in their browser.

A purchase covers the project at the price paid. AI clips beyond that — a pricier engine chosen
after buying, or a new take of a clip that's already made — are paid from credits the same way
(credits_confirm_required says how much). Retrying a failed clip is free.

Projects can be referenced by id, 8-character id prefix, or exact name; scenes by number.`;

/** Printed by `d2v guide`: how a person or agent should drive doc2video from the CLI. */
export const AGENT_GUIDE = `doc2video turns documents and photos into a narrated, AI-produced video.

CONNECT (once per machine)
     d2v login                 opens the browser; approve, and the CLI is connected
   Agents: \`d2v login --start --json\` returns a link and code to show the user;
   after they approve, \`d2v login --wait\` finishes. Never ask the user to paste a key.

WORKFLOW
1. Create a project from the user's folder (documents and/or photos):
     d2v create "Name" ./folder --duration 60 --aspect 9:16 --direction "..." --build --wait
   Photos (jpg/png/webp/heic) are shown to the scriptwriter and featured in scenes;
   documents (pdf/docx/pptx/md/txt/csv/json) supply the story. Public links
   (https://…/menu.pdf, a photo, a web page) work alongside files. With no files,
   use --draft "description" to have AI write the content.
2. --build runs the storyboard chain on the server: script → keyframes →
   narration → preview (a watermarked preview video). It takes minutes.
   Use --wait (or \`d2v wait <project>\`) to block until it finishes.
3. Review: \`d2v show <project>\` (scenes, narration, next steps), and
   \`d2v pull <project>\` to download every keyframe + storyboard.md so you
   can look at the images. Share the preview URL with the user.
4. Steer scene by scene, then re-run the preview:
     d2v keyframe <p> 3 "warmer light, show the storefront"   (edit image)
     d2v keyframe <p> 3 --fresh                                 (new image)
     d2v narration <p> 3 --prompt "shorter and punchier"        (AI rewrite + new audio)
     d2v narration <p> 3 --text "Exact words to say."           (exact text + new audio)
     d2v scene <p> 3 --engine veo3        (still | kenburns | runway | veo3)
     d2v scene <p> 3 --photo IMG_2041.jpg [--photo-treatment restyle]
     d2v scene <p> 3 --photo none         (back to an AI visual)
     d2v run <p> preview --wait
   Project-wide: d2v set <p> --voice Adam --direction "..." (then rebuild steps).
5. Producing the final video costs money and needs the user's purchase:
     d2v estimate <p>       (price, by each scene's engine)
     d2v buy <p> --open     (Stripe checkout link — the USER pays in their browser)
     d2v buy <p> --credits  (pay from the user's prepaid credits instead)
     d2v redeem <p> CODE    (promo code)
   Then: d2v produce <p> --wait  (AI clips for veo3/runway scenes → assembly)
         d2v download <p>        (saves the MP4)

FREE ALLOWANCE AND CREDITS
   Unpaid projects get 2 storyboards and 20 scene redos per day. After that a
   storyboard costs $0.50 of prepaid credits; the command fails (exit 3) until
   you add --use-credits. \`d2v credits\` shows the balance; \`d2v credits add 5
   --open\` lets the user top up ($5, $10 or $25) in their browser.
   A purchase covers the project at the price paid. AI clips beyond that (a
   pricier engine chosen after buying, or a new take of a working clip) are paid
   from credits the same way: \`d2v produce\` / \`d2v clip\` exit 3 with the
   amount until you add --use-credits. Retrying a failed clip is free.

RULES FOR AGENTS
- Never pay, spend credits (--use-credits, buy --credits), redeem a code, or
  produce unless the user asked to. Show the price and let them decide;
  checkout happens in their browser.
- Scenes are referenced by number (1, 2, 3…). Projects by id, 8-char id
  prefix, or exact name.
- Add --json to any command for machine-readable output on stdout
  (progress goes to stderr). Errors exit non-zero: 2 usage, 3 payment
  required, 4 wait timed out, 5 rate limit or daily free limit reached
  (don't retry right away), 1 anything else.
- Regenerating a keyframe or narration only updates that scene; run the
  preview step again to see changes in the video.
- Engines: still (static image), kenburns (pan/zoom), runway (AI video,
  cheaper), veo3 (AI video, best). Photo treatment: original (the photo
  itself) or restyle (AI-enhanced from the photo).
`;
