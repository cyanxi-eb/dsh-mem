/**
 * 面板冒烟：不重启宿主，直接在 Node 里把 lib/client.js 真跑一遍。
 *
 * 思路（借 dsh-agent-soul 的 echo-smoke）：client.js 是 `window.__ModuleLoader__.load(...)`
 * 的纯脚本 —— 所以 mock 一个 window / require("react") / fetch，取到注册回调和组件，
 * 用一个 70 行的迷你 renderer 真的把 React 元素树展开，数控件、读文案。
 *
 * 断言四条：
 *   ① load 的 id 逐字等于包名 dsh-mem（id ≠ 包名会让整个 web boot 不激活）；
 *   ② 至少渲染出 8 个设置项控件（input/select）；
 *   ③ 取数失败时不抛异常，降级成「读取失败：<服务端原文>」；
 *   ④ 面板字段表与 lib/settings-schema.js 的键集合 / 默认值逐项一致（防漂）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PANEL_KEYS, sanitizePanelConfig } from '../lib/settings-schema.js';
import { DEFAULTS } from '../index.mjs';

/** 默认值的唯一来源是 index.mjs 的 DEFAULTS（settings-schema 已不再持有默认值）。 */
const PANEL_DEFAULTS = Object.fromEntries(PANEL_KEYS.map((k) => [k, DEFAULTS[k]]));

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const CLIENT_SRC = readFileSync(CLIENT_PATH, 'utf8');
let runtime = null; // 每个用例一套新的 fiber（钩子状态不能跨用例复用）

