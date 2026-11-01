/**
 * dsh-mem / lib/core.mjs — 零依赖本地记忆层的唯一实现（只 import node:*）。
 *
 * 从 skills/dsh-mem/scripts/mem.mjs 原样搬入（逻辑未改），只做三件事：
 *   1. 去掉 CLI 入口（搬到 bin/dsh-mem.mjs），改为导出函数；
 *   2. 加入隐私闸（redact / excludePaths），写路径与 ingest --file 共用 insertRows()；
 *   3. storeDir 可配置（默认仍是 <DSH_HOME>/mem，旧库路径逐字节不变）。
 *
 * 真相源 : <DSH_HOME>/sessions/--<workspace-slug>--/<sessionId>/session.v4.jsonl.zstd （只读）
 * 派生库 : <storeDir>/<hash8>-<dir>.db                                             （可删可重建）
 *
 * I1 原文永不改写  turn.text 是源记录 content[].text 的逐字镜像，只 INSERT OR IGNORE。
 * I2 索引可丢弃    删 db 重跑 ingest 100% 重建；没有"只有库里才有"的事实。
 * I3 只回指针+切片 search 返回 (sessionId, seq) + 原文子串；不摘要/不转述/不推断。
 *
 * 退出码: 0 正常 | 1 用法错 | 2 指针不存在 | 3 读不到输入(目录/库/空库) | 4 解压或数据损坏
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

export const SNIPPET = 120;   // 切片硬上限（规格 §3.5）
export const POOL = 40;       // 每条 SQL 先取多少候选，再在 JS 里合并排序
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export class AppError extends Error {
  constructor(msg, code = 1) { super(msg); this.exitCode = code; }
}

// ───────────────────────────── 路径与工作区 ─────────────────────────────
export const slugify = (p) => String(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const normWorkspace = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
export const sessionDirName = (ws) => `--${slugify(normWorkspace(ws))}--`;
export const homeDir = (o = {}) => path.resolve(o.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));

// DSH 把非 ASCII 字符写成 ~XXXX（UTF-16 码元），用它做模糊匹配才能认中文工作区
const unTilde = (s) => s.replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const looseKey = (s) => unTilde(String(s)).toLowerCase().replace(/[^a-z0-9\u0080-\uffff]+/g, '');

export function sessionsDirOf(home, ws) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) throw new AppError(`sessions 目录不存在: ${root}\n  DSH_HOME=${home} 下没有任何会话记录`, 3);
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const exact = sessionDirName(ws);
  if (dirs.includes(exact)) return path.join(root, exact);
  const want = looseKey(normWorkspace(ws));
  const hit = dirs.find((d) => looseKey(d.replace(/^-+|-+$/g, '')) === want);
  if (hit) return path.join(root, hit);
  throw new AppError(
    `找不到工作区的会话目录。workspace=${normWorkspace(ws)}\n` +
    `  期望: sessions/${exact}\n  现有候选:\n    ${dirs.join('\n    ')}`, 3);
}

/** storeDir 缺省 = <home>/mem（老库路径不变）；`dsh-mem --store-dir` 可改。 */
export function dbPathOf(home, ws, storeDir) {
  const key = normWorkspace(ws).toLowerCase();
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  const name = slugify(path.basename(normWorkspace(ws))) || 'ws';
  const dir = storeDir ? path.resolve(storeDir) : path.join(home, 'mem');
  return path.join(dir, `${hash}-${name}.db`);
}

// ───────────────────────────── 隐私闸 ─────────────────────────────
export function compileRedact(patterns = []) {
  return (patterns || []).filter(Boolean).map((p) => {
    try { return new RegExp(p, 'g'); }
    catch (e) { throw new AppError(`非法 redact 正则 ${JSON.stringify(p)}: ${e.message}`, 1); }
  });
}

/** 命中即把整段匹配替换成 [redacted]；返回是否命中，供 --dry-run 报数。 */
export function redactText(text, compiled = []) {
  let hit = false;
  let out = text;
  for (const re of compiled) {
    re.lastIndex = 0;
    out = out.replace(re, () => { hit = true; return '[redacted]'; });
  }
  return { text: out, hit };
}

const normSlashes = (s) => String(s).replace(/\\/g, '/');
const escapeRe = (ch) => ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** 极简 glob：** → 任意路径，* → 段内任意，? → 单字符；不区分大小写。 */
export function globToRegExp(pattern) {
  const s = normSlashes(pattern);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '*') {
      if (s[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += escapeRe(ch);
  }
  return new RegExp(`^${out}$`, 'i');
}

export function compileExclude(patterns = []) {
  return (patterns || []).filter(Boolean).map(globToRegExp);
}

/** 任一路径候选（会话 id / 会话目录 / 文件绝对路径）命中任一 pattern 即跳过。 */
export function isExcluded(candidates, patterns = []) {
  const res = compileExclude(patterns);
  if (!res.length) return false;
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean).map(normSlashes);
  return list.some((c) => res.some((re) => re.test(c)));
}

