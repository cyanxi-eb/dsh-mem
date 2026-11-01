/** 隐私闸：redact 入库前替换、excludePaths 跳过、--dry-run 不写库。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../lib/core.mjs';
import * as portable from '../lib/portable.mjs';
import { addSession, runCliRaw, tmpHome, userTurn } from '../support/helpers.mjs';

const REDACT = ['sk-[A-Za-z0-9]{20,}', 'ghp_[A-Za-z0-9]{36}'];

function seedSecrets(home, ws) {
  addSession(home, ws, 'sess-secret', [
    userTurn(1, '把 key sk-ABCDEFGHIJKLMNOPQRSTUVWX 写进 .env 试一下'),
    userTurn(2, 'GitHub token ghp_0123456789abcdefghijklmnopqrstuvwxyz 也贴进来了'),
    userTurn(3, '这条没有密钥，原样保留'),
  ]);
  addSession(home, ws, 'sess-ignored', [userTurn(1, '被 excludePaths 挡掉的会话')]);
  addSession(home, ws, 'sess-clean', [userTurn(1, '正常入库的一轮，用来确认排除没有误伤')]);
  return { home, ws, dbp: core.dbPathOf(home, ws) };
}

test('redact：入库前替换成 [redacted]，原文不落库、不可检索', () => {
  const { home, ws, dbp } = seedSecrets(tmpHome(), 'ws-redact');
  const ctx = { home, ws, dbp };
  const r = core.ingest(ctx, { all: true, redact: REDACT });
  assert.equal(r.turns, 5, '3 条秘钥/干净轮 + 排除会话 1 条 + 干净会话 1 条');
  assert.equal(r.redacted, 2, '两条含密钥的轮次必须命中 redact');

  const db = core.openDb(dbp);
  try {
    const rows = db.prepare(`SELECT text FROM turn WHERE session='sess-secret' ORDER BY seq`).all();
    assert.match(rows[0].text, /\[redacted\]/);
    assert.ok(!rows[0].text.includes('sk-ABCDEF'), '密钥不得落库');
    assert.ok(!rows[1].text.includes('ghp_0123'), 'token 不得落库');
    assert.equal(rows[2].text, '这条没有密钥，原样保留');
    assert.equal(core.search(db, 'ABCDEFGHIJKLMNOPQRST', 8).hits, 0, '被 redact 的内容不可检索');
    assert.equal(core.search(db, '没有密钥', 8).hits, 1, '非密钥文本必须照常入库');
  } finally { db.close(); }
});

test('excludePaths：匹配的会话整份跳过，不解析不写水位', () => {
  const { home, ws, dbp } = seedSecrets(tmpHome(), 'ws-exclude');
  const ctx = { home, ws, dbp };
  const r = core.ingest(ctx, { all: true, excludePaths: ['*sess-ignored*'] });
  assert.equal(r.excluded, 1);
  assert.equal(r.turns, 4, '排除 1 个会话后只剩 4 条');
  const db = core.openDb(dbp);
  try {
    assert.equal(core.search(db, '被 excludePaths 挡掉', 8).hits, 0);
    assert.equal(db.prepare(`SELECT count(*) c FROM meta WHERE k LIKE 'session:sess-ignored%'`).get().c, 0,
      '被排除的会话不得写水位');
  } finally { db.close(); }
});

test('dry-run：打印将入库/redact/跳过计数，且不写库', () => {
  const { home, ws, dbp } = seedSecrets(tmpHome(), 'ws-dry');
  const ctx = { home, ws, dbp };

  const dry = core.ingest(ctx, { all: true, dryRun: true, redact: REDACT, excludePaths: ['*sess-ignored*'] });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.turns, 4, '将入库 4 条');
  assert.equal(dry.redacted, 2, '命中 redact 2 条');
  assert.equal(dry.excluded, 1, '跳过 1 个路径');
  assert.equal(fs.existsSync(dbp), false, 'dry-run 不得建库');

  const real = core.ingest(ctx, { all: true });
  assert.equal(real.turns, 5, '全量入库 5 条');

  const again = core.ingest(ctx, { all: true, dryRun: true });
  assert.equal(again.turns, 0, '已入库后再 dry-run 必须报 0');
});

test('CLI ingest --dry-run：输出中文计数且不建库', () => {
  const { home, ws, dbp } = seedSecrets(tmpHome(), 'ws-dry-cli');
  const r = runCliRaw(['ingest', '--dry-run', '--home', home, '--workspace', ws,
    '--redact', REDACT[0], '--redact', REDACT[1], '--exclude', '*sess-ignored*']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /将入库 4 条/);
  assert.match(r.stdout, /命中 redact 2 条/);
  assert.match(r.stdout, /跳过 1 个路径/);
  assert.equal(fs.existsSync(dbp), false);
});

test('ingest --file dry-run：计入 redact，不建库', () => {
  const home = tmpHome();
  const file = path.join(home, 'notes.md');
  fs.writeFileSync(file, '第一段：sk-ABCDEFGHIJKLMNOPQRSTUVWX\n\n第二段：普通笔记\n');
  const dbp = path.join(home, 'store', 'x.db');
  const r = portable.ingestFile(dbp, file, { source: 'notes', dryRun: true, redact: REDACT });
  assert.equal(r.chunks, 2);
  assert.equal(r.inserted, 2);
  assert.equal(r.redacted, 1);
  assert.equal(fs.existsSync(dbp), false);
});

test('非法 redact 正则 → exitCode 1（在 apply/CLI 就炸，不等入库）', () => {
  assert.throws(() => core.compileRedact(['(']), (e) => e.exitCode === 1);
  const { home, ws } = seedSecrets(tmpHome(), 'ws-badre');
  const r = runCliRaw(['ingest', '--home', home, '--workspace', ws, '--redact', '(']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /非法 redact 正则/);
});