// ── 迷你 react：只实现面板用到的那 5 个钩子 + createElement ──────────────────────
function createReact() {
  let current = null;
  const fibers = new Map();

  const fiberFor = (key) => {
    if (!fibers.has(key)) fibers.set(key, { hooks: [], deps: [], i: 0, effects: [], dirty: false });
    return fibers.get(key);
  };
  const sameDeps = (prev, deps) => {
    if (!deps) return false; // 无 deps = 每次渲染都跑
    if (!prev) return false;
    return deps.length === prev.length && deps.every((d, k) => Object.is(d, prev[k]));
  };

  const React = {
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? (props && props.children) : (children.length === 1 ? children[0] : children);
      return { $$el: true, type, props: { ...(props || {}), children: kids } };
    },
    Fragment: "Fragment",
    useState(init) {
      const f = current; const i = f.i++;
      if (!(i in f.hooks)) f.hooks[i] = typeof init === "function" ? init() : init;
      const set = (v) => { f.hooks[i] = typeof v === "function" ? v(f.hooks[i]) : v; f.dirty = true; };
      return [f.hooks[i], set];
    },
    useRef(init) {
      const f = current; const i = f.i++;
      if (!(i in f.hooks)) f.hooks[i] = { current: init };
      return f.hooks[i];
    },
    useMemo(fn, deps) {
      const f = current; const i = f.i++;
      if (!sameDeps(f.deps[i], deps)) { f.hooks[i] = fn(); f.deps[i] = deps ? deps.slice() : null; }
      return f.hooks[i];
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const f = current; const i = f.i++;
      if (!sameDeps(f.deps[i], deps)) { f.deps[i] = deps ? deps.slice() : null; f.effects.push(fn); }
    },
  };

  let pending = [];
  function expand(node, key) {
    if (Array.isArray(node)) return node.map((n, i) => expand(n, `${key}.${i}`));
    if (node == null || typeof node !== "object" || !node.$$el) return node;
    if (typeof node.type === "function") {
      const f = fiberFor(key);
      const prev = current;
      current = f; f.i = 0; f.effects = [];
      let out;
      try { out = node.type(node.props); } finally { current = prev; }
      pending.push([f, f.effects]);
      return expand(out, `${key}/`);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${key}/`) } };
  }

  async function render(Component, props, rounds = 14) {
    let tree;
    for (let round = 0; round < rounds; round += 1) {
      pending = [];
      tree = expand(React.createElement(Component, props), "root");
      for (const [, list] of pending) for (const fn of list) fn();
      await new Promise((r) => setTimeout(r, 5));
      const dirty = [...fibers.values()].some((f) => f.dirty);
      if (!dirty && round > 0) break;
    }
    return tree;
  }

  return { React, render };
}

function collect(tree, pred, out = []) {
  if (Array.isArray(tree)) { for (const n of tree) collect(n, pred, out); return out; }
  if (!tree || typeof tree !== "object") return out;
  if (pred(tree)) out.push(tree);
  collect(tree.props && tree.props.children, pred, out);
  return out;
}

function textOf(tree) {
  const parts = [];
  const walk = (n) => {
    if (n == null || n === false || n === true) return;
    if (typeof n === "string" || typeof n === "number") { parts.push(String(n)); return; }
    if (Array.isArray(n)) { for (const k of n) walk(k); return; }
    if (typeof n === "object") walk(n.props && n.props.children);
  };
  walk(tree);
  return parts.join(" ");
}

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const GOOD_STATE = {
  db: "C:\\Users\\test\\.dsh\\mem\\demo-dsh-mem.db",
  dbBytes: 1_365_000,
  sessions: 19,
  turns: 266,
  firstTs: 1_761_000_000_000,
  lastTs: 1_761_200_000_000,
  episodes: 66,
  sealed: 22,
  index: { uncoveredTurns: 0, danglingEpisodes: 0 },
  rerank: { mode: "lexical", effective: "lexical", degraded: false, reason: "" },
  embedding: { enabled: false, available: true, model: "bge-small-zh-v1.5", modelDir: "C:\\m", modelPresent: false },
  config: { ...PANEL_DEFAULTS },
};

/** 装好 window/__ModuleLoader__/fetch，执行 client.js，返回注册结果和渲染树。 */
async function mountPanel({ fetchImpl }) {
  runtime = createReact();
  const loader = { id: "", factory: null };
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  globalThis.window = { __ModuleLoader__: { load(def) { loader.id = def.id; loader.factory = def.factory; } } };
  globalThis.fetch = fetchImpl;
  try {
    // eslint-disable-next-line no-new-func
    new Function("window", "document", CLIENT_SRC)(globalThis.window, { createElement: () => ({}), body: {} });
    assert.equal(typeof loader.factory, "function", "client.js 必须调用 __ModuleLoader__.load({ factory })");

    const fakeRequire = (id) => {
      if (id === "react") return runtime.React;
      throw new Error(`unexpected require: ${id}`);
    };
    const mod = loader.factory(fakeRequire);

    const registrations = [];
    const ctx = {
      slots: {
        inject(slot, cb) { assert.equal(slot, "settings.section"); return cb(); },
        register(options, factory) { registrations.push({ options, factory }); return () => {}; },
      },
    };
    mod.apply(ctx);
    assert.equal(registrations.length, 1, "apply 必须向 settings.section 注册恰好一个面板");
    const tree = await runtime.render(registrations[0].factory, null);
    return { loader, mod, registrations, tree };
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

test("① 注册 id 是包名 dsh-mem，且落点是 settings.section", async () => {
  const { loader, mod, registrations } = await mountPanel({ fetchImpl: async () => jsonRes(200, GOOD_STATE) });
  assert.equal(loader.id, "dsh-mem");
  assert.equal(mod.name, "dsh-mem");
  assert.deepEqual(mod.inject, ["slots"]);
  assert.equal(typeof mod.apply, "function");
  assert.equal(mod.default, mod.apply);
  assert.equal(registrations[0].options.name, "settings.section");
  assert.equal(registrations[0].options.id, "dsh-mem");
  assert.equal(typeof registrations[0].options.label(), "string");
  console.log(`[smoke] id=${loader.id} slot=${registrations[0].options.name} label=${registrations[0].options.label()}`);
});

test("② 至少渲染 8 个设置项控件，且键集合与 settings-schema 一致", async () => {
  const { mod, tree } = await mountPanel({ fetchImpl: async () => jsonRes(200, GOOD_STATE) });
  const controls = collect(tree, (n) => n.type === "input" || n.type === "select");
  const checkbox = controls.filter((n) => n.props && n.props.type === "checkbox").length;
  const selects = controls.filter((n) => n.type === "select").length;
  console.log(`[smoke] controls=${controls.length} (checkbox=${checkbox}, select=${selects})`);
  assert.ok(controls.length >= 8, `设置项控件至少 8 个，实际 ${controls.length}`);

  const panelKeys = mod.panelMeta.fields.map((f) => f.key);
  assert.deepEqual(panelKeys, PANEL_KEYS, "面板字段键集合/顺序必须与 lib/settings-schema.js 一致");
  assert.deepEqual(mod.panelMeta.defaults, { ...PANEL_DEFAULTS }, "面板默认值必须与 settings-schema 一致");

  const text = textOf(tree);
  assert.ok(text.includes("266"), "状态卡应渲染 turn 数");
  assert.ok(text.includes("已封区间"), "状态卡应渲染已封区间");
});

test("③ 取数失败不抛异常，降级成错误文案（原文照显）", async () => {
  const { tree } = await mountPanel({
    fetchImpl: async () => { throw new Error("宿主不可达（ECONNREFUSED 127.0.0.1:0）"); },
  });
  const text = textOf(tree);
  console.log(`[smoke] error-text="${text.match(/读取失败：[^ ]*/)?.[0] || "(missing)"}"`);
  assert.ok(text.includes("读取失败"), "失败时必须显示「读取失败」文案而不是空白");
  assert.ok(text.includes("ECONNREFUSED"), "必须显示服务端错误原文，不能只写「失败」");
  const controls = collect(tree, (n) => n.type === "input" || n.type === "select");
  assert.ok(controls.length >= 8, "取数失败只影响状态区，设置控件仍应渲染");
});

test("④ settings-schema 消毒：越界收束、未知键回报", () => {
  const { config, ignored } = sanitizePanelConfig({
    rerank: "nope", episodeClosureMinutes: 99999, episodeMaxChars: 5,
    embeddingModel: "  x  ", embeddingModelDir: "  /tmp/m  ", bogus: 1,
  }, DEFAULTS);
  assert.equal(config.rerank, DEFAULTS.rerank, "非法模式回落核心默认值，不写脏值");
  assert.equal(config.episodeClosureMinutes, 1440, "上界收束");
  assert.equal(config.episodeMaxChars, 200, "下界收束");
  assert.equal(config.embeddingModel, "x");
  assert.equal(config.embeddingModelDir, "/tmp/m");
  assert.deepEqual(ignored, ["bogus"]);
  assert.throws(() => sanitizePanelConfig({ rerank: "off" }), /base/, "缺 base 直接报错：默认值不在这里");
});