// ───────────────────────────── 解压（多帧 zstd） ─────────────────────────────
//
// Node 的 zstdDecompressSync 对多帧一次解完，尾帧被截断时抛 Z_BUF_ERROR
// （实测：17B + 8B 半帧 → Z_BUF_ERROR，不会静默吐半截）。逐帧 fallback 只在它抛错后跑；
// 此时任何一帧解不开都必须报错，只有"最后一帧不完整"可带 partialTail 标记放行，
// 由调用方告警 + 不推进水位（下次 ingest 重读补全），绝不静默丢数据。
export function decodeZstd(buf, label, { allowPartialTail = false } = {}) {
  const starts = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 4)) starts.push(i);
  if (!starts.length) throw new AppError(`${label}: 不是 zstd 流（找不到帧魔数）`, 4);

  let fastErr = null;
  try {
    return { buf: zlib.zstdDecompressSync(buf), frames: starts.length, mode: 'single-call', partialTail: false };
  } catch (e) { fastErr = e; }

  const parts = [];
  const bad = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))); }
    catch (err) { bad.push({ frame: k, at: s, len: e - s, msg: err.message }); }
  }
  const midBad = bad.filter((b) => b.frame !== starts.length - 1);
  if (midBad.length)
    throw new AppError(`${label}: 中间帧解码失败（继续下去会静默丢数据）: ${JSON.stringify(midBad)}`, 4);
  const partialTail = bad.length === 1;
  if (partialTail && !allowPartialTail)
    throw new AppError(`${label}: 尾帧不完整 at byte ${bad[0].at} (${bad[0].len}B, ${bad[0].msg}) —— 文件可能正在写或已被截断`, 4);

  const out = Buffer.concat(parts);
  if (out.length && out[out.length - 1] !== 0x0a)
    throw new AppError(`${label}: 解压输出不以换行结尾（半条记录），拒绝入库。单次解压错误: ${fastErr.message}`, 4);
  return { buf: out, frames: starts.length, mode: 'per-frame', partialTail };
}

// ───────────────────────────── 抽取（R1/R2/R3，零 LLM） ─────────────────────────────
const DECIDE = /决定|采用|不要|必须|固定为|定为|最后选|结论/;
const EVIDENCE = /[A-Z]:\\|\/[A-Za-z0-9_.\-]+\/|https?:\/\/|\bv?\d+\.\d+/;
const VERIFY = /实测|验证|跑通|报错|退出码/;

export function factScore(text) {
  let s = 0;
  if (DECIDE.test(text)) s += 2;
  if (EVIDENCE.test(text)) s += 1;
  if (VERIFY.test(text)) s += 1;
  const len = [...text].length;
  if (len >= 40 && len <= 2000) s += 1;
  if (/[？?]\s*$/.test(text) && !/[。；;]/.test(text)) s -= 1;   // 纯提问无陈述句
  return s;
}

