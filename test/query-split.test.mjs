/**
 * P0 查询切分 + P2 词面重排的判据。
 *
 * 合成夹具守"行为不变"，本机真实库副本守"指标"（库不在就跳过，和等价性测试同一套口径）。
 * 指标口径见 support/queries12.mjs：12 条整句中文，R@3 按"整轮原文包含答案原话"算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { addSession, runCliRaw, tmpHome, userTurn } from '../support/helpers.mjs';
import { QUERIES12, recallAt3 } from '../support/queries12.mjs';

test('P0：整句中文 0 命中时才切分（mode=split），原本能命中的查询仍走 AND', () => {
  const home = tmpHome('dsh-mem-split-');
  const ws = path.join(home, 'w-split');
  addSession(home, ws, 'sess-a', [
    userTurn(1, '视频文件本身一点问题都没有，机器缺 H.265 解码器，所以打不开'),
    userTurn(2, 'Router Worker 的分工：Worker 写库，Router 只查'),
  ]);
  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  core.ingest(ctx, { all: true, episodes: false });
  const db = core.openDb(ctx.dbp);
  try {
    // 老实现：整句当一个 trigram 短语 → 必然 0 命中
    assert.equal(db.prepare(`SELECT count(*) c FROM turn_fts WHERE turn_fts MATCH ?`)
      .get(`"视频为什么打不开"`).c, 0, '整句短语在库里不存在，这正是 P0 要修的 bug');

    const r = core.search(db, '视频为什么打不开', 3);
    assert.equal(r.mode, 'split', `整句失败必须回落到切分（实际 ${r.mode}）`);
    assert.ok(r.hits >= 1, '切分后必须命中');
    assert.equal(r.results[0].pointer, 'sess-a#seq=1');
    // 切片要定在命中的 bigram 上，而不是从第 0 字开始
    assert.match(r.results[0].snippet, /视频|打不开/);

    // 不退化：原本 AND 能命中的查询，模式与结果必须与老实现一致
    const keep = core.search(db, 'Router Worker', 3);
    assert.equal(keep.mode, 'AND', '能命中就不许走切分路径');
    assert.equal(keep.results[0].pointer, 'sess-a#seq=2');
  } finally { db.close(); }
});

test('P0：切分 atom 只切中文 bigram，英文/路径整词保留', () => {
  const atoms = core.queryAtoms('dsh-mem 的记忆层 D:\\dsh-sp1 放哪');
  assert.ok(atoms.includes('dsh-mem'), '英文整词必须保留（不是拆字母）');
  assert.ok(atoms.includes('d:\\dsh-sp1'), '路径整词必须保留');
  assert.ok(atoms.includes('记忆') && atoms.includes('忆层'), '中文必须切相邻 bigram');
  assert.ok(!atoms.includes('的'), '1 字 atom 是噪声，不参与');
});

test('P2：rerank:\'off\' 与 P0 逐字节一致；lexical 只改顺序不改候选集', () => {
  const home = tmpHome('dsh-mem-rerank-');
  const ws = path.join(home, 'w-rr');
  addSession(home, ws, 'sess-a', [
    userTurn(1, '视频文件本身一点问题都没有，机器缺 H.265 解码器，所以打不开'),
    userTurn(2, '另一个视频是因为磁盘满了才打不开，跟解码器无关'),
  ]);
  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  core.ingest(ctx, { all: true, episodes: false });
  const db = core.openDb(ctx.dbp);
  const norm = (v) => JSON.stringify(v).replace(/"ms":\s*[0-9.]+/g, '"ms":0')   // 只归一随机耗时
  try {
    for (const q of ['视频打不开', '视频为什么打不开', '磁盘满']) {
      const off = norm(core.search(db, q, 5, { rerank: 'off' }));
      const dflt = norm(core.search(db, q, 5));
      assert.equal(dflt, off, `rerank 缺省必须是 off（${q}）`);
      const lex = core.search(db, q, 5, { rerank: 'lexical' });
      assert.deepEqual(lex.results.map((x) => x.pointer).sort(), JSON.parse(off).results.map((x) => x.pointer).sort(),
        '重排只改顺序，不许增删候选');
      assert.equal(JSON.stringify(core.search(db, q, 5, { rerank: 'off' })
        .results.map((x) => [x.pointer, x.score, x.snippet])),
      JSON.stringify(JSON.parse(off).results.map((x) => [x.pointer, x.score, x.snippet])), `off 必须可复现（${q}）`);
    }
    // rerankLexical=false 等价于 off
    assert.equal(norm(core.search(db, '视频打不开', 5, { rerank: 'lexical', rerankLexical: false })),
      norm(core.search(db, '视频打不开', 5, { rerank: 'off' })), 'rerankLexical:false 必须等于 off');
  } finally { db.close(); }
});

test('CLI：--rerank off 与缺省逐字节一致，lexical 打开后仍可解析', () => {
  const home = tmpHome('dsh-mem-cli-rr-');
  const ws = path.join(home, 'w-cli');
  addSession(home, ws, 'sess-a', [userTurn(1, '视频文件本身没问题，机器缺 H.265 解码器')]);
  core.ingest({ home, ws, dbp: core.dbPathOf(home, ws) }, { all: true, episodes: false });
  const norm = (s) => s.replace(/"ms": [0-9.]+/g, '"ms": 0');
  const a = norm(runCliRaw(['search', '视频为什么打不开', '--k', '3', '--json', '--home', home, '--workspace', ws]).stdout);
  const b = norm(runCliRaw(['search', '视频为什么打不开', '--k', '3', '--json', '--rerank', 'off', '--home', home, '--workspace', ws]).stdout);
  assert.equal(a, b, 'CLI 缺省 rerank 必须是 off（等价性测试靠这条守住）');
  const c = runCliRaw(['search', '视频为什么打不开', '--k', '3', '--json', '--rerank', 'lexical', '--home', home, '--workspace', ws]);
  assert.equal(c.status, 0);
  assert.equal(JSON.parse(c.stdout).hits, 1);
});

// ── 本机真实库：指标判据（库不在就跳过） ─────────────────────────────
const REAL_DB = path.join(os.homedir(), '.dsh', 'mem', '53fe3fff-dsh-sp1.db');
const REAL_WS = 'D:\\dsh-sp1';
const LEGACY = fileURLToPath(new URL('../support/mem.legacy.mjs', import.meta.url));

function withRealDbCopy(fn) {
  if (!fs.existsSync(REAL_DB)) return null;
  const home = tmpHome('dsh-mem-real-eval-');
  const memDir = path.join(home, 'mem');
  fs.mkdirSync(memDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(REAL_DB + suffix)) fs.copyFileSync(REAL_DB + suffix, path.join(memDir, path.basename(REAL_DB) + suffix));
  }
  const dbp = path.join(memDir, path.basename(REAL_DB));
  const db = core.openDb(dbp);
  const runOf = (rerank) => (q, k) => {
    const r = core.search(db, q, k, { rerank });
    return { ...r, rows: r.results.map((x) => ({ pointer: x.pointer, text: core.openPointer(db, x.pointer, 0).rows[0].text })) };
  };
  // 老实现（冻结件）只能按 CLI 跑：它就是"P0 之前"的真身，不是拍脑袋的 0
  const runLegacy = (q, k) => {
    const out = execFileSync(process.execPath, [LEGACY, 'search', q, '--k', String(k), '--json',
      '--home', home, '--workspace', REAL_WS], { encoding: 'utf8' });
    const r = JSON.parse(out);
    return { ...r, rows: (r.results ?? []).map((x) => ({ pointer: x.pointer, text: core.openPointer(db, x.pointer, 0).rows[0].text })) };
  };
  try { return fn(db, runOf, runLegacy); } finally { db.close(); }
}

test('P0 判据（真实库副本）：12 条自然语言查询 R@3 ≥ 0.30', { skip: fs.existsSync(REAL_DB) ? false : '本机没有 53fe3fff-dsh-sp1.db' }, () => {
  const out = withRealDbCopy((db, runOf, runLegacy) => {
    const before = recallAt3(runLegacy);
    const p0 = recallAt3(runOf('off'));
    return { before, p0, turns: core.turnCount(db) };
  });
  console.log(`[P0] turns=${out.turns}  before(冻结老实现) R@3=${out.before.r3}  →  P0 R@3=${out.p0.r3}`);
  assert.equal(out.before.r3, 0, 'P0 之前的基线必须是 0（整句当一个 trigram 短语）');
  assert.ok(out.p0.r3 >= 0.30, `P0 R@3 必须 ≥ 0.30（实际 ${out.p0.r3}）`);
});

test('P2 判据（真实库副本）：R@3 ≥ P0 基线 + 0.15，且候选集不变', { skip: fs.existsSync(REAL_DB) ? false : '本机没有 53fe3fff-dsh-sp1.db' }, () => {
  const out = withRealDbCopy((db, runOf) => {
    const p0 = recallAt3(runOf('off'));
    const p2 = recallAt3(runOf('lexical'));
    for (const { q } of QUERIES12) {
      const a = core.search(db, q, 50, { rerank: 'off' }).results.map((x) => x.pointer).sort();
      const b = core.search(db, q, 50, { rerank: 'lexical' }).results.map((x) => x.pointer).sort();
      assert.deepEqual(b, a, `词面重排不许增删候选（${q}）`);
    }
    return { p0, p2 };
  });
  console.log(`[P2] P0 R@3=${out.p0.r3}  →  P2 R@3=${out.p2.r3}  Δ=${(out.p2.r3 - out.p0.r3).toFixed(3)}`);
  assert.ok(out.p2.r3 >= out.p0.r3 + 0.15, `P2 必须 ≥ P0 + 0.15（实际 Δ=${(out.p2.r3 - out.p0.r3).toFixed(3)}）`);
});
