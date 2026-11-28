// 用 Node 自带的测试跑（node --test）：R2、限流、Telegram 都是假的；请求体是 MaaPilot 客户端真实生成的（test/fixtures/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkSubmission, handle, keyPrefix, notifyText, sha256Hex, zipEntries } from "../src/index.js";

const body = readFileSync(new URL("./fixtures/request-body.bin", import.meta.url));
const meta = JSON.parse(readFileSync(new URL("./fixtures/request-meta.json", import.meta.url), "utf8"));
const NOW = "2026-11-20T16:00:00Z";

class Bucket {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, bytes);
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { body: bytes, text: async () => new TextDecoder().decode(bytes) };
  }
  async list({ prefix }) {
    return { objects: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  }
}

function env(over = {}) {
  return { BUCKET: new Bucket(), NOW, ...over };
}

function post(bytes = body, headers = {}) {
  return new Request("https://feedback.example/feedback", {
    method: "POST",
    headers: { "content-type": meta.content_type, "x-maapilot-feedback": "1", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: bytes,
  });
}

/** 把客户端的请求拆开，改一改清单或包，再拼回去。 */
async function rebuilt(change) {
  const form = await new Response(body, { headers: { "content-type": meta.content_type } }).formData();
  const manifest = JSON.parse(form.get("manifest"));
  let bundle = new Uint8Array(await form.get("bundle").arrayBuffer());
  const r = (await change(manifest, bundle)) || {};
  if (r.bundle) bundle = r.bundle;
  const out = new FormData();
  out.set("manifest", JSON.stringify(manifest));
  out.set("bundle", new Blob([bundle], { type: "application/zip" }), "x.zip");
  return new Request("https://feedback.example/feedback", {
    method: "POST",
    headers: { "x-maapilot-feedback": "1" },
    body: out,
  });
}

test("收下客户端真实生成的请求：存包和清单、记当天、通知开发者", async () => {
  const sent = [];
  const e = env({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_ID: "c",
    TELEGRAM_FETCH: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response("{}");
    },
  });
  const r = await handle(post(), e);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: meta.id });
  const prefix = keyPrefix(meta.id);
  assert.equal(prefix, `feedback/2026/11/20/${meta.id}/`);
  const stored = JSON.parse(await (await e.BUCKET.get(`${prefix}manifest.json`)).text());
  assert.equal(stored.preview, "日常跑到一半停了，基建没做完");
  assert.equal(stored.received_at, "2026-11-20T16:00:00.000Z");
  assert.deepEqual(stored.files, ["feedback.json", "session-raw.txt", "session.md", "shots/1.png"]);
  const zip = (await e.BUCKET.get(`${prefix}bundle.zip`)).body;
  assert.equal(await sha256Hex(zip), stored.sha256);
  assert.ok(e.BUCKET.objects.has(`days/2026-11-20/${meta.id}`));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, "c");
  assert.match(sent[0].body.text, /新反馈 \[bug\]/);
  assert.match(sent[0].body.text, /日常跑到一半停了/);
  assert.equal(sent[0].body.parse_mode, undefined);
  // 存下来的东西里没有 IP
  for (const [, bytes] of e.BUCKET.objects) assert.ok(!new TextDecoder("latin1").decode(bytes).includes("203.0.113.9"));
});

test("原样重发算已经收下；同一个编号换了内容拒绝", async () => {
  const e = env();
  assert.equal((await handle(post(), e)).status, 200);
  const again = await handle(post(), e);
  assert.deepEqual(await again.json(), { ok: true, id: meta.id, duplicate: true });
  // 同一个编号已经存着另一份内容
  const taken = env();
  await taken.BUCKET.put(`${keyPrefix(meta.id)}manifest.json`, JSON.stringify({ sha256: "f".repeat(64) }));
  const other = await handle(post(), taken);
  assert.equal(other.status, 409);
  assert.equal((await other.json()).error, "id_taken");
  assert.ok(!taken.BUCKET.objects.has(`${keyPrefix(meta.id)}bundle.zip`));
  assert.equal([...e.BUCKET.objects.keys()].filter((k) => k.endsWith("bundle.zip")).length, 1);
});

test("没带客户端的请求头、不是 multipart、路径不对：不收", async () => {
  const e = env();
  assert.equal((await handle(post(body, { "x-maapilot-feedback": "" }), e)).status, 400);
  assert.equal((await handle(post(body, { "content-type": "application/json" }), e)).status, 400);
  assert.equal((await handle(new Request("https://x/other", { method: "POST", body: "x" }), e)).status, 404);
  assert.equal((await handle(new Request("https://x/feedback", { method: "PUT", body: "x" }), e)).status, 404);
  assert.equal(e.BUCKET.objects.size, 0);
});

test("太大：声明的长度和实际读到的都卡", async () => {
  const e = env({ MAX_BYTES: "100" });
  assert.equal((await handle(post(body, { "content-length": String(10 * 1024 * 1024) }), e)).status, 413);
  assert.equal((await handle(post(), e)).status, 413); // 包本身超过 100 字节
  const big = new Uint8Array(200 * 1024);
  assert.equal((await handle(post(big), e)).status, 413); // 请求体超过上限加余量，读到一半就停
  assert.equal(e.BUCKET.objects.size, 0);
});