export function parseSession(sessionId, buf) {
  const rows = [];
  const c = { lines: 0, badJson: 0, user: 0, asst: 0, dropped: 0 };
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    c.lines++;
    let o;
    try { o = JSON.parse(line); } catch { c.badJson++; continue; }

    if (o.type === 'user/message') {                            // R1：只要 source.kind==='user'
      const kind = o.data?.source?.kind ?? 'none';
      if (kind !== 'user' || typeof o.seq !== 'number') { c.dropped++; continue; }
      const text = (o.data?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
      if (!text) { c.dropped++; continue; }
      rows.push({ session: sessionId, seq: o.seq, role: 'user', ts: o.time ?? 0, turnNo: null, kind, text });
      c.user++;
    } else if (o.type === 'assistant/message') {                 // R2：只要可见正文
      const text = (o.data?.message?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
      if (!text || typeof o.seq !== 'number') { c.dropped++; continue; }
      rows.push({ session: sessionId, seq: o.seq, role: 'asst', ts: o.time ?? 0, turnNo: o.data?.turn ?? null,
        kind: o.data?.message?.source?.kind ?? 'model', text });
      c.asst++;
    }
  }
  rows.sort((a, b) => a.seq - b.seq);
  return { rows, c };
}

// ───────────────────────────── 建库 / 打开库 ─────────────────────────────
export const DDL = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS turn(
  id      INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  role    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  turn_no INTEGER,
  text    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  tags    TEXT NOT NULL DEFAULT '|agent|',
  UNIQUE(session, seq)
);
CREATE INDEX IF NOT EXISTS turn_ts  ON turn(ts);
CREATE INDEX IF NOT EXISTS turn_tag ON turn(tags);

CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
  text, content='turn', content_rowid='id', tokenize='trigram'
);
-- INSERT OR IGNORE 被约束挡下时不触发触发器，所以 FTS 与 turn 天然同步、不会重复
CREATE TRIGGER IF NOT EXISTS turn_ai AFTER INSERT ON turn BEGIN
  INSERT INTO turn_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS turn_ad AFTER DELETE ON turn BEGIN
  INSERT INTO turn_fts(turn_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TABLE IF NOT EXISTS fact(
  id       INTEGER PRIMARY KEY,
  tags     TEXT NOT NULL,
  anchor   INTEGER NOT NULL REFERENCES turn(id),
  score    INTEGER NOT NULL,
  created  INTEGER NOT NULL,
  last_hit INTEGER NOT NULL,
  hits     INTEGER NOT NULL DEFAULT 0,
  retires  INTEGER
);
CREATE INDEX IF NOT EXISTS fact_live ON fact(tags, retires, last_hit);

CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`;

export function openDb(dbp, { mustExist = true } = {}) {
  if (mustExist && !fs.existsSync(dbp)) {
    const home = path.dirname(path.dirname(dbp));
    const why = fs.existsSync(home) ? '' : `\n  DSH_HOME 目录不存在: ${home}（检查 DSH_HOME 环境变量 / --home）`;
    throw new AppError(`no index: ${dbp}${why}\n  库里还没有任何东西。先跑: dsh-mem ingest`, 3);
  }
  fs.mkdirSync(path.dirname(dbp), { recursive: true });
  const db = new DatabaseSync(dbp);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(DDL);
  db.prepare(`INSERT INTO meta(k, v) VALUES ('schema_version','1') ON CONFLICT(k) DO NOTHING`).run();
  return db;
}

export const dbBytes = (dbp) =>
  ['', '-wal', '-shm'].reduce((n, s) => n + (fs.existsSync(dbp + s) ? fs.statSync(dbp + s).size : 0), 0);

export const turnCount = (db) => db.prepare('SELECT count(*) AS c FROM turn').get().c;

// ───────────────────────────── 写锁（并发 ingest） ─────────────────────────────
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 60000) { fs.rmSync(lockPath, { force: true }); continue; }
      } catch { continue; }
      return false;
    }
  }
  return false;
}

// ───────────────────────────── 插入（唯一写路径） ─────────────────────────────
/**
 * 所有写入都经过这里：会话 ingest、NDJSON import、ingest --file 共用同一套
 * redact / exclude / 事实打分 / 幂等语义，不许各写一套。
 *
 * @param rows {session,seq,role,ts,turnNo?,text,kind?,tags?}[]
 * @returns {{inserted:number, redacted:number, skipped:number, facts:number}}
 */
export function insertRows(db, rows, { tags = '|agent|', redact = [], excludePaths = [], now = Date.now() } = {}) {
  const compiled = compileRedact(redact);
  const out = { inserted: 0, redacted: 0, skipped: 0, facts: 0 };
  const insTurn = db.prepare(`INSERT OR IGNORE INTO turn(session, seq, role, ts, turn_no, text, kind, tags)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFact = db.prepare(`INSERT INTO fact(tags, anchor, score, created, last_hit, hits) VALUES (?, ?, ?, ?, ?, 0)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      if (isExcluded([r.session, r.file], excludePaths)) { out.skipped++; continue; }
      const rd = redactText(r.text, compiled);
      const res = insTurn.run(r.session, r.seq, r.role, r.ts, r.turnNo ?? null, rd.text, r.kind ?? 'file', r.tags ?? tags);
      if (!res.changes) continue;                       // 已存在 → 永不改写（I1）
      out.inserted++;
      if (rd.hit) out.redacted++;
      const score = factScore(rd.text);
      if (score >= 3) { insFact.run(tags, Number(res.lastInsertRowid), score, now, now); out.facts++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
  return out;
}

// ───────────────────────────── ingest ─────────────────────────────
function listSessionFiles(sdir) {
  return fs.readdirSync(sdir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = path.join(sdir, d.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) return null;
      const st = fs.statSync(f);
      return { id: d.name, file: f, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function ingest(ctx, { all = false, log = () => {}, excludePaths = [], redact = [], dryRun = false } = {}) {
  const t0 = performance.now();
  const sdir = sessionsDirOf(ctx.home, ctx.ws);
  const files = listSessionFiles(sdir);
  if (!files.length) throw new AppError(`no session/ 文件: ${sdir}`, 3);

  const totals = { sessions: files.length, parsed: 0, skippedUnchanged: 0, turns: 0, user: 0, asst: 0,
    facts: 0, badJson: 0, dropped: 0, decodedBytes: 0, busySkips: 0, partial: 0, excluded: 0, redacted: 0 };

  if (dryRun) {                                     // 只读：不建库、不抢锁、不写水位
    const compiled = compileRedact(redact);
    const existing = fs.existsSync(ctx.dbp) ? openDb(ctx.dbp) : null;
    const seen = existing ? existing.prepare('SELECT 1 AS x FROM turn WHERE session = ? AND seq = ?') : null;
    try {
      for (const f of files) {
        if (isExcluded([f.id, f.file], excludePaths)) { totals.excluded++; log(`[skip] ${f.id} 命中 excludePaths`); continue; }
        const dec = decodeZstd(fs.readFileSync(f.file), f.id, { allowPartialTail: true });
        totals.decodedBytes += dec.buf.length;
        const { rows, c } = parseSession(f.id, dec.buf);
        totals.parsed++; totals.badJson += c.badJson; totals.dropped += c.dropped;
        if (dec.partialTail) totals.partial++;
        for (const r of rows) {
          if (seen?.get(r.session, r.seq)) continue;   // 已在库里 = 不会新增
          totals.turns++;
          if (redactText(r.text, compiled).hit) totals.redacted++;
        }
      }
    } finally { try { existing?.close(); } catch { /* ignore */ } }
    totals.dryRun = true;
    totals.turnsTotal = existing ? undefined : 0;
    totals.ms = Math.round(performance.now() - t0);
    totals.dbPath = ctx.dbp;
    return totals;
  }

  const lockPath = `${ctx.dbp}.lock`;
  fs.mkdirSync(path.dirname(ctx.dbp), { recursive: true });
  if (!acquireLock(lockPath)) {
    log(`[ingest] 另一个 ingest 正在写 ${ctx.dbp}（锁 ${lockPath}）→ 本轮跳过，稍后重跑即可（幂等）`);
    return { skippedLock: true };
  }

  let db;
  try {
    db = openDb(ctx.dbp, { mustExist: false });
    const tags = `|agent|repo:${slugify(path.basename(normWorkspace(ctx.ws))) || 'ws'}|`;
    const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
    const putMeta = db.prepare(`INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
    const now = Date.now();

    for (const f of files) {
      if (isExcluded([f.id, f.file], excludePaths)) {
        totals.excluded++;
        log(`[skip] ${f.id} 命中 excludePaths（不解析、不入库）`);
        continue;
      }
      let wm = null;
      try { wm = JSON.parse(getMeta.get(`session:${f.id}`)?.v ?? 'null'); } catch { wm = null; }
      if (!all && wm && !wm.partial && wm.size === f.size && wm.mtimeMs === f.mtimeMs) { totals.skippedUnchanged++; continue; }

      const dec = decodeZstd(fs.readFileSync(f.file), f.id, { allowPartialTail: true });
      totals.decodedBytes += dec.buf.length;
      const { rows, c } = parseSession(f.id, dec.buf);
      totals.parsed++;
      totals.badJson += c.badJson;
      totals.dropped += c.dropped;
      if (dec.partialTail) {
        totals.partial++;
        log(`[warn] ${f.id}: 尾帧不完整（文件正在写/被截断），该帧数据未入库；水位不推进，下次 ingest 重读`);
      }

      let res;
      try {
        res = insertRows(db, rows, { tags, redact });
        if (!dec.partialTail)   // 尾帧不完整 → 水位不推进，下次重读补全
          putMeta.run(`session:${f.id}`, JSON.stringify({ size: f.size, mtimeMs: f.mtimeMs, turns: rows.length,
            bytes: dec.buf.length, frames: dec.frames, partial: false, at: now }));
      } catch (e) {
        if (/busy|locked/i.test(e.message)) {
          totals.busySkips++;
          log(`[warn] ${f.id}: db busy（另一个 Worker 在写），跳过本次，下一轮补齐`);
          continue;
        }
        throw e;
      }
      totals.turns += res.inserted;
      totals.facts += res.facts;
      totals.redacted += res.redacted;
      log(`  + ${f.id}  frames=${dec.frames} ${dec.mode}${dec.partialTail ? '(尾帧不完整)' : ''}  `
        + `lines=${c.lines} 新入库=${res.inserted}/${rows.length} facts=${res.facts}`
        + `${res.redacted ? ` redact=${res.redacted}` : ''}  ${(dec.buf.length / 1048576).toFixed(2)} MB`);
    }
    totals.user = db.prepare(`SELECT count(*) c FROM turn WHERE role='user'`).get().c;
    totals.asst = db.prepare(`SELECT count(*) c FROM turn WHERE role='asst'`).get().c;
    totals.turnsTotal = turnCount(db);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 另一个写者在 checkpoint */ }
    totals.ms = Math.round(performance.now() - t0);
    totals.dbBytes = dbBytes(ctx.dbp);
    totals.dbPath = ctx.dbp;
    totals.tags = tags;
    return totals;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    fs.rmSync(lockPath, { force: true });
  }
}

