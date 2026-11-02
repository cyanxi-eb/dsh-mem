/**
 * dsh-mem — 宿主半（Cordis 插件入口）。
 *
 * 只注册 5 个工具，全部转调 lib/core.mjs 与 lib/portable.mjs；这里没有第二份实现。
 * 契约照已装插件抄：`inject = ['tools']` + `ctx.tools.register(defineTool({...}))`，
 * 面板的 4 条 HTTP 路径（5 个 method）走 `ctx.inject(["webServer"], host => host.effect(...))`
 * 动态挂载（静态 inject 里**不放** webServer，否则 apply 会等一个后挂的服务，路由永远挂不上）。
 * defineTool 优先从宿主的 @deepseek-ai/dsh-tools 解析，解析不到时用本文件的等价编译兜底
 * （参数规格只用到 string/integer/boolean 三种，编译规则与宿主 parameterSchemaSpecToJsonSchema 一致）。
 *
 * 配置（cordis.patch.yml 的 config 与本文件 defaults 同源）：
 *   workspace    钉死的工作区绝对路径，缺省 ''（空 = 按 core.resolveWorkspace 的优先级链解析）
 *   storeDir     库目录，缺省 $DSH_HOME/mem（旧库路径不变）
 *   excludePaths 入库时跳过的会话/文件路径 glob 数组，缺省 []
 *   redact       入库前替换的正则字符串数组，缺省 []（命中替换为 [redacted]）
 *   autoIngest   首次工具调用时后台 ingest 一次，缺省 false
 *   rerank       'off' | 'lexical' | 'embedding'（embedding = RRF(词面, 向量)，k=60，见 core.searchEmbedding）
 *   rerankLexical 词面重排的独立开关（配合 rerank:'lexical'），缺省 true
 *   episodeEnabled / episodeClosureMinutes / episodeMaxChars  事件层（P1）
 *   embeddingEnabled / embeddingModel / embeddingModelDir / embeddingFailFast  向量层（P3）
 *
 * 默认值唯一来源就是下面的 DEFAULTS（lib/settings-schema.js 只留值域，不再留默认值）。
 * 面板落盘值 $DSH_HOME/mem/panel-config.json 在 apply 时叠在 loader config 之上。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from './lib/core.mjs';
import * as portable from './lib/portable.mjs';
import * as embed from './lib/embed.mjs';
import * as embedModels from './lib/embed-models.mjs';
import { RERANK_MODES } from './lib/settings-schema.js';
import { readPanelConfig, registerPanelRoutes } from './lib/panel-routes.mjs';

export const name = 'dsh-mem';
/**
 * 静态依赖只留 tools。webServer 走**动态注入**（与已装插件 dsh-purge 同一模式）：
 * 静态列进去会让整个 apply 卡在等 webServer 上，而宿主里 webServer 是后挂的，
 * 结果工具能注册、路由却一条也没挂上（`/dsh-mem/panel/state` 直接 404）。
 */
export const inject = ['tools'];

/** 与 cordis.patch.yml 的 config 同源；改这里要同步改那里（键名逐字绑定，面板按这些 key 写）。 */
export const DEFAULTS = {
  workspace: '',
  storeDir: '',
  excludePaths: [],
  redact: [],
  autoIngest: false,
  rerank: 'lexical',
  rerankLexical: true,
  episodeEnabled: true,
  episodeClosureMinutes: 10,
  episodeMaxChars: 4000,
  embeddingEnabled: false,
  embeddingModel: 'bge-small-zh-v1.5',
  embeddingModelDir: '',
  embeddingFailFast: true,
};

export { RERANK_MODES };                    // 老导出面保持可用（真源已搬到 lib/settings-schema.js）

const intIn = (v, def, min, max) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
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
    rerank: RERANK_MODES.includes(config.rerank) ? config.rerank : DEFAULTS.rerank,
    rerankLexical: config.rerankLexical !== false,
    episodeEnabled: config.episodeEnabled !== false,
    episodeClosureMinutes: intIn(config.episodeClosureMinutes, DEFAULTS.episodeClosureMinutes, 1, 1440),
    episodeMaxChars: intIn(config.episodeMaxChars, DEFAULTS.episodeMaxChars, 200, 20000),
    embeddingEnabled: config.embeddingEnabled === true,
    embeddingModel: typeof config.embeddingModel === 'string' && config.embeddingModel.trim()
      ? config.embeddingModel.trim().slice(0, 120) : DEFAULTS.embeddingModel,
    embeddingModelDir: typeof config.embeddingModelDir === 'string' ? config.embeddingModelDir.trim().slice(0, 512) : '',
    embeddingFailFast: config.embeddingFailFast !== false,
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

