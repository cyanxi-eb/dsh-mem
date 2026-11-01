/**
 * dsh-mem / lib/portable.mjs — 可移植性层：NDJSON 导出/导入 + `ingest --file`。
 *
 * 只调 lib/core.mjs（insertRows / openDb / DDL），自己不碰 SQL 语义。
 * 零依赖：只 import node:*。
 *
 * 迁移口径：`turn` 层是唯一导出/导入的单位，字段 session,seq,role,ts,text,kind,tags。
 * `fact` 表（只影响排序的代谢计数）与 `meta` 水位**不导出** —— 它们是派生派生的派生，
 * 换个库重跑 ingest 就回来了；见 README「已知边界」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as core from './core.mjs';

export const SCHEMA = 'dsh-mem/1';
export const EXPORT_FIELDS = ['session', 'seq', 'role', 'ts', 'text', 'kind', 'tags'];

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** 导出：首行 header + 一行一个 turn。`out` 缺省或 '-' 走 stdout。 */
export function exportNdjson(db, { out = '-', workspace = '', log = () => {} } = {}) {
  if (!core.turnCount(db)) throw new core.AppError('库是空的（0 条 turn）。先跑: dsh-mem ingest', 3);
  const rows = db.prepare(`SELECT session, seq, role, ts, text, kind, tags FROM turn ORDER BY ts, id`).all();
  const header = { schema: SCHEMA, exportedAt: new Date().toISOString(), workspace, count: rows.length };
  const lines = [JSON.stringify(header)];
  for (const r of rows) lines.push(JSON.stringify({
    session: r.session, seq: r.seq, role: r.role, ts: r.ts, text: r.text, kind: r.kind, tags: r.tags,
  }));
  const text = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(text);
  if (!out || out === '-') process.stdout.write(text);
  else {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    log(`[export] ${rows.length} 轮 → ${path.resolve(out)}  ${(bytes / 1048576).toFixed(2)} MB`);
  }
  return { out: out && out !== '-' ? path.resolve(out) : '-', count: rows.length, bytes };
}

function parseHeader(line) {
  let h;
  try { h = JSON.parse(line); } catch (e) { throw new core.AppError(`NDJSON 首行不是 JSON: ${e.message}`, 4); }
  if (h?.schema !== SCHEMA)
    throw new core.AppError(`NDJSON schema 不匹配: ${JSON.stringify(h?.schema)}（本工具只吃 ${SCHEMA}）`, 4);
  return h;
}

/** 导入：校验 schema，INSERT OR IGNORE 保证幂等（session,seq 唯一）。 */
export function importNdjson(db, file, { dryRun = false, redact = [], log = () => {} } = {}) {
  if (!file) throw new core.AppError('缺 <file.ndjson>', 1);
  if (!fs.existsSync(file)) throw new core.AppError(`读不到文件: ${file}`, 3);
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  if (!lines.length) throw new core.AppError(`空文件: ${file}`, 3);
  const header = parseHeader(lines[0]);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    let o;
    try { o = JSON.parse(lines[i]); }
    catch (e) { throw new core.AppError(`${file}:${i + 1} 不是合法 JSON: ${e.message}`, 4); }
    if (typeof o?.session !== 'string' || !Number.isInteger(o?.seq) || typeof o?.text !== 'string')
      throw new core.AppError(`${file}:${i + 1} 缺字段（需要 session/seq/text）: ${lines[i].slice(0, 120)}`, 4);
    rows.push({
      session: o.session, seq: o.seq, role: String(o.role ?? 'user'), ts: Number(o.ts ?? 0),
      text: o.text, kind: String(o.kind ?? 'import'), tags: String(o.tags ?? '|agent|'),
    });
  }

  if (dryRun) {
    let existing = null;
    try { if (fs.existsSync(db)) existing = new DatabaseSync(db, { readOnly: true }); } catch { existing = null; }
    let wouldInsert = 0, skipped = 0;
    try {
      const seen = existing
        ? existing.prepare('SELECT 1 AS x FROM turn WHERE session = ? AND seq = ?')
        : null;
      const compiled = core.compileRedact(redact);
      for (const r of rows) {
        if (seen?.get(r.session, r.seq)) { skipped++; continue; }
        wouldInsert++;
        if (core.redactText(r.text, compiled).hit) { /* 计数在 insert 时才累加，这里只报行数 */ }
      }
    } finally { try { existing?.close(); } catch { /* ignore */ } }
    return { file: path.resolve(file), schema: header.schema, headerCount: header.count ?? null,
      read: rows.length, inserted: wouldInsert, skipped, dryRun: true };
  }

  const res = core.insertRows(db, rows, { redact, tags: '|agent|' });
  const out = { file: path.resolve(file), schema: header.schema, headerCount: header.count ?? null,
    read: rows.length, inserted: res.inserted, skipped: rows.length - res.inserted, redacted: res.redacted, facts: res.facts };
  log(`[import] ${out.read} 行 → 新增 ${out.inserted}，已存在跳过 ${out.skipped}${out.redacted ? `，redact ${out.redacted}` : ''}`);
  return out;
}