// ───────────────────────────── search ─────────────────────────────
const clean = (s) => s.replace(/\s+/g, ' ').trim();

export function snippetOf(text, terms) {
  const low = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = low.indexOf(t.toLowerCase());
    if (p >= 0 && (pos < 0 || p < pos)) pos = p;
  }
  const start = pos < 0 ? 0 : Math.max(0, pos - 40);
  return (start > 0 ? '…' : '') + clean(text.slice(start, start + SNIPPET));
}

export function search(db, query, k = 8) {
  const t0 = performance.now();
  const total = turnCount(db);
  if (!total) throw new AppError('库是空的（0 条 turn）。先跑: dsh-mem ingest', 3);

  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new AppError('query 为空', 1);
  const long = terms.filter((t) => [...t].length >= 3);   // trigram 只对 ≥3 字符有效
  const short = terms.filter((t) => [...t].length < 3);   // <3 字符走 LIKE 兜底

  const scores = new Map();
  let mode = 'none';

  if (long.length) {
    const phrase = (op) => long.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
    const stmt = db.prepare(`SELECT rowid AS id, bm25(turn_fts) AS s FROM turn_fts
                             WHERE turn_fts MATCH ? ORDER BY rank LIMIT ${POOL}`);
    let rows = stmt.all(phrase('AND'));                 // 精度优先（NEAR 在 trigram 下失效，只能 AND）
    mode = 'AND';
    if (!rows.length && long.length > 1) { rows = stmt.all(phrase('OR')); mode = 'OR'; }
    for (const r of rows) scores.set(r.id, r.s);         // bm25 越负越相关
  }

  if (short.length) {
    const run = (op) =>
      db.prepare(`SELECT id FROM turn WHERE ${short.map(() => 'text LIKE ?').join(` ${op} `)} LIMIT ${POOL}`)
        .all(...short.map((t) => `%${t}%`));
    let rows = run('AND');
    if (!rows.length && short.length > 1) rows = run('OR');
    if (rows.length) mode = mode === 'none' ? 'LIKE' : `${mode}+LIKE`;
    for (const r of rows) if (!scores.has(r.id)) scores.set(r.id, 0);   // 0 > 任何 bm25（负数），排后面
  }

  if (!scores.size) return { query, k, hits: 0, ms: +(performance.now() - t0).toFixed(1), mode, results: [] };

  const ids = [...scores.keys()];
  const ph = ids.map(() => '?').join(',');
  const detail = db.prepare(`SELECT id, session, seq, role, ts, text FROM turn WHERE id IN (${ph})`).all(...ids);
  const factAnchors = new Set(
    db.prepare(`SELECT anchor FROM fact WHERE retires IS NULL AND anchor IN (${ph})`).all(...ids).map((r) => r.anchor));

  // 读路径顺带代谢：命中即 hits+=1（规格 §3.6；只影响排序，绝不产出文本）
  if (factAnchors.size) {
    const list = [...factAnchors];
    db.prepare(`UPDATE fact SET hits = hits + 1, last_hit = ? WHERE retires IS NULL
                AND anchor IN (${list.map(() => '?').join(',')})`).run(Date.now(), ...list);
  }

  const results = detail
    .map((r) => ({
      pointer: `${r.session}#seq=${r.seq}`, session: r.session, seq: r.seq, role: r.role, ts: r.ts,
      score: +(scores.get(r.id) ?? 0).toFixed(4), promoted: factAnchors.has(r.id), snippet: snippetOf(r.text, terms),
    }))
    .sort((a, b) => (b.promoted - a.promoted) || (a.score - b.score) || (b.ts - a.ts))
    .slice(0, k);

  return { query, k, hits: results.length, ms: +(performance.now() - t0).toFixed(1), mode, results };
}

