## doc2video (`d2v` CLI)

When the user wants a video made from documents or photos in a folder, use the `d2v` CLI, which
drives doc2video.io. Run `d2v guide` once for the full workflow.

- Check access with `d2v whoami`. If it fails, run `d2v login --start --json`, give the user the
  `verification_url` to open and approve, then run `d2v login --wait`.
- Create and build: `d2v create "<name>" <folder> --duration 1m --aspect 9:16 --direction "<tone>" --build --json`.
  Ask about length, orientation and tone first if the user hasn't said.
- The build runs for several minutes on the server. Poll with `d2v wait <project> --timeout 9m --json`
  (exit code 4 = still running, call again).
- Review: `d2v show <project>`; `d2v pull <project> --out d2v-review` saves keyframe PNGs and
  storyboard.md for you to inspect.
- Steer: `d2v keyframe <p> <n> "<change>"`, `d2v narration <p> <n> --prompt "<direction>"`,
  `d2v scene <p> <n> --engine veo3|runway|kenburns|still`, `d2v scene <p> <n> --photo <file|none>`,
  then `d2v run <p> preview --wait`.
- Never purchase, spend credits or produce on your own. Show `d2v estimate <p>` and wait for the
  user's go-ahead before `d2v buy <p> --open` (they pay in the browser), `d2v buy <p> --credits`,
  `d2v redeem <p> <code>`, or `d2v produce <p>`. Exit code 3 means payment is required.
- 2 storyboards a day are free; a further one costs $0.50 of credits. If a build exits 3 with that
  price, ask the user and add `--use-credits` only if they agree. `d2v credits` shows the balance.
- Add `--json` to read results programmatically.
