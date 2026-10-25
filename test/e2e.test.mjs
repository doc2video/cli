// End-to-end tests: run the built CLI and MCP server against the mock API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockServer, TEST_KEY } from "./mock-server.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let mock;
let work;

// No HOME config leaks into tests: everything is passed by flag/env
// Each run gets its own config dir so tests never read or overwrite your real login
const configDir = mkdtempSync(join(tmpdir(), "d2v-config-"));
const env = { ...process.env, DOC2VIDEO_API_KEY: TEST_KEY, D2V_POLL_INTERVAL_SECONDS: "0.02", DOC2VIDEO_CONFIG_DIR: configDir };
/** Same, but with no API key anywhere: for the login tests. */
const { DOC2VIDEO_API_KEY: _unused, ...envNoKey } = { ...env, DOC2VIDEO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "d2v-login-")) };

function d2v(...args) {
  return d2vWith(env, ...args);
}

function d2vWith(processEnv, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, "--url", mock.base, "--json"], { env: processEnv, cwd: work }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, data: stdout ? JSON.parse(stdout) : null, stderr });
    });
  });
}

before(async () => {
  mock = await startMockServer();
  work = mkdtempSync(join(tmpdir(), "d2v-test-"));
  const folder = join(work, "shoot");
  for (const dir of [folder, join(folder, "more"), join(folder, ".hidden")]) {
    try { rmSync(dir, { recursive: true }); } catch {}
  }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(folder, "more"), { recursive: true });
  mkdirSync(join(folder, ".hidden"), { recursive: true });
  writeFileSync(join(folder, "brief.md"), "# Open house\nThree bedrooms and a garden.");
  writeFileSync(join(folder, "IMG_10.jpg"), "fake-jpeg-10");
  writeFileSync(join(folder, "IMG_2.jpg"), "fake-jpeg-2");
  writeFileSync(join(folder, "more", "garden.png"), "fake-png");
  writeFileSync(join(folder, "iphone.heic"), "fake-heic");
  writeFileSync(join(folder, "legacy.doc"), "fake-doc");
  writeFileSync(join(folder, ".hidden", "secret.md"), "should not upload");
});

after(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true });
});

let projectId;

test("create uploads a folder, builds the storyboard chain and waits for it", async () => {
  const { code, data, stderr } = await d2v("create", "Open House", "shoot", "--duration", "30s", "--aspect", "portrait", "--build", "--wait");
  assert.equal(code, 0, stderr);
  projectId = data.project.id;

  const create = mock.state.requests.find((r) => r.method === "POST" && r.path === "/api/v1/projects");
  assert.deepEqual(create.body, { name: "Open House", target_duration_seconds: 30, aspect_ratio: "9:16" });

  // Recursive, hidden files skipped, HEIC accepted as a photo, legacy formats explained
  const uploaded = data.upload.uploaded.map((d) => d.filename).sort();
  assert.deepEqual(uploaded, ["IMG_10.jpg", "IMG_2.jpg", "brief.md", "garden.png", "iphone.heic"]);
  assert.equal(mock.state.uploads.size, 5);
  assert.match(data.upload.skipped.find((s) => s.path.endsWith("legacy.doc")).reason, /save as \.docx/);
  assert.ok(!uploaded.includes("secret.md"));
  assert.equal(data.upload.uploaded.filter((d) => d.kind === "photo").length, 4);
  const heicUpload = mock.state.requests.find((r) => r.path.endsWith("/upload-url") && r.body.filename === "iphone.heic");
  assert.equal(heicUpload.body.content_type, "image/heic");

  // The chain was requested in one call and fully completed, despite the gap between steps
  assert.deepEqual(data.job.then, ["keyframes", "narration", "preview"]);
  assert.equal(data.wait.done, true);
  assert.deepEqual(data.wait.finished.map((j) => j.step), ["script", "keyframes", "narration", "preview"]);
  assert.ok(data.wait.project.videos.preview.url);
});

test("projects resolve by exact name and by id prefix", async () => {
  const byName = await d2v("show", "open house");
  assert.equal(byName.code, 0, byName.stderr);
  assert.equal(byName.data.id, projectId);
  const byPrefix = await d2v("show", projectId.slice(0, 8));
  assert.equal(byPrefix.data.id, projectId);
  const missing = await d2v("show", "nope-nope");
  assert.equal(missing.code, 1);
  assert.equal(missing.data.error.code, "not_found");
});