// ───────────────────────────── open ─────────────────────────────
export function parsePointer(ptr) {
  const m = /^(.+?)#(?:seq=?)?(\d+)$/.exec(String(ptr).trim());
  if (!m) throw new AppError(`bad pointer: ${ptr}   期望 <sessionId>#<seq>（也接受 <sessionId>#seq=<n>）`, 1);
  return { session: m[1], seq: Number(m[2]) };
}

export function openPointer(db, ptr, context = 0) {
  if (!turnCount(db)) throw new AppError('库是空的（0 条 turn）。先跑: dsh-mem ingest', 3);
  const { session, seq } = parsePointer(ptr);
  const anchor = db.prepare('SELECT id, session, seq, role, ts, text FROM turn WHERE session = ? AND seq = ?').get(session, seq);
  if (!anchor) {
    let cands = db.prepare('SELECT session, seq FROM turn WHERE session = ? ORDER BY abs(seq - ?) LIMIT 3').all(session, seq);
    if (!cands.length) cands = db.prepare('SELECT session, seq FROM turn ORDER BY ts DESC LIMIT 3').all();
    throw new AppError(`no such pointer: ${session}#seq=${seq}\n  最近候选:\n${cands.map((c) => `    ${c.session}#seq=${c.seq}`).join('\n')}`, 2);
  }
  if (!context) return { anchor: `${session}#seq=${seq}`, session, rows: [anchor], anchorId: anchor.id };
  const before = db.prepare(`SELECT id, seq, role, ts, text FROM turn WHERE session = ?
      AND (ts < ? OR (ts = ? AND id <= ?)) ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(session, anchor.ts, anchor.ts, anchor.id, context + 1).reverse();
  const after = db.prepare(`SELECT id, seq, role, ts, text FROM turn WHERE session = ?
      AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts ASC, id ASC LIMIT ?`)
    .all(session, anchor.ts, anchor.ts, anchor.id, context);
  return { anchor: `${session}#seq=${seq}`, session, rows: [...before, ...after], anchorId: anchor.id };
}

// ───────────────────────────── stats ─────────────────────────────
export function stats(db, dbp) {
  const q = (sql) => db.prepare(sql).get();
  const wm = db.prepare(`SELECT k, v FROM meta WHERE k LIKE 'session:%'`).all().map((r) => {
    let v = {};
    try { v = JSON.parse(r.v); } catch { /* ignore */ }
    return { session: r.k.slice(8), size: v.size ?? 0, mtimeMs: v.mtimeMs ?? 0, turns: v.turns ?? 0, bytes: v.bytes ?? 0 };
  });
  return {
    db: dbp,
    dbBytes: dbBytes(dbp),
    sessions: q('SELECT count(DISTINCT session) AS c FROM turn').c,
    turns: q('SELECT count(*) AS c FROM turn').c,
    user: q(`SELECT count(*) AS c FROM turn WHERE role='user'`).c,
    asst: q(`SELECT count(*) AS c FROM turn WHERE role='asst'`).c,
    firstTs: q('SELECT min(ts) AS t FROM turn').t,
    lastTs: q('SELECT max(ts) AS t FROM turn').t,
    factLive: q('SELECT count(*) AS c FROM fact WHERE retires IS NULL').c,
    factTotal: q('SELECT count(*) AS c FROM fact').c,
    watermark: wm.sort((a, b) => a.mtimeMs - b.mtimeMs),
  };
}

// ───────────────────────────── selftest ─────────────────────────────
export function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-selftest-'));
  const logs = [];
  let pass = 0;
  const ok = (name) => { pass++; console.log(`ok   ${name}`); };
  const home = path.join(tmp, '.dsh');
  const ws = path.join(tmp, 'fixture-workspace');
  const sdir = path.join(home, 'sessions', sessionDirName(ws));
  const lines = (arr) => Buffer.from(arr.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const mkSession = (sid, records, dir = sdir) => {
    const d = path.join(dir, sid);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(lines(records)));
  };

  try {
    fs.mkdirSync(ws, { recursive: true });

    // ── 1. 多帧 zstd ────────────────────────────────────────────────
    const twoFrames = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from('{"a":1}\n')),
      zlib.zstdCompressSync(Buffer.from('{"a":2}\n')),
    ]);
    assert.equal(decodeZstd(twoFrames, 'fixture').buf.toString(), '{"a":1}\n{"a":2}\n', '多帧解压必须拼全');
    ok('decodeZstd 多帧拼接');

    const half = zlib.zstdCompressSync(Buffer.from('{"a":2}\n')).subarray(0, 8);
    const trunc = Buffer.concat([zlib.zstdCompressSync(Buffer.from('{"a":1}\n')), half]);
    assert.throws(() => decodeZstd(trunc, 'fixture'), /尾帧/, '尾帧不完整必须报错而不是静默丢数据');
    assert.equal(decodeZstd(trunc, 'fixture', { allowPartialTail: true }).partialTail, true, '放行时必须打标记');
    ok('decodeZstd 尾帧不完整 → 抛错 / 打标记');

    const midBad = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from('{"a":1}\n')).subarray(0, 8),   // 第 1 帧坏
      zlib.zstdCompressSync(Buffer.from('{"a":2}\n')),                  // 第 2 帧好
    ]);
    assert.throws(() => decodeZstd(midBad, 'fixture', { allowPartialTail: true }), /中间帧/, '中间帧坏必须永远报错');
    ok('decodeZstd 中间帧坏 → 永远报错');

    // ── 2. 抽取规则 R1/R2 ──────────────────────────────────────────
    mkSession('sess-a', [
      { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: '我们决定把 tokenizer 固定为 trigram，实测四层体检可以命中' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 2, time: 1001, data: { content: [{ type: 'text', text: '这是注入的运行时上下文，必须丢掉' }], source: { kind: 'runtime-context' } } },
      { type: 'assistant/message', seq: 3, time: 1002, data: { turn: 1, message: { content: [{ type: 'reasoning', text: '草稿不该入库' }] } } },
      { type: 'assistant/message', seq: 4, time: 1003, data: { turn: 1, message: { content: [{ type: 'text', text: '跑通了，退出码 0，库 1.33 MB' }] } } },
      { type: 'tool/call', seq: 5, time: 1004, data: {} },
      { type: 'user/message', seq: 6, time: 1005, data: { content: [{ type: 'text', text: '另外把 bm25 的使用边界定下来，结论是只在 FTS 表直接查询里用' }], source: { kind: 'user' } } },
    ]);
    mkSession('sess-b', [
      { type: 'user/message', seq: 7, time: 2000, data: { content: [{ type: 'text', text: '提权那段的原话是什么' }], source: { kind: 'user' } } },
    ]);

    const ctx = { home, ws, dbp: dbPathOf(home, ws) };
    const r1 = ingest(ctx, { all: true, log: (s) => logs.push(s) });
    assert.equal(r1.sessions, 2, '应扫到 2 个会话');
    assert.equal(r1.turns, 4, `首次入库 4 条（实际 ${r1.turns}）`);
    assert.equal(r1.dropped, 2, `注入轮 + 纯 reasoning 轮必须丢弃（实际 ${r1.dropped}）`);
    ok('ingest 首跑：2 会话 / 4 轮 / 丢弃 2 条注入');

    // ── 3. 幂等 ───────────────────────────────────────────────────
    const r2 = ingest(ctx, { all: false, log: (s) => logs.push(s) });
    assert.equal(r2.turns, 0, '复跑不应新增');
    assert.equal(turnCount(openDb(ctx.dbp)), 4, '复跑后总轮次必须不变');
    ok('ingest 幂等：复跑 +0 轮，总数仍 4');

    const db = openDb(ctx.dbp);
    // ── 4. 中文子串（trigram） ─────────────────────────────────────
    const s1 = search(db, '四层体检', 8);
    assert.equal(s1.hits, 1, `trigram 中文子串应命中 1 条（实际 ${s1.hits}）`);
    assert.equal(s1.results[0].pointer, 'sess-a#seq=1');
    assert.ok(s1.results[0].snippet.includes('四层体检'), '切片必须含原词');
    ok(`search trigram 中文子串 → ${s1.results[0].pointer}`);

    // ── 5. <3 字符走 LIKE ─────────────────────────────────────────
    const s2 = search(db, '提权', 8);
    assert.equal(s2.hits, 1, '2 字词必须靠 LIKE 兜底');
    assert.equal(s2.results[0].pointer, 'sess-b#seq=7');
    ok('search 2 字词 LIKE 兜底');

    // ── 6. 0 命中 → 空数组，不报错 ─────────────────────────────────
    assert.equal(search(db, '绝不存在的词组zzz', 8).hits, 0);
    ok('search 0 命中 → hits=0');

    // ── 7. open 回原文（逐字） ────────────────────────────────────
    const o1 = openPointer(db, 'sess-a#seq=1', 0);
    assert.equal(o1.rows[0].text, '我们决定把 tokenizer 固定为 trigram，实测四层体检可以命中', 'open 必须逐字回原文');
    const o2 = openPointer(db, 'sess-a#seq=4', 2);
    assert.equal(o2.rows.length, 3, `--context 2 应回 3 轮（实际 ${o2.rows.length}）`);
    assert.ok(o2.rows.some((x) => x.id === o2.anchorId), '上下文里必须含命中轮');
    ok('open 逐字回原文 + 上下文');

    // ── 8. 指针不存在 → 退出码 2 + 候选 ───────────────────────────
    let bad;
    try { openPointer(db, 'sess-deadbeef#999', 0); } catch (e) { bad = e; }
    assert.ok(bad instanceof AppError && bad.exitCode === 2, '坏指针必须 exitCode 2');
    assert.match(bad.message, /no such pointer/);
    assert.equal(bad.message.split('\n').filter((l) => l.trim().startsWith('sess-')).length, 3, '必须给 3 个候选');
    ok('open 坏指针 → no such pointer + 3 候选');

    // ── 9. 空库 / 读不到输入 → 非 0 ───────────────────────────────
    const empty = openDb(path.join(home, 'mem', 'empty.db'), { mustExist: false });
    let e1;
    try { search(empty, 'x', 3); } catch (e) { e1 = e; }
    assert.ok(e1?.exitCode === 3, '空库必须非 0');
    empty.close();

    let e2;
    try { sessionsDirOf(path.join(tmp, 'no-such-home'), ws); } catch (e) { e2 = e; }
    assert.ok(e2?.exitCode === 3, 'DSH_HOME 不存在必须非 0');
    ok('空库 / DSH_HOME 不存在 → exit 3');

    // ── 10. 水位与 stats ─────────────────────────────────────────
    const st = stats(db, ctx.dbp);
    assert.equal(st.sessions, 2);
    assert.equal(st.turns, 4);
    db.close();
    const r3 = ingest(ctx, { all: false, log: (s) => logs.push(s) });
    assert.equal(r3.skippedUnchanged, 2, '水位未变时必须跳过 2 个会话');
    ok('stats 2 会话 / 4 轮；水位命中 → 跳过 2');

    // ── 11. redact 隐私闸 ────────────────────────────────────────
    const ws2 = path.join(tmp, 'fixture-privacy');
    const sdir2 = path.join(home, 'sessions', sessionDirName(ws2));
    fs.mkdirSync(ws2, { recursive: true });
    mkSession('sess-secret', [
      { type: 'user/message', seq: 1, time: 3000, data: { content: [{ type: 'text', text: '把 key sk-ABCDEFGHIJKLMNOPQRSTUVWX 写进 .env 试一下' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 2, time: 3001, data: { content: [{ type: 'text', text: '这条没有密钥，原样保留' }], source: { kind: 'user' } } },
    ], sdir2);
    mkSession('sess-ignored', [
      { type: 'user/message', seq: 1, time: 3002, data: { content: [{ type: 'text', text: '被 excludePaths 挡掉的会话' }], source: { kind: 'user' } } },
    ], sdir2);
    mkSession('sess-clean', [
      { type: 'user/message', seq: 1, time: 3003, data: { content: [{ type: 'text', text: '正常入库的一轮，用来确认排除没有误伤' }], source: { kind: 'user' } } },
    ], sdir2);

    const ctx2 = { home, ws: ws2, dbp: dbPathOf(home, ws2) };
    const rp = ingest(ctx2, { all: true, redact: ['sk-[A-Za-z0-9]{20,}'], excludePaths: ['*sess-ignored*'] });
    assert.equal(rp.excluded, 1, `excludePaths 必须跳过 1 个会话（实际 ${rp.excluded}）`);
    assert.equal(rp.redacted, 1, `redact 必须命中 1 条（实际 ${rp.redacted}）`);
    assert.equal(rp.turns, 3, `排除后只入库 3 条（实际 ${rp.turns}）`);

    const db2 = openDb(ctx2.dbp);
    const stored = db2.prepare(`SELECT text FROM turn WHERE session='sess-secret' AND seq=1`).get().text;
    assert.ok(stored.includes('[redacted]'), 'redact 必须替换成 [redacted]');
    assert.ok(!stored.includes('sk-ABCDEF'), '原文密钥不得落库');
    assert.equal(search(db2, 'sk-ABCDEF', 8).hits, 0, '被 redact 的密钥不可被检索');
    ok('redact 生效（落库替换 + 检索不到）');
    assert.equal(search(db2, '被 excludePaths 挡掉', 8).hits, 0, '被排除的会话不可被检索');
    assert.equal(db2.prepare(`SELECT count(*) c FROM meta WHERE k LIKE 'session:sess-ignored%'`).get().c, 0,
      '被排除的会话不得写水位');
    db2.close();
    ok('excludePaths 生效（跳过 1 会话 + 不写水位）');

    console.log(`\nselftest PASS  —  ${pass} 项全绿  (tmp: ${tmp})`);
    return { code: 0, pass };
  } catch (e) {
    console.error(`selftest FAIL: ${e.message}`);
    if (logs.length) console.error(`\ningest log:\n${logs.join('\n')}`);
    return { code: e instanceof AppError ? e.exitCode || 10 : 10, pass, error: e };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