test("限流和每日上限", async () => {
  const limited = env({ LIMITER: { limit: async ({ key }) => ({ success: key !== "203.0.113.9" }) } });
  const r = await handle(post(), limited);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "rate_limited");
  assert.equal(limited.BUCKET.objects.size, 0);

  const full = env({ DAILY_MAX: "2" });
  await full.BUCKET.put("days/2026-11-20/fb-20261120-000001-aaaa", "");
  await full.BUCKET.put("days/2026-11-20/fb-20261120-000002-bbbb", "");
  const d = await handle(post(), full);
  assert.equal(d.status, 429);
  assert.equal((await d.json()).error, "daily_limit");
  assert.equal(full.BUCKET.objects.size, 2);
});

const bad = [
  ["编号格式不对", (m) => void (m.id = "../../etc"), "bad_id"],
  ["编号里的日期离今天太远", (m) => void (m.id = "fb-20250101-000000-abcd"), "bad_id"],
  ["类别不认识", (m) => void (m.category = "spam"), "bad_category"],
  ["清单里有不该有的文件名", (m) => void m.files.push("../x.sh"), "bad_files"],
  ["截图是 svg", (m) => void m.files.push("shots/2.svg"), "bad_files"],
  ["截图后缀大写", (m) => void m.files.push("shots/2.JPG"), "bad_files"],
  ["截图名后面还有别的后缀", (m) => void m.files.push("shots/2.jpg.exe"), "bad_files"],
  ["清单里的大小不对", (m) => void (m.bytes += 1), "size_mismatch"],
  ["哈希不对", (m) => void (m.sha256 = "0".repeat(64)), "hash_mismatch"],
  ["清单的文件和包里的不一样", (m) => void (m.files = ["feedback.json"]), "files_mismatch"],
  ["版本不对", (m) => void (m.schema = 99), "bad_schema"],
];
for (const [name, change, code] of bad) {
  test(`拒绝：${name}`, async () => {
    const e = env();
    const r = await handle(await rebuilt(change), e);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, code);
    assert.equal(e.BUCKET.objects.size, 0);
  });
}

// 文件名过了白名单才会走到"和包里的对不上"这一步：包里没有这张图，所以是 files_mismatch 而不是 bad_files
for (const ext of ["png", "jpg", "jpeg", "webp"]) {
  test(`截图文件名认 .${ext}`, async () => {
    const r = await handle(await rebuilt((m) => void m.files.push(`shots/2.${ext}`)), env());
    assert.equal((await r.json()).error, "files_mismatch");
  });
}

test("不是 zip 的包不收", async () => {
  const junk = new TextEncoder().encode("this is not a zip file, just some text padding".repeat(2));
  const r = await handle(
    await rebuilt(async (m) => {
      m.bytes = junk.length;
      m.sha256 = await sha256Hex(junk);
      return { bundle: junk };
    }),
    env(),
  );
  assert.equal((await r.json()).error, "bad_zip");
});

test("zipEntries 读出目录", async () => {
  const form = await new Response(body, { headers: { "content-type": meta.content_type } }).formData();
  const bundle = new Uint8Array(await form.get("bundle").arrayBuffer());
  const entries = zipEntries(bundle);
  assert.deepEqual(entries.map((e) => e.name).sort(), ["feedback.json", "session-raw.txt", "session.md", "shots/1.png"]);
  assert.ok(entries.every((e) => e.size > 0));
  assert.equal(zipEntries(new Uint8Array(30)), null);
  assert.equal(await checkSubmission(null, bundle, new Date(NOW)), "bad_manifest");
});

test("Telegram 发不出去不影响收反馈；没配就不发", async () => {
  const failing = env({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_ID: "c",
    TELEGRAM_FETCH: async () => {
      throw new Error("down");
    },
  });
  assert.equal((await handle(post(), failing)).status, 200);
  assert.equal((await handle(post(), env())).status, 200);
});

test("通知的文字", () => {
  const text = notifyText({
    category: "idea",
    preview: "希望能改一下 *日常* 的时间",
    id: "fb-20261120-233323-33e1",
    maapilot: "0.3.2",
    bytes: 2048,
    files: ["feedback.json", "session.md", "shots/1.png"],
  });
  assert.equal(text.split("\n")[0], "MaaPilot 新反馈 [idea]");
  assert.match(text, /\*日常\*/);
  assert.match(text, /2 KB · 另带 shots\/1\.png/);
});

test("取回要密钥：没有或不对都当不存在", async () => {
  const e = env({ ADMIN_TOKEN: "s3cret-admin" });
  await handle(post(), e);
  const url = `https://feedback.example/feedback/${meta.id}`;
  assert.equal((await handle(new Request(url), e)).status, 404);
  assert.equal((await handle(new Request(url, { headers: { authorization: "Bearer wrong" } }), e)).status, 404);
  const ok = await handle(new Request(url, { headers: { authorization: "Bearer s3cret-admin" } }), e);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/zip");
  const list = await handle(
    new Request("https://feedback.example/feedback?day=2026-11-20", { headers: { authorization: "Bearer s3cret-admin" } }),
    e,
  );
  const items = (await list.json()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, meta.id);
  // 没配 ADMIN_TOKEN 的部署：取回接口整个不可用
  const none = env();
  await handle(post(), none);
  assert.equal((await handle(new Request(url, { headers: { authorization: "Bearer " } }), none)).status, 404);
});
