/**
 * P1 事件层 episode 的判据：幂等、已封不可改、partialTail 不切、dry-run 不写库。
 *
 * 口径：episode 只存「区间 + 指纹」，原文永远靠 open；所以这里的断言全部落在
 * (session,start_seq,end_seq,seal,gen_version) 上，外加"覆盖的 turn 条数"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as core from '../lib/core.mjs';
import * as portable from '../lib/portable.mjs';
import {
  appendSession, ev, runCliRaw, tmpHome, turnBlock, withPartialTail, writeSession,
} from '../support/helpers.mjs';

const OLD = () => Date.now() - 30 * 60 * 1000;   // 30 分钟前 → 一定过了闭合阈值

const epsOf = (db, sid) =>
  db.prepare(`SELECT id, start_seq, end_seq, seal, gen_version, sealed_mtime, src_hash, created
              FROM episode WHERE session = ? ORDER BY start_seq`).all(sid);

test('episode：闭合会话切段并封印；覆盖的 turn 一条不漏；open 只回原文', () => {
  const home = tmpHome('dsh-mem-ep-');
  const ws = path.join(home, 'w-ep');
  const big = 'x'.repeat(1800);     // 三轮各 3600 字 → 超过 maxChars=4000 时必须在 assistant 边界切
  writeSession(home, ws, 'sess-1', [
    ...turnBlock(1, `${big} 第一轮的问题`, `${big} 第一轮的回答`),
    ...turnBlock(10, `${big} 第二轮的问题`, `${big} 第二轮的回答`),
    ...turnBlock(20, `${big} 第三轮的问题`, `${big} 第三轮的回答`),
  ], { mtime: OLD() });

  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  const r = core.ingest(ctx, { all: true, episodes: true, episodeMaxChars: 4000 });
  assert.equal(r.turns, 6, '6 条可见正文入库');
  assert.equal(r.episodes.segments, 3, `三轮各 3600 字必须切成 3 段（实际 ${r.episodes.segments}）`);
  assert.equal(r.episodes.sealed, 3, '闭合会话的分段必须全部封印');

  const db = core.openDb(ctx.dbp);
  try {
    const eps = epsOf(db, 'sess-1');
    assert.equal(eps.length, 3);
    assert.ok(eps.every((e) => e.seal === 1), '闭合了就要封印');
    assert.ok(eps.every((e) => e.gen_version === 'v1:m4000'), '第一代 gen_version 固定');
    // 每段都停在 assistant 边界上（单元完整、没有半条消息）
    for (const e of eps) {
      const rows = db.prepare(`SELECT seq, role, length(text) n FROM turn WHERE session='sess-1' AND seq BETWEEN ? AND ? ORDER BY seq`)
        .all(e.start_seq, e.end_seq);
      assert.equal(rows.at(-1).role, 'asst', '每段必须收在 assistant 消息边界上');
      assert.ok(rows.length === 2, '一段 = 完整的一轮（user + asst 成对）');
      assert.ok(rows.reduce((n, x) => n + x.n, 0) <= 4000, '在预算内就绝不超');
    }
    // 覆盖：episode ⟕ turn 不能有空行；被覆盖的 turn 数 = 6
    const orphans = db.prepare(`SELECT count(*) c FROM episode e
      LEFT JOIN turn t ON t.session = e.session AND t.seq BETWEEN e.start_seq AND e.end_seq
      WHERE t.id IS NULL`).get().c;
    assert.equal(orphans, 0, 'episode 必须落在真实 turn 上');
    const cov = core.listEpisodes(db, { session: 'sess-1' });
    assert.equal(cov.turnsCovered, 6, '所有 turn 都要被区间覆盖');

    // listEpisodes 的指针能吃回去，且 open 只回原文
    const ptr = cov.episodes[0].pointer;
    const o = core.openEpisode(db, ptr);
    assert.equal(o.rows.length, cov.episodes[0].turns);
    assert.ok(o.rows[0].text.startsWith('x'.repeat(1800)), '必须是逐字原文，不是摘要');
  } finally { db.close(); }
});

test('episode：一条超长 assistant 消息不许被劈开（宁可超预算）', () => {
  const home = tmpHome('dsh-mem-ep-long-');
  const ws = path.join(home, 'w-long');
  const huge = 'y'.repeat(6000);       // 单条 6000 字 > maxChars 4000
  writeSession(home, ws, 'sess-1', turnBlock(1, '短问句', huge), { mtime: OLD() });
  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  core.ingest(ctx, { all: true, episodes: true, episodeMaxChars: 4000 });

  const db = core.openDb(ctx.dbp);
  try {
    const eps = epsOf(db, 'sess-1');
    assert.equal(eps.length, 1, '单条超长回答和它的问句同段：绝不切半句，也不留半截前缀');
    const rows = db.prepare(`SELECT role, length(text) n FROM turn WHERE session='sess-1' ORDER BY seq`).all();
    assert.deepEqual(rows.map((r) => r.role), ['user', 'asst']);
    assert.equal(rows[1].n, 6000, '那条 6000 字的 assistant 消息必须完整落在一个区间里');
    assert.equal(eps[0].start_seq, 2);
    assert.equal(eps[0].end_seq, 3);
  } finally { db.close(); }
});

test('episode：重复跑不新增（幂等），已封区间永不修改', () => {
  const home = tmpHome('dsh-mem-ep-idem-');
  const ws = path.join(home, 'w-idem');
  const file = writeSession(home, ws, 'sess-1', turnBlock(1, '第一轮问句', '第一轮回答'), { mtime: OLD() });
  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  core.ingest(ctx, { all: true, episodes: true });

  const db = core.openDb(ctx.dbp);
  try {
    const first = epsOf(db, 'sess-1');
    assert.equal(first.length, 1);
    assert.equal(first[0].seal, 1);

    // ① 复跑整趟 pass：created 必须为 0，行逐字段不变
    const again = core.buildEpisodes(db, ctx);
    assert.equal(again.created, 0, '幂等：复跑不得新增');
    assert.equal(again.removed, 0, '幂等：复跑不得作废任何区间');
    assert.deepEqual(epsOf(db, 'sess-1'), first, '复跑后每一行必须逐字段不变');

    // ② 会话续写：只在尾部追加 continuation，封印过的行一行都不许动
    appendSession(file, turnBlock(20, '第二轮问句', '第二轮回答', Date.now()));
    fs.utimesSync(file, new Date(OLD()), new Date(OLD()));   // 让它再次满足 mtime 阈值
    core.ingest(ctx, { all: true, episodes: false });         // 新 turn 先进 turn 表
    const third = core.buildEpisodes(db, ctx);
    assert.ok(third.created >= 1, '续写必须新增尾部区间');
    const after = epsOf(db, 'sess-1');
    assert.deepEqual(after.filter((e) => e.start_seq <= 5), first, '已封区间必须逐字段不变（id/gen/sealed_mtime 都不动）');
    const cont = after.filter((e) => e.start_seq > 5);
    assert.equal(cont.length, 1);
    assert.equal(cont[0].gen_version, 'v1:m4000+r2', '续写用新 gen_version，不与已封区间撞 UNIQUE');
    assert.equal(cont[0].seal, 1);
    assert.equal(after.filter((e) => e.seal === 1).length, 2);
  } finally { db.close(); }
});

test('episode：partialTail 的会话不切情景；活动会话只开区间不封印', () => {
  const home = tmpHome('dsh-mem-ep-partial-');
  const ws = path.join(home, 'w-partial');
  // 尾帧不完整 → 规则 6：整份不切
  writeSession(home, ws, 'sess-partial', withPartialTail(turnBlock(1, '半截会话的问题', '半截会话的回答')), { mtime: OLD() });
  // 活动会话：末尾挂着 tool/call，且 mtime 是现在 → 不闭合
  writeSession(home, ws, 'sess-live', [
    ...turnBlock(1, '活动会话的问题', '活动会话的回答', Date.now()),
    ev('step/start', 50, Date.now()), ev('tool/call', 51, Date.now()),
  ], { mtime: Date.now() });

  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  const r = core.ingest(ctx, { all: true, episodes: true });
  assert.ok(r.episodes.skippedPartial >= 1, 'partialTail 会话必须被跳过且计数');

  const db = core.openDb(ctx.dbp);
  try {
    assert.equal(epsOf(db, 'sess-partial').length, 0, 'partialTail 会话一个区间都不许切');
    const live = epsOf(db, 'sess-live');
    assert.equal(live.length, 1, '活动会话照样切，只是不封');
    assert.equal(live[0].seal, 0);
    // 同一份文件多跑一次：开区间内容不变就是不重建
    const again = core.buildEpisodes(db, ctx);
    assert.equal(again.removed, 0, '开区间内容没变就不该删了重建');
  } finally { db.close(); }
});

test('dry-run：不写库、不迁移（老库里不会凭空长出 episode 表）', () => {
  const home = tmpHome('dsh-mem-dry-');
  const ws = path.join(home, 'w-dry');
  writeSession(home, ws, 'sess-1', turnBlock(1, '只读验证的问题', '只读验证的回答'), { mtime: OLD() });

  // 造一个"0.1 时代"的库：只有 turn/fact/meta，user_version=0，没有 episode 表
  const dbp = core.dbPathOf(home, ws);
  fs.mkdirSync(path.dirname(dbp), { recursive: true });
  const legacy = new DatabaseSync(dbp);
  legacy.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE turn(id INTEGER PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      ts INTEGER NOT NULL, turn_no INTEGER, text TEXT NOT NULL, kind TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '|agent|', UNIQUE(session, seq));
    CREATE VIRTUAL TABLE turn_fts USING fts5(text, content='turn', content_rowid='id', tokenize='trigram');
    CREATE TABLE fact(id INTEGER PRIMARY KEY, tags TEXT NOT NULL, anchor INTEGER NOT NULL, score INTEGER NOT NULL,
      created INTEGER NOT NULL, last_hit INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, retires INTEGER);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO turn(session, seq, role, ts, text, kind, tags) VALUES ('sess-old', 1, 'user', 1, '老库里的一行', 'user', '|agent|');
  `);
  legacy.close();

  const stat0 = fs.statSync(dbp);
  const out = runCliRaw(['ingest', '--dry-run', '--all', '--home', home, '--workspace', ws]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /dry-run/);
  const stat1 = fs.statSync(dbp);
  assert.equal(stat1.mtimeMs, stat0.mtimeMs, 'dry-run 后库文件 mtime 必须不变');
  assert.equal(stat1.size, stat0.size, 'dry-run 后库文件大小必须不变');

  // 只读打开：一行都不许动，更不许做 schema 迁移
  const ro = new DatabaseSync(dbp, { readOnly: true });
  try {
    assert.equal(ro.prepare(`SELECT count(*) c FROM sqlite_master WHERE name='episode'`).get().c, 0,
      'dry-run 不许把 episode 表建出来（那就是一次 schema 迁移）');
    assert.equal(ro.prepare('PRAGMA user_version').get().user_version, 0, 'dry-run 不许推 user_version');
    assert.equal(ro.prepare('SELECT count(*) c FROM turn').get().c, 1);
  } finally { ro.close(); }

  // 真跑一次（非 dry-run）才允许迁移，且 turn 一行不丢
  const ing = runCliRaw(['ingest', '--all', '--home', home, '--workspace', ws]);
  assert.equal(ing.status, 0, ing.stderr);
  const db = core.openDb(dbp);
  try {
    assert.equal(db.prepare(`SELECT count(*) c FROM sqlite_master WHERE name='episode'`).get().c, 1, '真跑才建表');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, core.SCHEMA_USER_VERSION);
    assert.equal(db.prepare(`SELECT count(*) c FROM turn WHERE session='sess-old'`).get().c, 1, '老库的行必须原样保留');
  } finally { db.close(); }
});

test('episode：file: 会话（无事件流）不切情景，也不会写空区间', () => {
  const home = tmpHome('dsh-mem-ep-nosrc-');
  const ws = path.join(home, 'w-nosrc');
  fs.mkdirSync(ws, { recursive: true });
  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  const f = path.join(home, 'note.md');
  fs.writeFileSync(f, '第一段。\n\n第二段。\n\n第三段。\n');

  assert.equal(portable.ingestFile(ctx.dbp, f, {}).inserted, 3, '文档按段落入库');

  const db = core.openDb(ctx.dbp);
  try {
    const ep = core.buildEpisodes(db, ctx);
    assert.equal(ep.noSource, 1, 'file: 会话没有事件流，必须认出来并跳过（不猜闭合）');
    assert.equal(db.prepare('SELECT count(*) c FROM episode').get().c, 0, '不写空区间');
  } finally { db.close(); }
});
