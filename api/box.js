// Saves and loads parcels.
// Works with either storage option from the Vercel Marketplace:
//   • Upstash (REST keys like KV_REST_API_URL / UPSTASH_REDIS_REST_URL, any prefix)
//   • Redis (a REDIS_URL connection string, any prefix)
// Visit /api/box?check=1 on your site to see which one it found.

const ONE_YEAR = 60 * 60 * 24 * 365;
const MAX_BYTES = 4_000_000;

function findEnv(suffixes) {
  for (const [k, v] of Object.entries(process.env)) {
    if (v && suffixes.some((s) => k === s || k.endsWith("_" + s))) return { key: k, value: v };
  }
  return null;
}
function storageConfig() {
  const restUrl = findEnv(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL", "REDIS_REST_URL"]);
  if (restUrl) {
    const prefix = restUrl.key.replace(/(KV_REST_API_URL|UPSTASH_REDIS_REST_URL|REDIS_REST_URL)$/, "");
    const tok =
      process.env[prefix + "KV_REST_API_TOKEN"] || process.env[prefix + "UPSTASH_REDIS_REST_TOKEN"] ||
      process.env[prefix + "REDIS_REST_TOKEN"] || findEnv(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"])?.value;
    if (tok) return { kind: "rest", url: restUrl.value, token: tok, found: restUrl.key };
  }
  const tcp = findEnv(["REDIS_URL", "KV_URL"]);
  if (tcp && /^rediss?:\/\//.test(tcp.value)) return { kind: "redis", url: tcp.value, found: tcp.key };
  return { kind: "none" };
}

// Tiny built-in Redis client (no packages to install).
import net from "node:net";
import tls from "node:tls";
function redisCmd(url, cmds) {
  const u = new URL(url);
  const enc = (args) => {
    let out = `*${args.length}\r\n`;
    for (const a of args) { const b = Buffer.from(String(a)); out += `$${b.length}\r\n` + b.toString("binary") + "\r\n"; }
    return Buffer.from(out, "binary");
  };
  const pre = [];
  const pass = decodeURIComponent(u.password || "");
  if (pass) pre.push(u.username ? ["AUTH", decodeURIComponent(u.username), pass] : ["AUTH", pass]);
  const all = [...pre, ...cmds];
  return new Promise((resolve, reject) => {
    const opts = { host: u.hostname, port: Number(u.port || 6379) };
    const sock = u.protocol === "rediss:" ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
    let buf = Buffer.alloc(0); const results = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("couldn't reach Redis (timed out). Check the address and port.")); }, 9000);
    const parse = () => {
      while (results.length < all.length) {
        const nl = buf.indexOf("\r\n"); if (nl < 0) return;
        const t = String.fromCharCode(buf[0]), line = buf.slice(1, nl).toString();
        if (t === "+" || t === ":") { results.push(line); buf = buf.slice(nl + 2); }
        else if (t === "-") { clearTimeout(timer); sock.destroy(); return reject(new Error(line)); }
        else if (t === "$") {
          const n = parseInt(line, 10);
          if (n < 0) { results.push(null); buf = buf.slice(nl + 2); continue; }
          if (buf.length < nl + 2 + n + 2) return;
          results.push(buf.slice(nl + 2, nl + 2 + n).toString("utf8")); buf = buf.slice(nl + 2 + n + 2);
        } else { clearTimeout(timer); sock.destroy(); return reject(new Error("unexpected reply from Redis")); }
      }
      clearTimeout(timer); sock.end(); resolve(results[results.length - 1]);
    };
    sock.on(u.protocol === "rediss:" ? "secureConnect" : "connect", () => sock.write(Buffer.concat(all.map(enc))));
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
    sock.on("error", (e) => { clearTimeout(timer); reject(new Error("couldn't reach Redis: " + e.message)); });
  });
}
async function setVal(cfg, key, val) {
  if (cfg.kind === "rest") return rest(cfg, ["SET", key, val, "EX", ONE_YEAR]);
  return redisCmd(cfg.url, [["SET", key, val, "EX", ONE_YEAR]]);
}
async function getVal(cfg, key) {
  if (cfg.kind === "rest") return rest(cfg, ["GET", key]);
  return redisCmd(cfg.url, [["GET", key]]);
}
async function rest(cfg, cmd) {
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `storage replied ${r.status}`);
  return j.result;
}
function newId() {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => a[b % a.length]).join("");
}
async function readBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  let s = ""; for await (const chunk of req) s += chunk; return s;
}

export default async function handler(req, res) {
  const cfg = storageConfig();
  const fail = (code, error) => res.status(code).json({ error });

  if (req.method === "GET" && req.query.check) {
    if (cfg.kind === "none") return res.status(200).json({ ok: false, storage: "none", fix: "In Vercel, open Storage, create Upstash Redis (or Redis), connect it to this project, then redeploy." });
    try { await setVal(cfg, "parcel:healthcheck", "ok"); return res.status(200).json({ ok: true, storage: cfg.kind, using: cfg.found }); }
    catch (e) { return res.status(200).json({ ok: false, storage: cfg.kind, using: cfg.found, error: String(e.message || e) }); }
  }
  if (cfg.kind === "none") return fail(503, "Storage isn't connected yet. In Vercel: Storage → create a Redis database → connect it to this project → redeploy.");

  try {
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw.length > MAX_BYTES) return fail(413, "This box is too heavy. Try a smaller photo.");
      let box; try { box = JSON.parse(raw); } catch { return fail(400, "The box didn't arrive in one piece. Try again."); }
      if (!box || !box.to) return fail(400, "Add their name before sending.");
      const id = newId();
      await setVal(cfg, `parcel:${id}`, raw);
      return res.status(200).json({ id });
    }
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!/^[a-z0-9]{10,24}$/.test(id)) return fail(400, "That link looks incomplete.");
      const raw = await getVal(cfg, `parcel:${id}`);
      if (!raw) return fail(404, "not found");
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(raw);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  } catch (e) {
    return fail(500, "Storage error: " + String(e.message || e));
  }
}
