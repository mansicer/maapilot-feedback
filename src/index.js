// MaaPilot 反馈接收：POST /feedback 收一份反馈（清单 + zip 包），校验后存进 R2，再通知开发者。
// 上传协议由客户端定（MaaPilot 仓库 docs/cli.md「feedback」）：multipart/form-data，字段 manifest（JSON）和 bundle（zip）。
// 不保存提交者的 IP：IP 只在限流时用一下。

export const DEFAULTS = {
  MAX_BYTES: 5 * 1024 * 1024, // 包的上限，和客户端一致
  DAILY_MAX: 200, // 一天最多收多少份（防换着 IP 灌数据）
  MAX_UNPACKED: 50 * 1024 * 1024, // 包里声明的解压后总大小上限
  MAX_FILES: 12,
};

const SCHEMA = 1;
const ID_RE = /^fb-(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4}$/;
const CATEGORIES = new Set(["bug", "experience", "idea", "other"]);
// 客户端会产生的文件名，别的一律不收
const FILE_RE = /^(feedback\.json|session\.md|session-raw\.txt|maa-log\.txt|shots\/[1-9]\.png)$/;
const MULTIPART_OVERHEAD = 64 * 1024;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.error("unhandled", e && e.message);
      return json(500, { ok: false, error: "internal" });
    }
  },
};

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/feedback" && request.method === "POST") return receive(request, env, ctx);
  if (path === "/feedback" && request.method === "GET") return adminList(request, env, url);
  const m = /^\/feedback\/(fb-[0-9a-f-]+)$/.exec(path);
  if (m && request.method === "GET") return adminGet(request, env, m[1]);
  if (path === "/" && request.method === "GET") {
    return new Response("MaaPilot feedback endpoint. See https://github.com/mansicer/MaaPilot\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return json(404, { ok: false, error: "not_found" });
}

function limits(env) {
  const num = (k) => (Number(env[k]) > 0 ? Number(env[k]) : DEFAULTS[k]);
  return { maxBytes: num("MAX_BYTES"), dailyMax: num("DAILY_MAX") };
}

// --- 接收 ------------------------------------------------------------------------------------

async function receive(request, env, ctx) {
  const { maxBytes, dailyMax } = limits(env);
  if (request.headers.get("x-maapilot-feedback") !== String(SCHEMA)) return json(400, { ok: false, error: "bad_client" });
  const ctype = request.headers.get("content-type") || "";
  if (!ctype.toLowerCase().startsWith("multipart/form-data")) return json(400, { ok: false, error: "bad_content_type" });
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes + MULTIPART_OVERHEAD) return json(413, { ok: false, error: "too_big" });

  if (env.LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return json(429, { ok: false, error: "rate_limited" });
  }

  const body = await readCapped(request, maxBytes + MULTIPART_OVERHEAD);
  if (body === null) return json(413, { ok: false, error: "too_big" });

  let form;
  try {
    form = await new Response(body, { headers: { "content-type": ctype } }).formData();
  } catch {
    return json(400, { ok: false, error: "bad_form" });
  }
  const manifestText = form.get("manifest");
  const file = form.get("bundle");
  if (typeof manifestText !== "string" || !file || typeof file === "string") return json(400, { ok: false, error: "bad_form" });

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return json(400, { ok: false, error: "bad_manifest" });
  }
  const bundle = new Uint8Array(await file.arrayBuffer());
  if (bundle.length > maxBytes) return json(413, { ok: false, error: "too_big" });

  const now = env.NOW ? new Date(env.NOW) : new Date(); // NOW：测试里固定时间
  const problem = await checkSubmission(manifest, bundle, now);
  if (problem) return json(400, { ok: false, error: problem });

  const prefix = keyPrefix(manifest.id);
  const existing = await env.BUCKET.get(`${prefix}manifest.json`);
  if (existing) {
    // 客户端断线后会原样重发：内容一样就当已经收下
    let old = {};
    try {
      old = JSON.parse(await existing.text());
    } catch {
      old = {};
    }
    if (old.sha256 === manifest.sha256) return json(200, { ok: true, id: manifest.id, duplicate: true });
    return json(409, { ok: false, error: "id_taken" });
  }

  const day = now.toISOString().slice(0, 10);
  const today = await env.BUCKET.list({ prefix: `days/${day}/`, limit: 1000 });
  if (today.objects.length >= dailyMax) return json(429, { ok: false, error: "daily_limit" });

  const stored = {
    schema: SCHEMA,
    id: manifest.id,
    created_at: str(manifest.created_at, 40),
    received_at: now.toISOString(),
    category: manifest.category,
    maapilot: str(manifest.maapilot, 40),
    digest: str(manifest.digest, 64),
    preview: str(manifest.preview, 200),
    bytes: bundle.length,
    sha256: manifest.sha256,
    files: manifest.files,
  };
  await env.BUCKET.put(`${prefix}bundle.zip`, bundle, { httpMetadata: { contentType: "application/zip" } });
  await env.BUCKET.put(`${prefix}manifest.json`, JSON.stringify(stored, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.BUCKET.put(`days/${day}/${manifest.id}`, "");

  const note = notify(env, stored);
  if (ctx && ctx.waitUntil) ctx.waitUntil(note);
  else await note;
  return json(200, { ok: true, id: manifest.id });
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : null;
}

/** 读请求体，超过 cap 字节就不读了，返回 null。 */
async function readCapped(request, cap) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 清单和包对不对得上；有问题返回错误代码，没问题返回 null。 */
export async function checkSubmission(manifest, bundle, now) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "bad_manifest";
  if (manifest.schema !== SCHEMA) return "bad_schema";
  const m = typeof manifest.id === "string" ? ID_RE.exec(manifest.id) : null;
  if (!m) return "bad_id";
  const idDay = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(idDay) || Math.abs(now.getTime() - idDay) > 3 * 86400_000) return "bad_id"; // 编号里的日期离今天太远
  if (!CATEGORIES.has(manifest.category)) return "bad_category";
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) return "bad_manifest";
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > DEFAULTS.MAX_FILES) {
    return "bad_files";
  }
  if (!manifest.files.every((f) => typeof f === "string" && FILE_RE.test(f))) return "bad_files";
  if (!manifest.files.includes("feedback.json")) return "bad_files";
  if (manifest.bytes !== bundle.length) return "size_mismatch";
  if ((await sha256Hex(bundle)) !== manifest.sha256) return "hash_mismatch";

  const entries = zipEntries(bundle);
  if (!entries) return "bad_zip";
  const names = entries.map((e) => e.name).sort();
  const want = [...manifest.files].sort();
  if (names.length !== want.length || names.some((n, i) => n !== want[i])) return "files_mismatch";
  if (entries.reduce((s, e) => s + e.size, 0) > DEFAULTS.MAX_UNPACKED) return "too_big_unpacked";
  return null;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** zip 的目录：[{name, size（解压后）}]；不是 zip、目录坏了返回 null。只看目录，不解压。 */
