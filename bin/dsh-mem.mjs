#!/usr/bin/env node
/**
 * dsh-mem — CLI 入口。只做参数解析与打印，业务全部在 lib/core.mjs 与 lib/portable.mjs
 * （index.mjs 的宿主工具也调同一套，不存在第二份实现）。
 *
 * 退出码: 0 正常 | 1 用法错 | 2 指针不存在 | 3 读不到输入(目录/库/空库) | 4 解压或数据损坏
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from '../lib/core.mjs';
import * as portable from '../lib/portable.mjs';

const USAGE = `dsh-mem — 零依赖本地记忆层（真相源=sessions/*.zstd，库=纯派生索引）

  dsh-mem ingest [--all] [--dry-run] [--no-episodes] [--json] 增量入库（默认全部会话；--all 忽略水位全量重扫）
  dsh-mem ingest --file <path> [--source <name>] [--dry-run]  吃 .md/.txt/.jsonl，按段落切块入库
  dsh-mem search <query> [--k 8] [--rerank off|lexical] [--json]  回指针 + 原文切片
  dsh-mem open <sessionId#seq> [--context 2] [--json]        按指针取回原文（可带前后各 N 轮）
  dsh-mem open <sessionId#start-end> [--json]                按 episode 区间取回该区间全部原文
  dsh-mem episodes [--rebuild] [--json]                      列情景区间（session/区间/是否封/段数）
  dsh-mem stats [--json]                                     会话数/轮次/库大小/水位
  dsh-mem export --out <file.ndjson> [--json]                导出一行一个 turn（首行 header）
  dsh-mem import <file.ndjson> [--dry-run] [--json]          导入（校验 schema，幂等）
  dsh-mem selftest                                          自检（临时库，不碰真库）

  全局: --workspace <path>  --home <dir>  --store-dir <dir>
        --exclude <glob>（可重复）  --redact <regex>（可重复）
        --home 缺省读环境变量 DSH_HOME，再缺省 ~/.dsh；--store-dir 缺省 <home>/mem
`;

const FLAGS = new Set(['all', 'json', 'help', 'dry-run', 'no-episodes', 'rebuild']);
const VALUED = new Set(['workspace', 'home', 'store-dir', 'k', 'context', 'source', 'out', 'file', 'exclude', 'redact', 'rerank']);

export function parseArgs(argv) {
  const flags = new Set();
  const opts = { exclude: [], redact: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2);
    if (FLAGS.has(name)) { flags.add(name); continue; }
    if (!VALUED.has(name)) throw new core.AppError(`unknown flag: ${a}`, 1);
    const v = argv[++i];
    if (v === undefined) throw new core.AppError(`--${name} 需要一个值`, 1);
    if (name === 'exclude' || name === 'redact') opts[name].push(v);
    else opts[name] = v;
  }
  return { flags, opts, pos };
}

/** 配置优先级：CLI 旗标 > 环境变量 > 缺省。宿主插件那条路径用的是 cordis config。 */
function contextOf(opts) {
  const home = core.homeDir(opts);
  // 与插件同一个函数：--workspace > （宿主无会话，跳过）> process.cwd() > profile 目录
  const ws = core.resolveWorkspace({ workspace: opts.workspace, home });
  const storeDir = opts['store-dir'] || process.env.DSH_MEM_DIR || '';
  return {
    home, ws, storeDir,
    dbp: core.dbPathOf(home, ws, storeDir),
    excludePaths: opts.exclude,
    redact: opts.redact,
  };
}

