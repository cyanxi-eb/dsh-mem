/** 核心读写：幂等、检索、指针、退出码、storeDir 兼容性。零依赖 node:test。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as core from '../lib/core.mjs';
import { addSession, runCliRaw, seedWorkspace, tmpHome, userTurn } from '../support/helpers.mjs';

test('ingest 首跑入库、复跑幂等（UNIQUE(session,seq)）', () => {
  const home = tmpHome();
  const ws = path.join(home, 'w1');
  const ctx = seedWorkspace(home, ws);

  const r1 = core.ingest(ctx, { all: true });
  assert.equal(r1.sessions, 2);
  assert.equal(r1.turns, 4);
  assert.equal(r1.dropped, 1, 'runtime-context 注入轮必须丢弃');

  const r2 = core.ingest(ctx, { all: true });
  assert.equal(r2.turns, 0, '复跑不得新增');

  const db = core.openDb(ctx.dbp);
  assert.equal(core.turnCount(db), 4);
  db.close();
});

test('search：trigram 中文子串 / <3 字 LIKE 兜底 / 0 命中', () => {
  const home = tmpHome();
  const ws = path.join(home, 'w2');
  const ctx = seedWorkspace(home, ws);
  core.ingest(ctx, { all: true });
  const db = core.openDb(ctx.dbp);
  try {
    const s1 = core.search(db, '四层体检', 8);
    assert.equal(s1.hits, 1);
    assert.equal(s1.results[0].pointer, 'sess-a#seq=1');
    assert.match(s1.results[0].snippet, /四层体检/);

    const s2 = core.search(db, '提权', 8);
    assert.equal(s2.hits, 1);
    assert.equal(s2.results[0].pointer, 'sess-b#seq=1');
    assert.equal(s2.mode, 'LIKE');

    assert.equal(core.search(db, '绝不存在的词组zzz', 8).hits, 0);
    assert.throws(() => core.search(db, '   ', 3), (e) => e.exitCode === 1);
  } finally { db.close(); }
});

test('open：逐字回原文 + 坏指针 exitCode 2 + 3 个候选', () => {
  const home = tmpHome();
  const ws = path.join(home, 'w3');
  const ctx = seedWorkspace(home, ws);
  core.ingest(ctx, { all: true });
  const db = core.openDb(ctx.dbp);
  try {
    const one = core.openPointer(db, 'sess-a#seq=1', 0);
    assert.equal(one.rows[0].text, '我们决定把 tokenizer 固定为 trigram，实测四层体检可以命中');
    assert.equal(core.openPointer(db, 'sess-a#1', 0).rows[0].seq, 1, '简写必须兼容');

    let bad;
    try { core.openPointer(db, 'sess-deadbeef#999', 0); } catch (e) { bad = e; }
    assert.ok(bad instanceof core.AppError);
    assert.equal(bad.exitCode, 2);
    assert.match(bad.message, /no such pointer/);
    assert.equal(bad.message.split('\n').filter((l) => l.trim().startsWith('sess-')).length, 3);
  } finally { db.close(); }
});

test('空库 → exit 3；DSH_HOME 缺失 → exit 3', () => {
  const home = tmpHome();
  const empty = core.openDb(path.join(home, 'mem', 'empty.db'), { mustExist: false });
  try { assert.throws(() => core.search(empty, 'x', 3), (e) => e.exitCode === 3); } finally { empty.close(); }
  assert.throws(() => core.sessionsDirOf(path.join(home, 'nope'), '/x'), (e) => e.exitCode === 3);
});

test('storeDir：缺省仍是 <home>/mem，旧库名逐字节不变；显式目录只换父目录', { skip: process.platform !== 'win32' ? '库名 hash 依赖 Windows 路径' : false }, () => {
  const home = path.join('C:', 'Users', 'test', '.dsh');
  const legacy = core.dbPathOf(home, 'D:\\dsh-sp1');
  assert.equal(legacy, path.join(home, 'mem', '53fe3fff-dsh-sp1.db'), '现有库 53fe3fff-dsh-sp1.db 必须仍被默认路径命中');
  assert.equal(core.dbPathOf(home, 'D:\\dsh-sp1', path.join(home, 'custom')), path.join(home, 'custom', '53fe3fff-dsh-sp1.db'));
});

test('CLI：坏指针退出 2；缺 DSH_HOME 退出 3；search 正常退出 0', () => {
  const home = tmpHome();
  const ws = path.join(home, 'w4');
  const ctx = seedWorkspace(home, ws);

  let r = runCliRaw(['search', '四层体检', '--home', home, '--workspace', ws]);
  assert.equal(r.status, 3, '库还没建 → 非 0');

  core.ingest(ctx, { all: true });
  const ok = runCliRaw(['search', '四层体检', '--home', home, '--workspace', ws]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /sess-a#seq=1/);

  const bad = runCliRaw(['open', 'sess-deadbeef#999', '--home', home, '--workspace', ws]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no such pointer/);

  const missing = runCliRaw(['search', 'x', '--home', path.join(home, 'no-such-home'), '--workspace', ws]);
  assert.notEqual(missing.status, 0, 'DSH_HOME 不存在必须非 0');
});

test('CLI --json：stats / search 输出可解析且字段稳定', () => {
  const home = tmpHome();
  const ws = path.join(home, 'w5');
  const ctx = seedWorkspace(home, ws);
  core.ingest(ctx, { all: true });

  const st = JSON.parse(runCliRaw(['stats', '--json', '--home', home, '--workspace', ws]).stdout);
  assert.equal(st.turns, 4);
  assert.equal(st.sessions, 2);

  const s = JSON.parse(runCliRaw(['search', 'Router', '--json', '--home', home, '--workspace', ws]).stdout);
  assert.equal(s.query, 'Router');
  assert.ok(Array.isArray(s.results));
});

test('addSession 夹具自检：注入轮不进库、助手 reasoning 不进库', () => {
  const home = tmpHome();
  const ws = path.join(home, 'w6');
  addSession(home, ws, 's', [
    userTurn(1, '真用户轮'),
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '注入' }], source: { kind: 'skill-catalog' } } },
    { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'reasoning', text: '草稿' }] } } },
  ]);
  const ctx = { home, ws, dbp: core.dbPathOf(home, ws) };
  const r = core.ingest(ctx, { all: true });
  assert.equal(r.turns, 1);
  assert.equal(r.dropped, 2);
});