test("assigning a photo patches the scene and regenerates its keyframe", async () => {
  const { code, data, stderr } = await d2v("scene", projectId.slice(0, 8), "2", "--photo", "IMG_2.jpg", "--photo-treatment", "restyle");
  assert.equal(code, 0, stderr);
  const patch = mock.state.requests.find((r) => r.method === "PATCH");
  assert.deepEqual(patch.body, { photo: { filename: "IMG_2.jpg", treatment: "restyle" } });
  const regen = mock.state.requests.find((r) => r.path.endsWith("/scenes/2/keyframe"));
  assert.deepEqual(regen.body, { mode: "fresh" });
  assert.equal(data.job.step, "regen_keyframe");
});

test("a local photo path is uploaded before being assigned", async () => {
  const before = mock.state.uploads.size;
  writeFileSync(join(work, "new-shot.webp"), "fake-webp");
  const { code, stderr } = await d2v("scene", projectId, "3", "--photo", "new-shot.webp", "--no-regen");
  assert.equal(code, 0, stderr);
  assert.equal(mock.state.uploads.size, before + 1);
  const patch = mock.state.requests.filter((r) => r.method === "PATCH").at(-1);
  assert.ok(patch.body.photo.document_id);
});

test("produce without a purchase exits 3 with guidance", async () => {
  const { code, data } = await d2v("produce", projectId);
  assert.equal(code, 3);
  assert.equal(data.error.code, "payment_required");
  assert.match(data.error.message, /d2v buy/);
});

test("pull saves keyframes and a storyboard.md", async () => {
  const { code, data, stderr } = await d2v("pull", projectId, "--out", "board");
  assert.equal(code, 0, stderr);
  assert.equal(data.images.length, 3);
  assert.ok(existsSync(join(work, "board", "scene_01.png")));
  const md = readFileSync(join(work, "board", "storyboard.md"), "utf-8");
  assert.match(md, /## Scene 2: Scene 2/);
  assert.match(md, /Photo: IMG_2.jpg \(restyle\)/);
});

test("usage errors exit 2", async () => {
  const { code, data } = await d2v("scene", projectId, "two");
  assert.equal(code, 2);
  assert.equal(data.error.code, "usage");
});

test("MCP server lists tools and serves project data and keyframe images", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--url", mock.base],
    env: { ...env, D2V_POLL_INTERVAL_SECONDS: "0.02" },
    stderr: "pipe",
  });
  const client = new Client({ name: "d2v-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() ?? "", /d2v_create_project/);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["d2v_create_project", "d2v_wait", "d2v_view_storyboard", "d2v_update_scene", "d2v_produce_video"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    assert.equal(tools.find((t) => t.name === "d2v_get_project").annotations.readOnlyHint, true);

    const list = await client.callTool({ name: "d2v_list_projects", arguments: {} });
    assert.equal(JSON.parse(list.content[0].text).projects[0].id, projectId);

    const view = await client.callTool({ name: "d2v_view_storyboard", arguments: { project: "Open House", scenes: [1, 2] } });
    assert.equal(view.content.filter((c) => c.type === "image").length, 2);
    assert.match(view.content.find((c) => c.type === "text" && c.text.startsWith("Scene 2")).text, /photo IMG_2.jpg/);

    const wait = await client.callTool({ name: "d2v_wait", arguments: { project: projectId, timeout_seconds: 5 } });
    assert.equal(JSON.parse(wait.content[0].text).done, true);

    const paid = await client.callTool({ name: "d2v_produce_video", arguments: { project: projectId } });
    assert.equal(paid.isError, true);
    assert.match(paid.content[0].text, /d2v_estimate_cost/);
  } finally {
    await client.close();
  }
});

test("login --start / --wait connects through browser approval and saves the key", async () => {
  const start = await d2vWith(envNoKey, "login", "--start");
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.data.verification_url, /\/connect\?code=/);
  const config = () => JSON.parse(readFileSync(join(envNoKey.DOC2VIDEO_CONFIG_DIR, "config.json"), "utf-8"));
  assert.equal(config().pendingLogin.userCode, start.data.user_code);

  const tooSoon = await d2vWith(envNoKey, "login", "--wait", "--timeout", "1");
  assert.equal(tooSoon.code, 1);
  assert.equal(tooSoon.data.error.code, "login_timeout");

  mock.state.decideDevice(start.data.user_code, "approved");
  const wait = await d2vWith(envNoKey, "login", "--wait", "--timeout", "10");
  assert.equal(wait.code, 0, wait.stderr);
  assert.equal(wait.data.email, "test@example.com");
  assert.equal(config().apiKey, TEST_KEY);
  assert.equal(config().pendingLogin, undefined);

  // The device login names the key after this machine
  const started = [...mock.state.devices.values()].find((d) => d.userCode === start.data.user_code);
  assert.match(started.clientName, /^d2v CLI on /);

  const who = await d2vWith(envNoKey, "whoami");
  assert.equal(who.code, 0, who.stderr);
  assert.equal(who.data.key_source, "config");
});

