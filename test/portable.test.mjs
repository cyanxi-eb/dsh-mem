/** 可移植性：export/import NDJSON 往返、幂等、schema 校验、ingest --file。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../lib/core.mjs';
import * as portable from '../lib/portable.mjs';
import { runCliRaw, tmpHome } from '../support/helpers.mjs';

function seedDocs(home, ws) {
  const a = path.join(home, 'handbook.md');
  const b = path.join(home, 'changelog.txt');
  fs.writeFileSync(a, [
    '# 手册',
    '',
    '第一段：Router Worker 的分工决定是 Worker 写库，Router 只查。',
    '',
    '第二段：trigram 只对 ≥3 字符生效，提权两个字走 LIKE 兜底。库放 $DSH_HOME/mem，删掉重跑 ingest 可 100% 重建。',
  ].join('\n'));
  fs.writeFileSync(b, 'v0.1.0 跑通了，退出码 0。\n\n尾段：内存 1.33 MB。\n');
  const dbp = path.join(home, 'store', 'mem.db');
  return { a, b, dbp };
}

test('ingest --file：按段落切块、tags 打 source、重复跑幂等', () => {
  const home = tmpHome();
  const { a, b, dbp } = seedDocs(home, 'ws-file');

  const r1 = portable.ingestFile(dbp, a, { source: 'handbook' });
  assert.equal(r1.chunks, 3);
  assert.equal(r1.inserted, 3);
  assert.match(r1.session, /^file:handbook@[0-9a-f]{8}$/);

  const r2 = portable.ingestFile(dbp, b, { source: 'changelog' });
  assert.equal(r2.inserted, 2);

  const db = core.openDb(dbp);
  try {
    const tags = db.prepare(`SELECT DISTINCT tags FROM turn ORDER BY tags`).all().map((x) => x.tags);
    assert.deepEqual(tags, ['|agent|source:changelog|', '|agent|source:handbook|']);

    const hit = core.search(db, 'Router Worker', 3);
    assert.equal(hit.hits, 1);
    assert.match(hit.results[0].pointer, /^file:handbook@[0-9a-f]{8}#seq=2$/, '第二段（空行分隔）应落在 seq=2');

    const again = portable.ingestFile(dbp, a, { source: 'handbook' });
    assert.equal(again.inserted, 0, '同一份文件重复 ingest 必须 0 新增');
    assert.equal(core.turnCount(core.openDb(dbp)), 5);
  } finally { db.close(); }
});

test('round-trip：export → 删库 → import，stats 轮次与 search 前 3 条完全一致', () => {
  const home = tmpHome();
  const { a, b, dbp } = seedDocs(home, 'ws-rt');
  portable.ingestFile(dbp, a, { source: 'handbook' });
  portable.ingestFile(dbp, b, { source: 'changelog' });

  const query = 'Router Worker';
  const before = (() => {
    const db = core.openDb(dbp);
    try {
      return { stats: core.stats(db, dbp), search: core.search(db, query, 3), rows: core.search(db, 'trigram', 3) };
    } finally { db.close(); }
  })();

  const out = path.join(home, 'dump.ndjson');
  let db = core.openDb(dbp);
  const exp = portable.exportNdjson(db, { out, workspace: 'ws-rt' });
  db.close();
  assert.equal(exp.count, before.stats.turns);

  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  const header = JSON.parse(lines[0]);
  assert.equal(header.schema, 'dsh-mem/1');
  assert.equal(header.count, before.stats.turns);
  assert.deepEqual(Object.keys(JSON.parse(lines[1])).sort(),
    ['kind', 'role', 'seq', 'session', 'tags', 'text', 'ts'], '导出字段必须是 session,seq,role,ts,text,kind,tags');

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbp + suffix, { force: true });
  assert.equal(fs.existsSync(dbp), false, '库必须真的被删掉');

  db = core.openDb(dbp, { mustExist: false });
  const imp = portable.importNdjson(db, out);
  assert.equal(imp.inserted, before.stats.turns);
  assert.equal(imp.skipped, 0);

  const after = { stats: core.stats(db, dbp), search: core.search(db, query, 3), rows: core.search(db, 'trigram', 3) };
  db.close();

  assert.equal(after.stats.turns, before.stats.turns, '轮次必须一致');
  assert.equal(after.stats.sessions, before.stats.sessions, '会话数必须一致');
  assert.deepEqual(after.search.results, before.search.results, '前 3 条结果必须逐字段一致');
  assert.deepEqual(after.rows.results, before.rows.results);

  db = core.openDb(dbp);
  const again = portable.importNdjson(db, out);
  db.close();
  assert.equal(again.inserted, 0, '重复导入必须幂等');
  assert.equal(again.skipped, before.stats.turns);
});

test('import：schema 不匹配 / 坏行 → exitCode 4，且不写半截', () => {
  const home = tmpHome();
  const dbp = path.join(home, 'store', 'mem.db');
  const bad = path.join(home, 'bad.ndjson');
  fs.writeFileSync(bad, '{"schema":"dsh-mem/0","count":0}\n');

  const db = core.openDb(dbp, { mustExist: false });
  try {
    assert.throws(() => portable.importNdjson(db, bad), (e) => e.exitCode === 4 && /schema/.test(e.message));
    fs.writeFileSync(bad, '{"schema":"dsh-mem/1","count":2}\n{"session":"s","seq":1,"text":"ok"}\n{不是 JSON}\n');
    assert.throws(() => portable.importNdjson(db, bad), (e) => e.exitCode === 4);
  } finally { db.close(); }

  const r = runCliRaw(['import', bad, '--home', home, '--workspace', 'ws-bad']);
  assert.equal(r.status, 4);
  assert.equal(core.turnCount(core.openDb(dbp)), 0, '坏文件不得写入任何行');
});

test('CLI export/import --json：一条链跑通，dry-run 不写库', () => {
  const home = tmpHome();
  const { a } = seedDocs(home, 'ws-cli');
  portable.ingestFile(core.dbPathOf(home, 'ws-cli'), a, { source: 'handbook' });

  const out = path.join(home, 'cli.ndjson');
  const ex = JSON.parse(runCliRaw(['export', '--out', out, '--json', '--home', home, '--workspace', 'ws-cli']).stdout);
  assert.equal(ex.count, 3);

  const dryHome = tmpHome();
  const dryWs = 'ws-cli-dry';
  const dry = runCliRaw(['import', out, '--dry-run', '--json', '--home', dryHome, '--workspace', dryWs]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).inserted, 3);
  assert.equal(fs.existsSync(core.dbPathOf(dryHome, dryWs)), false, 'dry-run 不得建库');

  const real = runCliRaw(['import', out, '--json', '--home', dryHome, '--workspace', dryWs]);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(JSON.parse(real.stdout).inserted, 3);
  const st = JSON.parse(runCliRaw(['stats', '--json', '--home', dryHome, '--workspace', dryWs]).stdout);
  assert.equal(st.turns, 3);
});
