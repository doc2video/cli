# d2v — doc2video CLI and MCP server

[![npm](https://img.shields.io/npm/v/doc2video)](https://www.npmjs.com/package/doc2video)
[![License: MIT](https://img.shields.io/npm/l/doc2video)](./LICENSE)
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=doc2video&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImRvYzJ2aWRlbyIsIm1jcCJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=doc2video&config=%7B%22name%22%3A%22doc2video%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22doc2video%22%2C%22mcp%22%5D%7D)

Point `d2v` at a folder of documents and photos and it makes a narrated, AI-produced video on
[doc2video.io](https://doc2video.io). Drive it yourself, or let Claude or ChatGPT (Codex) drive it
for you — either through the CLI or as an MCP server.

```bash
d2v create "Spring Open House" ./open-house --duration 1m --aspect 9:16 \
  --direction "Warm and inviting, finish on the garden" --build --wait
```

## Install

Requires Node.js 18.18+.

```bash
npm install -g doc2video     # installs the `d2v` (and `doc2video`) command
```

Or run it without installing: `npx doc2video <command>`.

## Log in

```bash
d2v login
```

Your browser opens doc2video. Sign in (or sign up), check the code matches your terminal, click
**Approve** — done. The key is saved to `~/.doc2video/config.json` and shows up on the dashboard's
API page, where you can revoke it. No browser on this machine? `d2v login --no-browser` prints the
link to open anywhere.

Agents use two steps so they can show you the link: `d2v login --start --json` (returns the link
and code), then `d2v login --wait` after you approve. Over MCP, the `d2v_connect_account` tool does
the same.

You can also paste a key created on the API page (`d2v login --key d2v_…`) or set
`DOC2VIDEO_API_KEY`. To target another server (e.g. local dev) use `--url http://localhost:3000`
or `DOC2VIDEO_URL`.

## What goes in the folder

| Kind | Formats | How it's used |
|------|---------|---------------|
| Documents | PDF, DOCX, PPTX, Markdown, TXT, CSV, JSON | The story: the script is written from them |
| Photos | JPG, PNG, WebP, HEIC (iPhone) | Shown to the scriptwriter and **featured in scenes** |

Folders are scanned recursively (hidden files skipped). Legacy `.doc`/`.ppt`/Keynote/Pages files
are skipped with a hint to convert them. A photos-only folder works too — the story is built from
the photos and your creative direction. With no files at all, use `--draft "description"`.

Photos are used **as-is** by default — cropped to the video's shape, and free as still or Ken
Burns scenes (you only pay for AI work, e.g. an AI video clip made from the photo). Use
`--photos restyle` to have AI polish them into cinematic keyframes while keeping the real subject,
or set it per scene with `d2v scene <p> <n> --photo-treatment restyle`.

## Workflow

```bash
d2v create "Name" ./folder [settings] --build --wait   # storyboard: script → keyframes → narration → preview
d2v show <project>                                     # scenes, narration, preview URL, next steps
d2v pull <project>                                     # keyframes + storyboard.md to a local folder

# steer, scene by scene
d2v keyframe  <p> 3 "warmer light, show the sign"      # edit the image
d2v keyframe  <p> 3 --fresh                            # brand-new image
d2v narration <p> 3 --prompt "shorter and punchier"    # AI rewrite + new voice-over
d2v narration <p> 3 --text "Exact words."              # exact text + new voice-over
d2v scene     <p> 3 --engine veo3                      # still | kenburns | runway | veo3
d2v scene     <p> 3 --photo IMG_2041.jpg               # feature a photo (or --photo none)
d2v run       <p> preview --wait                       # refresh the preview video

# finish (costs money — you pay in the browser)
d2v estimate <p>
d2v buy <p> --open          # or: d2v buy <p> --credits, or: d2v redeem <p> CODE
d2v produce <p> --wait      # AI clips → final assembly
d2v download <p>
```

### Free storyboards and credits

Each day you get **2 free storyboards** and 20 scene redos on unpaid projects. After that, a
storyboard costs **$0.50 from prepaid credits** — pass `--use-credits` to `create --build`, `build`
or `run` to confirm (without it the command stops and tells you the price). Credits also unlock
finished videos: `d2v buy <p> --credits`.

```bash
d2v credits                 # balance, free storyboards left today, recent activity
d2v credits add 10 --open   # top up $5, $10 or $25 in the browser
```

Projects can be named by id, 8-character id prefix, or exact name. `d2v help <command>` shows
every option; `d2v guide` prints the full workflow guide.

**Settings** (on `create` and `set`): `--duration auto|30s|1m|2m|5m|10m`, `--aspect 9:16|16:9`,
`--direction`, `--voice` (see `d2v voices`), `--stability`, `--photos original|restyle`,
`--consistency`/`--no-consistency`, `--client`, `--email`, `--phone`, `--website`.

### Long-running steps

Everything runs on doc2video's servers; a storyboard takes several minutes and final production
longer. `--wait` blocks with progress on stderr, and Ctrl+C only stops the waiting — the work
continues. Pick it back up with `d2v wait <project>`. Steps can be chained on the server, so a
`build` keeps going even if your terminal closes.

### Scripting and agents

Add `--json` to any command for machine-readable output on stdout (progress stays on stderr).
Exit codes: `0` ok, `1` error, `2` usage error, `3` payment required, `4` `--wait` timed out,
`5` rate limit or daily free limit reached.

## Use it from Claude or ChatGPT

### Claude Code / Codex CLI (shell)

Both can simply run `d2v`. Open a terminal agent in the folder with your files and ask, e.g.
*"Make a 60-second vertical video from this folder with doc2video, show me the storyboard, and
punch up the opening."* For better results, install the agent instructions:

- **Claude Code:** copy `agents/SKILL.md` to `~/.claude/skills/doc2video-cli/SKILL.md`
- **Codex CLI:** append `agents/AGENTS.md` to `~/.codex/AGENTS.md` (or the folder's `AGENTS.md`)

Both files ship with the package — find them under `$(npm root -g)/doc2video/agents/`.

### MCP (Claude Desktop, Claude Code, Codex, any MCP client)

`d2v mcp` runs an MCP server over stdio with tools for the whole workflow — including
`d2v_view_storyboard`, which returns the keyframe images so the model can actually see the
storyboard and give visual feedback. It's listed in the official
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.doc2video/d2v`.

The API key below is optional: without one, the `d2v_connect_account` tool gives you a link to
sign in (or sign up) in your browser, and remembers the key.

**Cursor / VS Code** — use the buttons at the top of this page.

**Claude Code**

```bash
claude mcp add doc2video -- npx -y doc2video mcp
# or with a key from doc2video.io/dashboard/api-keys:
claude mcp add doc2video -e DOC2VIDEO_API_KEY=d2v_xxx -- npx -y doc2video mcp
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "doc2video": {
      "command": "npx",
      "args": ["-y", "doc2video", "mcp"],
      "env": { "DOC2VIDEO_API_KEY": "d2v_xxx" }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.doc2video]
command = "npx"
args = ["-y", "doc2video", "mcp"]
env = { DOC2VIDEO_API_KEY = "d2v_xxx" }
```

With a global install you can use `"command": "d2v", "args": ["mcp"]` instead of `npx`.

**ChatGPT (web/desktop):** ChatGPT connects only to *remote* MCP servers over HTTPS, so it can't
run this local server or read your folders. Use Codex CLI for local folders.

## REST API

The CLI is a thin client over the doc2video REST API — see [API.md](./API.md) to call it directly.

## Development

```bash
npm install
npm run build      # compile to dist/
npm test           # build + end-to-end tests against a mock API (no network)
npm link           # use your local build as `d2v`
```

Releases are published from GitHub Actions when a `v*` tag is pushed: to npm (with provenance)
and to the MCP Registry. Issues and pull requests are welcome at
[github.com/doc2video/cli](https://github.com/doc2video/cli).

## License

The CLI and MCP server are [MIT licensed](./LICENSE). They're a client for the hosted
doc2video service at [doc2video.io](https://doc2video.io), which has its own
[terms](https://doc2video.io/terms).