test("a denied login fails clearly", async () => {
  const start = await d2vWith(envNoKey, "login", "--start");
  mock.state.decideDevice(start.data.user_code, "denied");
  const wait = await d2vWith(envNoKey, "login", "--wait", "--timeout", "10");
  assert.equal(wait.code, 1);
  assert.equal(wait.data.error.code, "access_denied");
});

test("MCP agents connect the account with d2v_connect_account", async () => {
  const { DOC2VIDEO_API_KEY: _k, ...noKey } = { ...env, DOC2VIDEO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "d2v-mcp-")) };
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--url", mock.base], env: noKey, stderr: "pipe" });
  const client = new Client({ name: "d2v-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const before = await client.callTool({ name: "d2v_list_projects", arguments: {} });
    assert.equal(before.isError, true);
    assert.match(before.content[0].text, /d2v_connect_account/);

    const first = JSON.parse((await client.callTool({ name: "d2v_connect_account", arguments: {} })).content[0].text);
    assert.equal(first.connected, false);
    assert.match(first.verification_url, /\/connect\?code=/);
    const device = [...mock.state.devices.values()].find((d) => d.userCode === first.user_code);
    assert.match(device.clientName, /^d2v-test via d2v on /);

    const waiting = JSON.parse((await client.callTool({ name: "d2v_connect_account", arguments: { wait_seconds: 0 } })).content[0].text);
    assert.equal(waiting.still_waiting, true);

    mock.state.decideDevice(first.user_code, "approved");
    const done = JSON.parse((await client.callTool({ name: "d2v_connect_account", arguments: { wait_seconds: 10 } })).content[0].text);
    assert.deepEqual(done, { connected: true, email: "test@example.com" });

    const after = await client.callTool({ name: "d2v_list_projects", arguments: {} });
    assert.notEqual(after.isError, true);
    const again = JSON.parse((await client.callTool({ name: "d2v_connect_account", arguments: {} })).content[0].text);
    assert.equal(again.connected, true);
  } finally {
    await client.close();
  }
});

test("requests identify the client and directory ref for attribution", async () => {
  const before = mock.state.requests.length;
  const res = await d2vWith({ ...env, DOC2VIDEO_REF: "smithery" }, "projects");
  assert.equal(res.code, 0, res.stderr);
  const sent = mock.state.requests.slice(before).find((r) => r.path === "/api/v1/projects");
  assert.equal(sent.headers["x-d2v-client"], `cli/${VERSION}`);
  assert.equal(sent.headers["x-d2v-ref"], "smithery");

  // Without DOC2VIDEO_REF no ref header is sent
  const plainStart = mock.state.requests.length;
  await d2v("projects");
  assert.equal(mock.state.requests.slice(plainStart)[0].headers["x-d2v-ref"], undefined);
});

test("MCP requests name the agent driving them", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--url", mock.base], env, stderr: "pipe" });
  const client = new Client({ name: "claude-code", version: "9.9.9" });
  await client.connect(transport);
  try {
    const before = mock.state.requests.length;
    await client.callTool({ name: "d2v_list_projects", arguments: {} });
    const sent = mock.state.requests.slice(before).find((r) => r.path === "/api/v1/projects");
    assert.equal(sent.headers["x-d2v-client"], `mcp/${VERSION}; agent=claude-code`);
  } finally {
    await client.close();
  }
});

test("a daily free limit exits 5 so agents don't retry", async () => {
  mock.state.freeLimitReached = true;
  try {
    const res = await d2v("build", projectId, "--force");
    assert.equal(res.code, 5);
    assert.equal(res.data.error.code, "free_daily_limit");
  } finally {
    mock.state.freeLimitReached = false;
  }
});