function libContext(ctx, cfg, exec, resolver) {
  const home = core.homeDir();
  const ws = core.resolveWorkspace({ workspace: cfg.workspace, host: hostWorkspaces(ctx, exec), home });
  resolver?.note?.(ws);
  return { home, ws, dbp: core.dbPathOf(home, ws, cfg.storeDir), cfg };
}

/** 面板路由没有会话上下文，只能记住"最近一次工具调用用的工作区"；一次都没调过才按 CLI 口径解析。 */
function makeContextResolver(cfg) {
  let lastWs = '';
  return {
    note(ws) { if (ws) lastWs = ws; },
    resolve() {
      const home = core.homeDir();
      const ws = lastWs || core.resolveWorkspace({ workspace: cfg.workspace, host: [], home });
      return { home, ws, dbp: core.dbPathOf(home, ws, cfg.storeDir), cfg };
    },
  };
}

// ───────────────────────── 检索（含 embedding 重排） ─────────────────────────
let degradedWarned = false;

/** 测试用：把"只 warn 一次"的闸门复位。 */
export function resetEmbeddingWarning() { degradedWarned = false; }

/** 向量层为什么用不了（'' = 能用）。原因要能直接贴给用户看。 */
async function embeddingBlocked(cfg) {
  if (cfg.embeddingEnabled !== true) return 'embeddingEnabled=false（向量层没打开）';
  if (!(await embed.isAvailable(cfg))) return '没有装可选依赖 @huggingface/transformers';
  const state = embedModels.modelState(cfg);
  if (!state.ok) return `模型没就位（${state.reason}）: ${state.dir}`;
  return '';
}

/**
 * mem_search 的唯一入口：rerank='embedding' 走 RRF(词面, 向量)，其余两条路原样转 core.search。
 *
 * 向量不可用时的口径（用户已定）：embeddingFailFast !== false → 结构化报错（exitCode 4）；
 * false → 静默退回词面重排，只 warn 一次。绝不点半截、绝不写零向量。
 */
export async function runSearch(db, query, k, cfg) {
  if (cfg.rerank !== 'embedding') {
    return core.search(db, query, k, { rerank: cfg.rerank, rerankLexical: cfg.rerankLexical });
  }
  const degrade = (reason) => {
    if (cfg.embeddingFailFast !== false) throw new core.AppError(`向量检索不可用：${reason}`, 4);
    if (!degradedWarned) {
      degradedWarned = true;
      console.warn(`[dsh-mem] 向量检索不可用（embeddingFailFast=false，退回词面重排）: ${reason}`);
    }
    return core.search(db, query, k, {
      rerank: cfg.rerankLexical ? 'lexical' : 'off', rerankLexical: cfg.rerankLexical,
    });
  };
  const why = await embeddingBlocked(cfg);
  if (why) return degrade(why);
  try {
    return await core.searchEmbedding(db, query, k, {
      rerankLexical: cfg.rerankLexical,
      // bge 官方查询指令前缀**不加**：30 条实测 0.400/0.256 vs 裸查询 0.567/0.333（_embed-eval/eval-out.json）
      embedFn: (texts) => embed.embedBatch(texts, { ...cfg, embeddingEnabled: true }),
    });
  } catch (e) {
    if (e instanceof embedModels.EmbedError || e instanceof core.AppError) return degrade(`${e.code || ''} ${e.message}`.trim());
    throw e;
  }
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
export function toolSpecs(cfg, ctx, resolver = null) {
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
          const lc = libContext(ctx, cfg, exec, resolver);
          kickAutoIngest(lc);
          const db = core.openDb(lc.dbp);
          try {
            return await runSearch(db, String(args.query ?? ''), Number(args.k ?? 8), cfg);
          } finally { db.close(); }
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
        pointer: { type: 'string', required: true, description: '`<sessionId>#seq=<n>` (also accepts `<sessionId>#<n>`), or an episode range `<sessionId>#<start>-<end>`.' },
        context: { type: 'integer', description: 'Turns before and after the anchor, default 2.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return guard(async () => {
          const lc = libContext(ctx, cfg, exec, resolver);
          const db = core.openDb(lc.dbp);
          try {
            if (core.parseEpisodePointer(args.pointer)) {      // 区间指针：整段原文，不做上下文扩展
              const r = core.openEpisode(db, String(args.pointer));
              return { ...r, rows: r.rows.map(({ id, seq, role, ts, text }) => ({ id, seq, role, ts, text })) };
            }
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
          const lc = libContext(ctx, cfg, exec, resolver);
          if (args.file) {
            return portable.ingestFile(lc.dbp, String(args.file), {
              source: args.source ? String(args.source) : '', dryRun: args.dryRun === true,
              redact: cfg.redact, excludePaths: cfg.excludePaths,
            });
          }
          return core.ingest(lc, {
            dryRun: args.dryRun === true, excludePaths: cfg.excludePaths, redact: cfg.redact,
            episodes: cfg.episodeEnabled, episodeClosureMinutes: cfg.episodeClosureMinutes, episodeMaxChars: cfg.episodeMaxChars,
          });
        });
      },
    },
    {
      name: 'mem_episodes',
      description: [
        'List episodic ranges (存的是区间，不是摘要): session / start-end / sealed / covered turns.',
        'Use a returned pointer `<sessionId>#<start>-<end>` with mem_open to read that range verbatim.',
        'An episode is a DERIVED index — the evidence is still the original turns mem_open returns.',
      ].join('\n'),
      parameters: {
        session: { type: 'string', description: 'Only this sessionId.' },
        limit: { type: 'integer', description: 'Max episodes, default 50.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return guard(async () => {
          const lc = libContext(ctx, cfg, exec, resolver);
          const db = core.openDb(lc.dbp);
          try {
            return core.listEpisodes(db, {
              session: args.session ? String(args.session) : '',
              limit: Number(args.limit ?? 50),
            });
          } finally { db.close(); }
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
          const lc = libContext(ctx, cfg, exec, resolver);
          const db = core.openDb(lc.dbp);
          try { return core.stats(db, lc.dbp); } finally { db.close(); }
        });
      },
    },
  ];
}

