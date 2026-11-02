/** 测试公用夹具（不是 *.test.mjs，不会被 node --test 当用例跑）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const tmpHome = (prefix = 'dsh-mem-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const lines = (arr) => Buffer.from(arr.map((o) => JSON.stringify(o)).join('\n') + '\n');

export const userTurn = (seq, text, time = 1000 + seq) =>
  ({ type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } });

export const asstTurn = (seq, text, time = 1000 + seq) =>
  ({ type: 'assistant/message', seq, time, data: { turn: 1, message: { content: [{ type: 'text', text }] } } });

/** 在 <home>/sessions/--<ws slug>--/<sid>/session.v4.jsonl.zstd 写一份会话日志。 */
export function addSession(home, ws, sid, records) {
  const dir = path.join(home, 'sessions', core.sessionDirName(ws), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(lines(records)));
}

// ── 事件层夹具：带事件流 + 可控 mtime 的会话日志 ─────────────────────────
export const ev = (type, seq, time = 1000 + seq) => ({ type, seq, time, data: {} });

/** 一个"完整 turn"：turn/start → user/message → assistant/message → step/end → turn/end。 */
export function turnBlock(base, userText, asstText, time = 1000 + base) {
  return [
    ev('turn/start', base, time),
    userTurn(base + 1, userText, time + 1),
    asstTurn(base + 2, asstText, time + 2),
    ev('step/end', base + 3, time + 3),
    ev('turn/end', base + 4, time + 4),
  ];
}

/** 写会话日志并钉死 mtime（闭合判据要看"距今多久"）。返回文件路径。 */
export function writeSession(home, ws, sid, records, { mtime } = {}) {
  const dir = path.join(home, 'sessions', core.sessionDirName(ws), sid);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, Buffer.isBuffer(records) ? records : zlib.zstdCompressSync(lines(records)));
  if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return f;
}

/** 往已有会话日志尾部追加一帧（模拟会话续写）。 */
export function appendSession(file, records) {
  fs.appendFileSync(file, zlib.zstdCompressSync(lines(records)));
}

/** 完好帧 + 半截尾帧：decodeZstd(allowPartialTail) 会打 partialTail=true。 */
export function withPartialTail(records) {
  const half = zlib.zstdCompressSync(Buffer.from('{"type":"turn/end","seq":9999}\n')).subarray(0, 8);
  return Buffer.concat([zlib.zstdCompressSync(lines(records)), half]);
}

export const cliPath = () => path.join(ROOT, 'bin', 'dsh-mem.mjs');

/** 跑 CLI 并返回 stdout（非 0 退出会抛）。 */
export function runCli(args, env = {}) {
  return execFileSync(process.execPath, [cliPath(), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
}

/** 跑 CLI，不关心退出码（用来断言非 0）。 */
export function runCliRaw(args, env = {}) {
  return spawnSync(process.execPath, [cliPath(), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
}

/** 一份可复用的两会话夹具：中文子串、短词、路径/版本，外加一条必须被丢弃的注入轮。 */
export function seedWorkspace(home, ws) {
  addSession(home, ws, 'sess-a', [
    userTurn(1, '我们决定把 tokenizer 固定为 trigram，实测四层体检可以命中'),
    { type: 'user/message', seq: 2, time: 1002, data: { content: [{ type: 'text', text: '注入的运行时上下文，必须丢掉' }], source: { kind: 'runtime-context' } } },
    asstTurn(3, '跑通了，退出码 0，库 1.33 MB'),
    userTurn(4, '结论：db 放 D:\\dsh-sp1\\dsh-mem\\lib\\core.mjs 旁边，v0.1.0 起生效'),
  ]);
  addSession(home, ws, 'sess-b', [
    userTurn(1, '提权那段的原话是什么'),
  ]);
  return { home, ws, dbp: core.dbPathOf(home, ws) };
}
