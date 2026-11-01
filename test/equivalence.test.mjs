/**
 * 等价性：老实现（test/fixtures/mem.legacy.mjs，原 mem.mjs 原样冻结）与新实现
 * 在同一个库、同一批查询上必须输出逐字节一致（只把随机的 "ms" 归零）。
 *
 * 两份夹具：
 *   1) 合成会话日志（CI 也能跑，任何时候都可比）；
 *   2) 本机真实库（存在才跑；这是"不破坏现有库"的实证：老库副本直接可读）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, addSession, asstTurn, tmpHome, userTurn } from '../support/helpers.mjs';

const LEGACY = path.join(ROOT, 'support', 'mem.legacy.mjs');
const NEW = path.join(ROOT, 'bin', 'dsh-mem.mjs');

const run = (script, args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const norm = (s) => s.replace(/"ms": [0-9.]+/g, '"ms": 0');

function compare(label, homeArg, ws, queries) {
  const env = ['--home', homeArg, '--workspace', ws];
  const diffs = [];
  for (const q of queries) {
    const oldOut = norm(run(LEGACY, ['search', q, '--k', '3', '--json', ...env]));
    const newOut = norm(run(NEW, ['search', q, '--k', '3', '--json', ...env]));
    if (oldOut !== newOut) diffs.push({ q, oldOut: oldOut.slice(0, 400), newOut: newOut.slice(0, 400) });
  }
  assert.deepEqual(diffs, [], `${label}: 查询结果必须逐字节一致`);
  return queries.length;
}

test('等价性（合成夹具）：同一库同一批查询，新旧输出逐字节一致', () => {
  const home = tmpHome('dsh-mem-equiv-');
  const ws = path.join(home, 'equiv-ws');
  addSession(home, ws, 'sess-a', [
    userTurn(1, '我们决定把 tokenizer 固定为 trigram，实测四层体检可以命中'),
    userTurn(2, 'Router Worker 的分工：Worker 写库，Router 只查'),
    asstTurn(3, '跑通了，退出码 0，库 1.33 MB，路径 D:\\dsh-sp1\\dsh-mem'),
    userTurn(4, '结论：bm25 只在 FTS 直接查询里用，别塞进 UNION 子查询'),
  ]);
  addSession(home, ws, 'sess-b', [
    userTurn(5, '提权那段的原话是什么'),
    asstTurn(6, '多帧 zstd：尾帧不完整时打 warn，且不推进水位'),
  ]);

  run(LEGACY, ['ingest', '--all', '--home', home, '--workspace', ws]);   // 老实现建库

  const queries = ['Router Worker', '四层体检', '提权', 'trigram', 'D:\\dsh-sp1'];
  const n = compare('合成夹具', home, ws, queries);

  const oldOpen = norm(run(LEGACY, ['open', 'sess-a#seq=1', '--context', '1', '--home', home, '--workspace', ws]));
  const newOpen = norm(run(NEW, ['open', 'sess-a#seq=1', '--context', '1', '--home', home, '--workspace', ws]));
  assert.equal(newOpen, oldOpen, 'open 输出必须逐字节一致');

  const oldStats = JSON.parse(run(LEGACY, ['stats', '--json', '--home', home, '--workspace', ws]));
  const newStats = JSON.parse(run(NEW, ['stats', '--json', '--home', home, '--workspace', ws]));
  assert.equal(newStats.turns, oldStats.turns);
  assert.equal(newStats.user, oldStats.user);
  assert.equal(newStats.asst, oldStats.asst);

  console.log(`[equiv] 合成夹具：${n} 条查询 + open + stats 全部逐字节一致（turns=${newStats.turns}）`);
});

test('等价性（本机真实库副本）：老库不改一行即可被新代码读', { skip: process.platform !== 'win32' ? '库名 hash 依赖 Windows 路径' : false }, () => {
  const src = path.join(os.homedir(), '.dsh', 'mem', '53fe3fff-dsh-sp1.db');
  if (!fs.existsSync(src)) { console.log('[equiv] 本机没有 53fe3fff-dsh-sp1.db，跳过'); return; }

  const home = tmpHome('dsh-mem-equiv-real-');
  const memDir = path.join(home, 'mem');
  fs.mkdirSync(memDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, path.join(memDir, path.basename(src) + suffix));
  }

  const ws = 'D:\\dsh-sp1';
  const queries = ['Router Worker', '四层体检', '提权', 'mem.mjs', '退出码'];
  const n = compare('真实库副本', home, ws, queries);

  const st = JSON.parse(run(NEW, ['stats', '--json', '--home', home, '--workspace', ws]));
  const stOld = JSON.parse(run(LEGACY, ['stats', '--json', '--home', home, '--workspace', ws]));
  assert.equal(st.turns, stOld.turns);
  assert.ok(st.turns > 200, `真实库应有 >200 轮（实际 ${st.turns}）`);
  console.log(`[equiv] 真实库副本：${n} 条查询逐字节一致；turns=${st.turns} sessions=${st.sessions} facts live=${st.factLive}`);
});
