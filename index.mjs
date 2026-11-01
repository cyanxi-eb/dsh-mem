/**
 * dsh-mem — 宿主半（Cordis 插件入口）。
 *
 * 只注册 4 个工具，全部转调 lib/core.mjs 与 lib/portable.mjs；这里没有第二份实现。
 * 契约照已装插件抄：`inject = ['tools']` + `ctx.tools.register(defineTool({...}))`，
 * defineTool 优先从宿主的 @deepseek-ai/dsh-tools 解析，解析不到时用本文件的等价编译兜底
 * （参数规格只用到 string/integer/boolean 三种，编译规则与宿主 parameterSchemaSpecToJsonSchema 一致）。
 *
 * 配置（cordis.patch.yml 的 config 与本文件 defaults 同源）：
 *   workspace    钉死的工作区绝对路径，缺省 ''（空 = 按 core.resolveWorkspace 的优先级链解析）
 *   storeDir     库目录，缺省 $DSH_HOME/mem（旧库路径不变）
 *   excludePaths 入库时跳过的会话/文件路径 glob 数组，缺省 []
 *   redact       入库前替换的正则字符串数组，缺省 []（命中替换为 [redacted]）
 *   autoIngest   首次工具调用时后台 ingest 一次，缺省 false
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from './lib/core.mjs';
import * as portable from './lib/portable.mjs';

export const name = 'dsh-mem';
export const inject = ['tools'];

/** 与 cordis.patch.yml 的 config 同源；改这里要同步改那里。 */
export const DEFAULTS = {
  workspace: '',
  storeDir: '',
  excludePaths: [],
  redact: [],
  autoIngest: false,
};

const OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
};

// ───────────────────────────── defineTool 解析 ─────────────────────────────
function shimDefineTool(options) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, ...rest } = spec;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    name: options.name,
    description: options.description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    output: options.output,
    ...(typeof options.isConcurrencySafe === 'function' ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    execute: options.execute,
  };
}

let defineToolPromise = null;

export function loadDefineTool() {
  defineToolPromise ??= (async () => {
    const tries = [() => import('@deepseek-ai/dsh-tools')];
    if (process.env.DSH_TOOLS_PATH) {
      tries.push(() => import(pathToFileURL(process.env.DSH_TOOLS_PATH).href));
    }
    const roots = [process.resourcesPath || '', path.dirname(process.execPath) ? path.join(path.dirname(process.execPath), 'resources') : ''];
    for (const root of roots) {
      if (!root) continue;
      tries.push(() => import(pathToFileURL(path.join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href));
    }
    for (const attempt of tries) {
      try {
        const mod = await attempt();
        const fn = mod?.defineTool ?? mod?.default?.defineTool;
        if (typeof fn === 'function') return fn;
      } catch { /* 试下一个 */ }
    }
    console.warn('[dsh-mem] 未能解析 @deepseek-ai/dsh-tools，使用内置 defineTool 兜底（参数不预校验）');
    return shimDefineTool;
  })();
  return defineToolPromise;
}

// ───────────────────────────── 配置与上下文 ─────────────────────────────
export function normalizeConfig(config = {}) {
  const home = core.homeDir();
  return {
    workspace: config.workspace ? path.resolve(config.workspace) : '',
    storeDir: config.storeDir ? path.resolve(config.storeDir) : path.join(home, 'mem'),
    excludePaths: Array.isArray(config.excludePaths) ? config.excludePaths : [],
    redact: Array.isArray(config.redact) ? config.redact : [],
    autoIngest: config.autoIngest === true,
  };
}

/**
 * 宿主能提供的会话工作目录候选，按真实字段取；取不到就返回空数组（交给下一级），不猜。
 * - exec.agent.session.header.cwd：Session 的原始 cwd（宿主 dsh-working-directory 的 init 源）
 * - ctx.workingDirectory.get(session)：宿主已提交的当前目录（同步、无 IO、不改状态）
 */
function hostWorkspaces(ctx, exec) {
  const out = [];
  const session = (() => { try { return exec?.agent?.session; } catch { return undefined; } })();
  if (!session) return out;
  try { out.push(session.header?.cwd); } catch { /* ignore */ }
  try {
    const svc = ctx?.get?.('workingDirectory') ?? ctx?.workingDirectory;
    if (session && typeof svc?.get === 'function') out.push(svc.get(session));
  } catch { /* 服务未注入 → 跳过 */ }
  return out;
}

function libContext(ctx, cfg, exec) {
  const home = core.homeDir();
  const ws = core.resolveWorkspace({ workspace: cfg.workspace, host: hostWorkspaces(ctx, exec), home });
  return { home, ws, dbp: core.dbPathOf(home, ws, cfg.storeDir), cfg };
}

/** AppError → 结构化工具结果（模型能看到原因），其他异常照抛。 */
async function guard(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof core.AppError) return { error: e.message, exitCode: e.exitCode };
    throw e;
  }
}

