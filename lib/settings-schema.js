/**
 * settings-schema.js — 面板设置项的**值域与消毒**（宿主侧）。
 *
 * 这里**没有默认值**。默认值唯一来源是 `index.mjs` 的 `DEFAULTS`（用户已定：
 * rerank:'lexical'、embeddingFailFast:true …），本文件只描述"什么值算合法"。
 * 于是面板显示用的默认值只能从 `/dsh-mem/panel/state` 返回的 `config` 取 ——
 * 不再存在"两份真相"（曾经这里有一份 PANEL_DEFAULTS，与核心默认值漂成了两套）。
 *
 * 为什么客户端不能 import 本文件：lib/client.js 是 `window.__ModuleLoader__.load(...)`
 * 的纯 loader 脚本（无 import/export）。所以 UI 文案在 client.js 里另有一份；
 * **键集合**由 `test/client-smoke.mjs` 逐字对账，**默认值**只跟核心走。
 *
 * 约束：浏览器安全 —— 无 import / 无 Node API / 无顶层副作用。
 */

/** 重排模式的白名单（顺序即面板下拉顺序）。 */
export const RERANK_MODES = Object.freeze(['off', 'lexical', 'embedding']);

/** 两个数字项的硬边界；面板与宿主共用同一组数，不许各写一份。 */
export const BOUNDS = Object.freeze({
  episodeClosureMinutes: Object.freeze({ min: 1, max: 1440, step: 1 }),
  episodeMaxChars: Object.freeze({ min: 200, max: 20000, step: 100 }),
});

/** 字符串项的长度上限（防手改 config 塞进一整本书）。 */
export const STRING_LIMITS = Object.freeze({ embeddingModel: 120, embeddingModelDir: 512 });

/**
 * 面板能写的键（= PUT 的白名单）—— **只是键名，不带值**。
 * 值永远从调用方传进来的 base（核心 `normalizeConfig()` 的结果）里取。
 */
export const PANEL_KEYS = Object.freeze([
  'rerank',
  'rerankLexical',
  'episodeEnabled',
  'episodeClosureMinutes',
  'episodeMaxChars',
  'embeddingEnabled',
  'embeddingModel',
  'embeddingModelDir',
  'embeddingFailFast',
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** base 必须能提供全部 9 个键的真实值 —— 缺一个就是调用方接错了线，当场报错别静默补默认。 */
function requireBase(base) {
  if (!base || typeof base !== 'object') {
    throw new TypeError('sanitizePanelConfig/effectiveRerank 需要 base = index.mjs 的 DEFAULTS 归一化结果（本文件不再持有默认值）');
  }
  const missing = PANEL_KEYS.filter((k) => !hasOwn(base, k));
  if (missing.length) {
    throw new TypeError(`base 缺 ${missing.join(', ')} —— 默认值唯一来源是 index.mjs 的 DEFAULTS，别在这里补`);
  }
  return base;
}

/** 数字：接受 number 或数字字符串；非有限值回落 base；越界收束到边界（不静默改默认）。 */
function clampInt(value, bound, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bound.max, Math.max(bound.min, Math.round(n)));
}

function clampString(value, max, fallback) {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (!s) return fallback === '' ? '' : fallback;
  return s.slice(0, max);
}

/**
 * 把任意输入消毒成一份**完整**的面板配置（恰好 9 键，键序 = PANEL_KEYS）。
 * @param {object} input 可能只带几个键（PUT 的 patch），也可能是脏的磁盘值
 * @param {object} base  合并基线：核心 `normalizeConfig()` 的结果（必传）
 * @returns {{ config: object, ignored: string[] }} ignored = 不认识的键（宿主照报，不静默丢）
 */
export function sanitizePanelConfig(input, base) {
  const from = requireBase(base);
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const config = {};
  for (const key of PANEL_KEYS) config[key] = from[key];
  const ignored = [];
  for (const key of Object.keys(src)) if (!PANEL_KEYS.includes(key)) ignored.push(key);

  if (hasOwn(src, 'rerank')) {
    config.rerank = RERANK_MODES.includes(src.rerank) ? src.rerank : from.rerank;
  }
  for (const key of ['rerankLexical', 'episodeEnabled', 'embeddingEnabled', 'embeddingFailFast']) {
    if (hasOwn(src, key) && typeof src[key] === 'boolean') config[key] = src[key];
  }
  for (const key of Object.keys(BOUNDS)) {
    if (hasOwn(src, key)) config[key] = clampInt(src[key], BOUNDS[key], from[key]);
  }
  if (hasOwn(src, 'embeddingModel')) {
    config.embeddingModel = clampString(src.embeddingModel, STRING_LIMITS.embeddingModel, from.embeddingModel);
  }
  if (hasOwn(src, 'embeddingModelDir')) {
    const raw = typeof src.embeddingModelDir === 'string' ? src.embeddingModelDir.trim() : from.embeddingModelDir;
    config.embeddingModelDir = raw.slice(0, STRING_LIMITS.embeddingModelDir); // 空串合法 = 默认目录
  }
  return { config, ignored };
}

/**
 * 当前**生效**的重排模式（与面板上显示的那一行同一个答案）。
 *
 * 语义（面板 / 宿主 / 文档三处必须一致）：
 *   · rerank = 'off'       → 不重排；
 *   · rerank = 'lexical'   → 受 rerankLexical 支配；关掉子开关 = off（并标记 degraded）；
 *   · rerank = 'embedding' → 模型在就用向量层；模型不在绝不假装成功：
 *     有词面就退回 lexical（degraded + reason），词面也关就 off。
 * @param {object} config 完整 9 键配置（核心归一化结果）
 * @param {{ modelPresent?: boolean }} caps 宿主探测到的能力（模型是否落盘）
 * @returns {{ mode: 'off'|'lexical'|'embedding', degraded: boolean, reason: string }}
 */
export function effectiveRerank(config = {}, caps = {}) {
  const c = requireBase(config);
  const lexical = c.rerankLexical ? 'lexical' : 'off';
  if (c.rerank === 'lexical') {
    return c.rerankLexical
      ? { mode: 'lexical', degraded: false, reason: '' }
      : { mode: 'off', degraded: true, reason: '词面重排子开关关闭' };
  }
  if (c.rerank === 'embedding') {
    if (!caps.modelPresent) return { mode: lexical, degraded: true, reason: '向量模型未下载，已退回词面重排' };
    if (!c.embeddingEnabled) return { mode: lexical, degraded: true, reason: '向量层未启用（embeddingEnabled=false），已退回词面重排' };
    return { mode: 'embedding', degraded: false, reason: '' };
  }
  return { mode: 'off', degraded: false, reason: '' };
}