function main(argv) {
  const { flags, opts, pos } = parseArgs(argv);
  const cmd = pos[0];
  const json = flags.has('json');
  const ctx = contextOf(opts);

  if (!cmd || cmd === 'help' || flags.has('help')) { process.stdout.write(USAGE); return 0; }
  if (cmd === 'selftest') return core.selftest().code;

  if (cmd === 'ingest') {
    if (opts.file) {
      const r = portable.ingestFile(ctx.dbp, opts.file, {
        source: opts.source || '', dryRun: flags.has('dry-run'), redact: ctx.redact, excludePaths: ctx.excludePaths,
        log: json ? () => {} : (s) => console.log(s),
      });
      if (json) { console.log(JSON.stringify(r, null, 1)); return 0; }
      if (r.excluded) { console.log(`[ingest-file] ${r.file} 命中 excludePaths → 跳过，未写库`); return 0; }
      if (r.dryRun) {
        console.log(`[dry-run] 文件 ${r.source}（${r.chunks} 段）→ 将入库 ${r.inserted} 条、命中 redact ${r.redacted} 条、跳过 0 个路径；未写库`);
      } else {
        console.log(`[ingest-file] ${r.source} → ${r.session}`);
        console.log(`  段 ${r.chunks}  新入库 ${r.inserted}  已存在跳过 ${r.skipped ?? 0}  redact ${r.redacted}  facts ${r.facts}`);
        console.log(`  库 ${r.dbPath}`);
      }
      return 0;
    }
    const r = core.ingest(ctx, {
      all: flags.has('all'), dryRun: flags.has('dry-run'),
      episodes: !flags.has('no-episodes'),
      excludePaths: ctx.excludePaths, redact: ctx.redact,
      log: json ? () => {} : (s) => console.log(s),
    });
    if (r.skippedLock) return 0;
    if (json) { console.log(JSON.stringify(r, null, 1)); return 0; }
    if (r.dryRun) {
      console.log(`[dry-run] workspace ${ctx.ws} → 将入库 ${r.turns} 条、命中 redact ${r.redacted} 条、跳过 ${r.excluded} 个路径；未写库`);
      console.log(`  （扫 ${r.sessions} 个会话，解压 ${(r.decodedBytes / 1048576).toFixed(2)} MB；dry-run 不读水位，只与实际库比对已有 session#seq）`);
      return 0;
    }
    console.log(`\n[ingest] workspace ${ctx.ws}`);
    console.log(`[ingest] sessions ${r.sessions}  parsed ${r.parsed}  skipped(水位未变) ${r.skippedUnchanged}`
      + `  excluded ${r.excluded}  busy-skipped ${r.busySkips}  尾帧不完整 ${r.partial}`);
    console.log(`[ingest] 本次新增 turn ${r.turns}  facts ${r.facts}  redact ${r.redacted}  坏 JSON ${r.badJson}`
      + `  丢弃注入 ${r.dropped}  解压 ${(r.decodedBytes / 1048576).toFixed(2)} MB`);
    if (r.episodes) {
      console.log(`[ingest] episode 段 ${r.episodes.segments}  新建 ${r.episodes.created}  作废旧开区间 ${r.episodes.removed}`
        + `  封印 ${r.episodes.sealed}  闭合 ${r.episodes.closed}/${r.episodes.sessions} 会话  ${r.episodes.ms} ms`);
    }
    console.log(`[ingest] 库内合计 turn ${r.turnsTotal} (user ${r.user} / asst ${r.asst})  `
      + `db ${(r.dbBytes / 1048576).toFixed(2)} MB  ${r.ms} ms  ${r.dbPath}`);
    return 0;
  }

  if (cmd === 'search') {
    if (!pos[1]) throw new core.AppError('缺 <query>', 1);
    const rerank = opts.rerank ?? 'off';   // CLI 缺省 off：与冻结的老实现逐字节可比（插件那条路默认 lexical）
    if (!['off', 'lexical', 'embedding'].includes(rerank)) throw new core.AppError(`--rerank 只吃 off|lexical|embedding`, 1);
    const db = core.openDb(ctx.dbp);
    try {
      const r = core.search(db, pos[1], Number(opts.k ?? 8), { rerank });
      if (json) { console.log(JSON.stringify(r, null, 1)); return 0; }
      for (const x of r.results)
        console.log(`${String(x.score).padEnd(10)} ${x.pointer}  [${x.role}]  ${x.snippet}`);
      console.log(`\n命中 ${r.hits} 条 / 用时 ${r.ms} ms   (mode=${r.mode}, k=${r.k}, rerank=${rerank})`);
      return 0;
    } finally { db.close(); }
  }

  if (cmd === 'episodes') {
    const db = core.openDb(ctx.dbp);
    try {
      const build = core.buildEpisodes(db, ctx, {
        all: flags.has('rebuild'), log: json ? () => {} : (s) => console.log(s),
      });
      const r = core.listEpisodes(db, { limit: 500 });
      if (json) { console.log(JSON.stringify({ ...r, build }, null, 1)); return 0; }
      console.log(`[episodes] ${r.count} 段（封印 ${r.sealed} / 开放 ${r.open}）  覆盖 turn ${r.turnsCovered}`);
      for (const e of r.episodes)
        console.log(`${e.seal ? 'sealed' : 'open  '}  ${e.pointer}  turns=${e.turns} chars=${e.chars}  gen=${e.genVersion}`);
      console.log(`[episodes] build: 新建 ${build.created} 作废 ${build.removed} 封印 ${build.sealed}`
        + `  partialTail 跳过 ${build.skippedPartial} 无源日志 ${build.noSource}  ${build.ms} ms`);
      return 0;
    } finally { db.close(); }
  }

  if (cmd === 'open') {
    if (!pos[1]) throw new core.AppError('缺 <sessionId#seq> 或 <sessionId#start-end>', 1);
    const db = core.openDb(ctx.dbp);
    try {
      if (core.parseEpisodePointer(pos[1])) {              // 区间指针 → 回该区间全部原文
        const r = core.openEpisode(db, pos[1]);
        if (json) { console.log(JSON.stringify(r, null, 1)); return 0; }
        console.log(`[区间] ${r.anchor}  共 ${r.rows.length} 条原文（未摘要）`);
        for (const row of r.rows) {
          console.log(`--- ${r.session}#seq=${row.seq}  [${row.role}]`);
          console.log(row.text);
          console.log('');
        }
        return 0;
      }
      const r = core.openPointer(db, pos[1], Number(opts.context ?? 2));
      if (json) { console.log(JSON.stringify(r, null, 1)); return 0; }
      r.rows.forEach((row, i) => {
        const mark = row.id === r.anchorId ? '  ← 命中' : '';
        console.log(`[${i + 1}/${r.rows.length}] ${r.session}#seq=${row.seq}  [${row.role}]${mark}`);
        console.log(row.text);
        console.log('');
      });
      return 0;
    } finally { db.close(); }
  }

  if (cmd === 'stats') {
    const db = core.openDb(ctx.dbp);
    try {
      const s = core.stats(db, ctx.dbp);
      if (json) { console.log(JSON.stringify(s, null, 1)); return 0; }
      console.log(`库        ${s.db}  ${(s.dbBytes / 1048576).toFixed(2)} MB`);
      console.log(`会话数    ${s.sessions}（水位记录 ${s.watermark.length}）`);
      console.log(`轮次      ${s.turns}  (user ${s.user} / asst ${s.asst})`);
      console.log(`事实      live ${s.factLive} / total ${s.factTotal}`);
      console.log(`时间跨度  ${s.firstTs ? new Date(s.firstTs).toISOString() : '-'} → ${s.lastTs ? new Date(s.lastTs).toISOString() : '-'}`);
      console.log(`水位      ${s.watermark.length} 个会话已记录（最近 ${s.watermark.length ? new Date(s.watermark.at(-1).mtimeMs).toISOString() : '-'}）`);
      return 0;
    } finally { db.close(); }
  }

  if (cmd === 'export') {
    const db = core.openDb(ctx.dbp);
    try {
      const r = portable.exportNdjson(db, {
        out: opts.out || '-', workspace: ctx.ws, log: json ? () => {} : (s) => console.error(s),
      });
      if (json) console.log(JSON.stringify(r, null, 1));
      else if (r.out !== '-') console.log(`[export] ${r.count} 轮 → ${r.out}  ${(r.bytes / 1048576).toFixed(2)} MB`);
      return 0;
    } finally { db.close(); }
  }

  if (cmd === 'import') {
    if (!pos[1]) throw new core.AppError('缺 <file.ndjson>', 1);
    const dryRun = flags.has('dry-run');
    const db = dryRun ? ctx.dbp : core.openDb(ctx.dbp, { mustExist: false });
    try {
      const r = portable.importNdjson(db, pos[1], { dryRun, redact: ctx.redact });
      if (json) { console.log(JSON.stringify(r, null, 1)); return 0; }
      if (dryRun) {
        console.log(`[dry-run] ${r.file} → 将入库 ${r.inserted} 条、命中 redact 0 条、跳过 ${r.skipped} 个已有行；未写库`);
      } else {
        console.log(`[import] ${r.file}  读到 ${r.read} 行（header count ${r.headerCount ?? '-'}）`);
        console.log(`  新增 ${r.inserted}  已存在跳过 ${r.skipped}  redact ${r.redacted ?? 0}  facts ${r.facts ?? 0}`);
      }
      return 0;
    } finally { if (!dryRun) { try { db.close(); } catch { /* ignore */ } } }
  }

  throw new core.AppError(`unknown command: ${cmd}\n\n${USAGE}`, 1);
}

const invokedDirectly = !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof core.AppError) {
      console.error(e.message);
      process.exitCode = e.exitCode;
    } else {
      console.error(`fatal: ${e?.stack || e}`);
      process.exitCode = 70;
    }
  }
}

export { main };