// ───────────────────────────── 工具 ─────────────────────────────
export function toolSpecs(cfg, ctx) {
  /**
   * autoIngest：第一次工具调用时按当前工作区后台 ingest 一次；不阻塞本次调用。
   * （apply 时刻还没有会话 cwd，所以只能懒到第一次调用。）
   */
  const auto = { done: new Set() };
  const kickAutoIngest = (lc) => {
    if (!cfg.autoIngest || auto.done.has(lc.ws)) return;
    auto.done.add(lc.ws);
    const t = setTimeout(() => {
      try { core.ingest(lc, { excludePaths: cfg.excludePaths, redact: cfg.redact }); }
      catch (e) { console.warn('[dsh-mem] autoIngest:', e?.message || e); }
    }, 0);
    t.unref?.();
  };

  return [
    {
      name: 'mem_search',
      description: [
        'Search this machine\'s local DSH memory index (verbatim conversation log mirror, no LLM, no API).',
        'Returns pointers `<sessionId>#seq=<n>` plus a ≤120-char slice of the ORIGINAL text.',
        'Use it when you need "what did we say last time", a decision, an error message, a path or a version —',
        'then call mem_open on a pointer to read the full original turn.',
        'Never treat the slice as the quote: the evidence is mem_open\'s output.',
        '0 hits means 0 hits — do not guess.',
      ].join('\n'),
      parameters: {
        query: { type: 'string', required: true, description: 'Whitespace-split terms. ≥3 chars use trigram FTS (Chinese substrings work), <3 chars fall back to LIKE. Multiple terms are AND first, then OR.' },
        k: { type: 'integer', description: 'Max results, default 8.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return guard(async () => {
          const lc = libContext(ctx, cfg, exec);
          kickAutoIngest(lc);
          const db = core.openDb(lc.dbp);
          try { return core.search(db, String(args.query ?? ''), Number(args.k ?? 8)); }
          finally { db.close(); }
        });
      },
    },
    {
      name: 'mem_open',
      description: [
        'Open a memory pointer produced by mem_search and return the ORIGINAL turn text (verbatim, never summarized).',
        'Pass context>0 to also read the surrounding turns of the same session.',
      ].join('\n'),
      parameters: {
        pointer: { type: 'string', required: true, description: '`<sessionId>#seq=<n>` (also accepts `<sessionId>#<n>`).' },
        context: { type: 'integer', description: 'Turns before and after the anchor, default 2.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return guard(async () => {
          const lc = libContext(ctx, cfg, exec);
          const db = core.openDb(lc.dbp);
          try {
            const r = core.openPointer(db, String(args.pointer ?? ''), Number(args.context ?? 2));
            return { ...r, rows: r.rows.map(({ id, seq, role, ts, text }) => ({ id, seq, role, ts, text })) };
          } finally { db.close(); }
        });
      },
    },
    {
      name: 'mem_ingest',
      description: [
        'Refresh the local memory index. Without `file` it re-scans this workspace\'s DSH session logs (incremental, idempotent).',
        'With `file` it ingests a .md/.txt/.jsonl document (paragraph chunks, tagged `source:<name>`) — no DSH required.',
        'dryRun reports how many rows WOULD be written (plus redact/exclude counts) and writes nothing.',
      ].join('\n'),
      parameters: {
        file: { type: 'string', description: 'Optional local .md/.txt/.jsonl path. Omit to re-scan DSH session logs.' },
        source: { type: 'string', description: 'Source name for `file` mode; defaults to the file basename.' },
        dryRun: { type: 'boolean', description: 'Count only, write nothing.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return guard(async () => {
          const lc = libContext(ctx, cfg, exec);
          if (args.file) {
            return portable.ingestFile(lc.dbp, String(args.file), {
              source: args.source ? String(args.source) : '', dryRun: args.dryRun === true,
              redact: cfg.redact, excludePaths: cfg.excludePaths,
            });
          }
          return core.ingest(lc, { dryRun: args.dryRun === true, excludePaths: cfg.excludePaths, redact: cfg.redact });
        });
      },
    },
    {
      name: 'mem_stats',
      description: 'Index health for this workspace: db path/size, session count, turn counts, fact counts, ingest watermark.',
      parameters: {},
      output: OUTPUT,
      async execute(_args, exec) {
        return guard(async () => {
          const lc = libContext(ctx, cfg, exec);
          const db = core.openDb(lc.dbp);
          try { return core.stats(db, lc.dbp); } finally { db.close(); }
        });
      },
    },
  ];
}

// ───────────────────────────── 入口 ─────────────────────────────
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config ?? {});
  try { core.compileRedact(cfg.redact); }                       // 坏正则在这里就炸，不要等到入库
  catch (e) { console.warn('[dsh-mem] config.redact 无效，按空处理:', e?.message || e); cfg.redact = []; }

  const defineTool = await loadDefineTool();
  const tools = toolSpecs(cfg, ctx).map((spec) => defineTool(spec));

  let register = null;
  try { if (typeof ctx?.tools?.register === 'function') register = (tool) => ctx.tools.register(tool); } catch { /* 未 inject 时 cordis 代理抛 */ }
  if (!register) {
    try { const svc = ctx?.get?.('tools'); if (typeof svc?.register === 'function') register = (tool) => svc.register(tool); } catch { /* ignore */ }
  }
  if (!register) throw new Error('dsh-mem: 宿主没有 tools 服务（inject 未生效？）');

  const disposers = tools.map((tool) => register(tool));
  return () => {
    for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
  };
}

export default apply;