test("credits shows the balance and add returns a checkout link", async () => {
  mock.state.balanceCents = 1000;
  const summary = await d2v("credits");
  assert.equal(summary.code, 0, summary.stderr);
  assert.equal(summary.data.balance_cents, 1000);

  const add = await d2v("credits", "add", "10");
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.data.checkout_url, /\/stripe\/checkout\/1000$/);

  const bad = await d2v("credits", "add", "7");
  assert.equal(bad.code, 1);
  assert.match(bad.data.error.message, /\$5\.00, \$10\.00, \$25\.00/);
});

test("a storyboard beyond the free ones needs --use-credits", async () => {
  mock.state.creditsMode = "confirm";
  mock.state.balanceCents = 1000;
  try {
    const refused = await d2v("build", projectId, "--force");
    assert.equal(refused.code, 3);
    assert.equal(refused.data.error.code, "credits_confirm_required");
    assert.match(refused.data.error.message, /--use-credits/);
    assert.equal(mock.state.balanceCents, 1000, "nothing is spent without consent");

    const paid = await d2v("build", projectId, "--force", "--use-credits");
    assert.equal(paid.code, 0, paid.stderr);
    const sent = mock.state.requests.filter((r) => r.path.endsWith("/jobs") && r.method === "POST").at(-1);
    assert.equal(sent.body.use_credits, true);
    assert.equal(mock.state.balanceCents, 950);

    mock.state.creditsMode = "required";
    const broke = await d2v("build", projectId, "--force", "--use-credits");
    assert.equal(broke.code, 3);
    assert.match(broke.data.error.message, /d2v credits add 5 --open/);
  } finally {
    mock.state.creditsMode = null;
  }
});

test("MCP asks for consent before spending credits", async () => {
  mock.state.creditsMode = "confirm";
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--url", mock.base], env, stderr: "pipe" });
  const client = new Client({ name: "d2v-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["d2v_get_credits", "d2v_add_credits_link", "d2v_unlock_with_credits"]) assert.ok(names.includes(name), name);

    const refused = await client.callTool({ name: "d2v_build_storyboard", arguments: { project: projectId, force: true } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /use_credits: true/);

    const paid = await client.callTool({ name: "d2v_build_storyboard", arguments: { project: projectId, force: true, use_credits: true } });
    assert.notEqual(paid.isError, true);
  } finally {
    mock.state.creditsMode = null;
    await client.close();
  }
});

test("buy --credits unlocks the project from the balance", async () => {
  mock.state.balanceCents = 1000;
  const res = await d2v("buy", projectId, "--credits");
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.data.amount_cents, 299);
  assert.equal(res.data.balance_cents, 701);
  const produce = await d2v("produce", projectId);
  assert.equal(produce.code, 0, produce.stderr);
});

test("clips beyond what the purchase covers need --use-credits (produce and clip)", async () => {
  const p = mock.state.projects.get(projectId);
  Object.assign(p.scenes[0], { visual_mode: "veo3", has_clip: false }); // a pricier engine after buying
  mock.state.clipsExtraCents = 115;
  mock.state.balanceCents = 500;
  try {
    const refused = await d2v("produce", projectId);
    assert.equal(refused.code, 3);
    assert.equal(refused.data.error.code, "credits_confirm_required");
    assert.match(refused.data.error.message, /\$1\.15 more than your purchase covers[\s\S]*--use-credits --max-credits 1\.15/);
    assert.equal(mock.state.balanceCents, 500, "nothing is spent without consent");

    // A cap below the price is refused rather than charged
    const capped = await d2v("produce", projectId, "--use-credits", "--max-credits", "1.00");
    assert.equal(capped.code, 3);
    assert.equal(mock.state.balanceCents, 500);

    const paid = await d2v("produce", projectId, "--use-credits", "--max-credits", "1.15");
    assert.equal(paid.code, 0, paid.stderr);
    const sent = mock.state.requests.filter((r) => r.path.endsWith("/jobs") && r.method === "POST").at(-1);
    assert.deepEqual([sent.body.step, sent.body.then, sent.body.use_credits, sent.body.max_credits_cents], ["clips", ["assemble"], true, 115]);
    assert.equal(mock.state.balanceCents, 385);

    const retry = await d2v("clip", projectId, "1", "--engine", "veo3");
    assert.equal(retry.code, 3);
    const retried = await d2v("clip", projectId, "1", "--engine", "veo3", "--use-credits");
    assert.equal(retried.code, 0, retried.stderr);
    assert.deepEqual(mock.state.requests.filter((r) => r.path.endsWith("/clip")).at(-1).body, { engine: "veo3", use_credits: true });
  } finally {
    mock.state.clipsExtraCents = 0;
  }
});