export function zipEntries(bytes) {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    if (at + 46 + nameLen > bytes.length) return null;
    let name;
    try {
      name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    } catch {
      return null;
    }
    out.push({ name, size });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function keyPrefix(id) {
  const m = ID_RE.exec(id);
  return `feedback/${m[1]}/${m[2]}/${m[3]}/${id}/`;
}

// --- 通知 ------------------------------------------------------------------------------------

export function notifyText(m) {
  const kb = Math.max(1, Math.round(m.bytes / 1024));
  const extra = m.files.filter((f) => f !== "feedback.json" && f !== "session.md");
  return [
    `MaaPilot 新反馈 [${m.category}]`,
    m.preview || "（没有预览）",
    "",
    `编号 ${m.id}`,
    `版本 ${m.maapilot || "?"} · ${kb} KB` + (extra.length ? ` · 另带 ${extra.join("、")}` : ""),
  ].join("\n");
}

/** 发 Telegram；没配 token 就不发。发不出去不影响收反馈。 */
async function notify(env, manifest) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const send = env.TELEGRAM_FETCH || fetch;
    const r = await send(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 纯文本：不给 parse_mode，预览里的符号不会被当成格式
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: notifyText(manifest), disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("telegram", r.status);
  } catch (e) {
    console.error("telegram", e && e.message);
  }
}

// --- 开发者取回（要 ADMIN_TOKEN） ---------------------------------------------------------------

async function authorized(request, env) {
  const want = env.ADMIN_TOKEN;
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!want || !got) return false;
  // 比哈希：不泄露长度，比较时间也和内容无关
  const [a, b] = await Promise.all([sha256Hex(new TextEncoder().encode(want)), sha256Hex(new TextEncoder().encode(got))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function adminGet(request, env, id) {
  if (!(await authorized(request, env))) return json(404, { ok: false, error: "not_found" });
  if (!ID_RE.test(id)) return json(404, { ok: false, error: "not_found" });
  const obj = await env.BUCKET.get(`${keyPrefix(id)}bundle.zip`);
  if (!obj) return json(404, { ok: false, error: "not_found" });
  return new Response(obj.body, {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${id}.zip"` },
  });
}

async function adminList(request, env, url) {
  if (!(await authorized(request, env))) return json(404, { ok: false, error: "not_found" });
  const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, { ok: false, error: "bad_day" });
  const listed = await env.BUCKET.list({ prefix: `days/${day}/`, limit: 1000 });
  const items = [];
  for (const o of listed.objects) {
    const id = o.key.split("/").pop();
    if (!ID_RE.test(id)) continue;
    const m = await env.BUCKET.get(`${keyPrefix(id)}manifest.json`);
    if (m) items.push(JSON.parse(await m.text()));
  }
  return json(200, { ok: true, day, items });
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