// ───────────────────────────── ingest --file ─────────────────────────────
const textOf = (v) => (typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v)));

/** `.md/.txt` 按空行切段；`.jsonl` 每行一条（取 text/content/message 字段）。 */
export function chunksOf(file) {
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, 'utf8');
  if (ext === '.jsonl') {
    return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      try {
        const o = JSON.parse(l);
        return textOf(o?.text ?? o?.content ?? o?.message ?? o).trim();
      } catch { return l; }
    }).filter(Boolean);
  }
  return raw.split(/\r?\n[ \t]*\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 吃 .md/.txt/.jsonl，按段落切块入库，tags 打 `|agent|source:<name>|`。
 * 不依赖 DSH：纯文本也能进；session = `file:<source>@<内容hash8>`，seq = 段序号，
 * 于是同一份文件重复 ingest 幂等，文件改了就变成一组新指针（不改写旧原文，守住 I1）。
 */
export function ingestFile(dbp, file, {
  source = '', dryRun = false, redact = [], excludePaths = [], log = () => {},
} = {}) {
  if (!file) throw new core.AppError('缺 --file <path>', 1);
  if (!fs.existsSync(file)) throw new core.AppError(`读不到文件: ${file}`, 3);
  if (!/\.(md|txt|jsonl)$/i.test(file)) throw new core.AppError(`只吃 .md/.txt/.jsonl: ${file}`, 1);

  const name = source || path.basename(file).replace(/\.[^.]+$/, '');
  if (core.isExcluded([file, name], excludePaths)) {
    return { file: path.resolve(file), source: name, excluded: 1, inserted: 0, chunks: 0, redacted: 0, dryRun };
  }

  const chunks = chunksOf(file);
  if (!chunks.length) throw new core.AppError(`文件里没有可入库的段落: ${file}`, 3);
  const st = fs.statSync(file);
  const session = `file:${name}@${sha1(chunks.join('\n')).slice(0, 8)}`;
  const tags = `|agent|source:${name}|`;
  const rows = chunks.map((text, i) => ({
    session, seq: i + 1, role: 'doc', ts: Math.round(st.mtimeMs), text, kind: 'file', tags, file,
  }));

  const compiled = core.compileRedact(redact);
  const hits = rows.filter((r) => core.redactText(r.text, compiled).hit).length;

  if (dryRun) {
    return { file: path.resolve(file), source: name, session, chunks: chunks.length,
      inserted: chunks.length, redacted: hits, excluded: 0, dryRun: true };
  }

  const db = core.openDb(dbp, { mustExist: false });
  try {
    const res = core.insertRows(db, rows, { tags, redact, excludePaths });
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    const out = { file: path.resolve(file), source: name, session, chunks: chunks.length,
      inserted: res.inserted, skipped: res.skipped, redacted: res.redacted, facts: res.facts, dbPath: dbp };
    log(`[ingest-file] ${name}  段 ${out.chunks}  新入库 ${out.inserted}${out.redacted ? `  redact ${out.redacted}` : ''}`);
    return out;
  } finally { try { db.close(); } catch { /* ignore */ } }
}
