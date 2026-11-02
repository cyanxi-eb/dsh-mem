/**
 * 12 条自然语言查询的评测脚本（不是测试用例，node --test 不会跑 support/）。
 *
 *   node support/eval12.mjs <db 文件> <home> <workspace>
 *
 * 三档一起打印，回答两个判据：
 *   before（老实现，冻结在 support/mem.legacy.mjs）→ P0（切分修复，rerank:'off'）→ P2（词面重排）
 * 老实现没有导出函数，只能按 CLI 跑（它同时是等价性测试的基准）。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { QUERIES12, recallAt3 } from './queries12.mjs';

const [dbp, home, ws] = process.argv.slice(2);
if (!dbp || !home || !ws) {
  console.error('用法: node support/eval12.mjs <db> <home> <workspace>');
  process.exit(1);
}
const LEGACY = fileURLToPath(new URL('./mem.legacy.mjs', import.meta.url));
const db = core.openDb(dbp);
const textOf = (pointer) => core.openPointer(db, pointer, 0).rows[0].text;

function runNew(rerank) {
  return (q, k) => {
    const r = core.search(db, q, k, { rerank });
    return { ...r, rows: r.results.map((x) => ({ pointer: x.pointer, text: textOf(x.pointer) })) };
  };
}
function runLegacy(q, k) {
  const out = execFileSync(process.execPath,
    [LEGACY, 'search', q, '--k', String(k), '--json', '--home', home, '--workspace', ws], { encoding: 'utf8' });
  const r = JSON.parse(out);
  return { ...r, rows: (r.results ?? []).map((x) => ({ pointer: x.pointer, text: textOf(x.pointer) })) };
}

const before = recallAt3(runLegacy);
const p0 = recallAt3(runNew('off'));
const p2 = recallAt3(runNew('lexical'));

const fmt = (name, r) => `${name.padEnd(8)} R@3=${r.r3.toFixed(3)}  (${r.hit}/${r.n})`;
console.log(`${fmt('before', before)}\n${fmt('P0', p0)}\n${fmt('P2', p2)}`);
console.log(`\nΔ(P2−P0) = ${(p2.r3 - p0.r3).toFixed(3)}`);
console.log(`\n逐条：`);
for (let i = 0; i < QUERIES12.length; i++) {
  const b = before.rows[i]; const a = p0.rows[i]; const c = p2.rows[i];
  console.log(`${c.ok ? '✔' : (a.ok ? '△' : '✘')} ${QUERIES12[i].q}`);
  console.log(`     before hits=${b.hits}  P0 ${a.ok ? '✔' : '✘'} hits=${a.hits} mode=${a.mode}  P2 ${c.ok ? '✔' : '✘'} hits=${c.hits}`);
}
db.close();