// ───────────────────────────── 入口 ─────────────────────────────
export async function apply(ctx, config) {
  const home = core.homeDir();
  const base = normalizeConfig(config ?? {});
  // 面板落盘值叠在 loader config 之上（面板是唯一写路径；不去改 profile 里的 cordis.patch.yml，
  // 那是安装产物，重装即回滚）。坏文件/脏值由 DEFAULTS 收束，绝不让 boot 跟着炸。
  let cfg = base;
  try { cfg = { ...base, ...readPanelConfig(home, base, { warn: (m) => console.warn(m) }) }; }
  catch (e) { console.warn('[dsh-mem] panel-config 读不了，按 loader config 走:', e?.message || e); }

  try { core.compileRedact(cfg.redact); }                       // 坏正则在这里就炸，不要等到入库
  catch (e) { console.warn('[dsh-mem] config.redact 无效，按空处理:', e?.message || e); cfg.redact = []; }

  const defineTool = await loadDefineTool();
  const resolver = makeContextResolver(cfg);
  const tools = toolSpecs(cfg, ctx, resolver).map((spec) => defineTool(spec));

  let register = null;
  try { if (typeof ctx?.tools?.register === 'function') register = (tool) => ctx.tools.register(tool); } catch { /* 未 inject 时 cordis 代理抛 */ }
  if (!register) {
    try { const svc = ctx?.get?.('tools'); if (typeof svc?.register === 'function') register = (tool) => svc.register(tool); } catch { /* ignore */ }
  }
  if (!register) throw new Error('dsh-mem: 宿主没有 tools 服务（inject 未生效？）');

  const disposers = tools.map((tool) => register(tool));

  // ───────────────────────── 面板路由（动态注入 webServer）─────────────────────────
  // 抄 dsh-purge/lib/index.js 的写法：ctx.inject(["webServer"], host => host.effect(...))。
  // 好处是 apply 不依赖 webServer 的时序：服务晚到也会挂上，卸载时 effect cleanup 一把全撤。
  const routeDeps = (active) => ({
    cfg: active,
    getContext: resolver.resolve,
    reindex: (lc) => core.ingest(lc, {
      excludePaths: active.excludePaths, redact: active.redact,
      episodes: active.episodeEnabled, episodeClosureMinutes: active.episodeClosureMinutes, episodeMaxChars: active.episodeMaxChars,
    }),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  });

  try {
    if (typeof ctx?.inject !== 'function') {
      console.error('[dsh-mem] ctx.inject 不可用，面板路由不注册（5 个工具照常）');
    } else {
      ctx.inject(['webServer'], (host) => {
        host.effect(() => {
          try {
            const dispose = registerPanelRoutes(host.webServer, routeDeps(cfg));
            console.log('[dsh-mem] panel routes registered: /dsh-mem/panel/*');
            return () => { try { dispose(); } catch { /* ignore */ } };
          } catch (e) {
            // 路径重复 / 服务形态不对：打印原文，别只写一句"失败了"
            console.error('[dsh-mem] panel routes: host.webServer.register failed:', e?.stack || e);
            return () => {};
          }
        }, 'dsh-mem: panel routes');
      });
    }
  } catch (e) {
    console.error('[dsh-mem] panel routes: ctx.inject(["webServer"]) failed:', e?.stack || e);
  }

  return () => {
    for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
  };
}

export default apply;
