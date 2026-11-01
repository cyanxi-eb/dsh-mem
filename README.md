# dsh-mem

零依赖本地记忆层：**只回指针 + 原文切片**，不摘要、不转述、不开端口、不常驻、不调 API。
一个索引库（SQLite FTS5 trigram）从 DSH 自己的会话日志里派生出可复核的
`<sessionId>#seq=<n>` 指针；外加 NDJSON 迁移与入库前隐私闸。

- **DSH 插件**：`cordis.patch.yml` 一行插入，注册 `mem_search` / `mem_open` / `mem_ingest` / `mem_stats` 四个工具。
- **独立 CLI**：`dsh-mem <cmd>`，`node bin/dsh-mem.mjs <cmd>` 等价；吃纯文本不依赖 DSH。
- 只 import `node:*`（含 `node:sqlite`），**没有任何第三方依赖**。

## 三条不变量

- **I1 原文永不改写**：`turn.text` 是源记录 `content[].text` 的逐字镜像，只 `INSERT OR IGNORE`，永不 UPDATE。
- **I2 索引可丢弃**：删掉 `.db` 重跑 `ingest` 100% 重建；不存在"只有库里才有"的事实。
- **I3 只回指针 + 原文切片**：返回 `(sessionId, seq)` 与原文子串；不摘要、不补全、不推断。0 命中就返回 0。

> 红线：检索结果只用来判断"要不要展开"，**证据永远是 `open` 输出的原文**。

## 安装

### 作为 DSH 插件（推荐，GitHub 直装）

```
dsh plugin --profile <profile> add github:cyanxi-eb/dsh-mem
```

实测（DSH 0.2.1-rc.5）：`EXIT=0`，5.7s，只下载 1 个 tarball，装到
`<DSH_HOME>/profiles/<profile>/node_modules/dsh-mem`，package.json 的
`dsh.profile.bundles` 自动多出 `dsh-mem`，`--dump-config` 里出现 insert 条目与四个配置默认值。
**装完需重启 DSH**，4 个工具才会进工具表。

> ⚠️ 前置：`dsh plugin` 会 spawn **裸 `pnpm`**。若 `pnpm` 不在 PATH 上，裸命令行会报
> `'pnpm' is not recognized`。两条出路：把 pnpm 放进 PATH，或改用 GUI 的插件管理器
> （宿主自己会传内置 pnpm 路径）。同理 `dsh` 本身也常不在 PATH，可用
> `node "<DSH>/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin ...`。

### 作为独立 CLI（不依赖 DSH）

```bash
node bin/dsh-mem.mjs stats      # 仓库内直接用，零依赖
npm i -g dsh-mem                # 发布到 npm 之后可用（当前未发布）
```

CLI 与插件共用 `lib/core.mjs` 这一份实现，行为一致。

### 配置项

`package.json` 已声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 内容是：

```yaml
- insert:
    - id: dsh-mem
      name: 'dsh-mem'
      config: { workspace: '', storeDir: '', excludePaths: [], redact: [], autoIngest: false }
```

- `workspace` — 钉死的工作区绝对路径（例如 `'D:\dsh-sp1'`）；空 = 按下面的优先级链自动解析。**解析只有 `core.resolveWorkspace` 一份实现，CLI 与插件共用**：`workspace` 配置 > 宿主会话 `cwd`（`exec.agent.session.header.cwd` / `workingDirectory.get(session)`，取不到就跳过）> `process.cwd()` > profile 目录（`DSH_PROFILE_DIR` / `<DSH_HOME>/profiles/<DSH_PROFILE>`）
- `storeDir` — 库目录，空 = `<DSH_HOME>/mem`；换机器/换盘改这里
- `excludePaths` — ingest 时跳过的路径前缀
- `redact` — 入库前替换的正则数组（见下节）
- `autoIngest` — 默认 `false`：**不自动索引**，由你显式触发

插件只 `inject: ['tools']`；宿主没就绪的其它服务一概不声明（少一项 inject，就少一种"永远加载中"）。

## 命令（CLI）

```bash
dsh-mem ingest [--all] [--dry-run] [--json]          # 增量入库本工作区会话；--all 忽略水位全量重扫
dsh-mem ingest --file <path> [--source <name>]       # 吃 .md/.txt/.jsonl，按段落切块入库
dsh-mem search "Router Worker 分工" --k 8 [--json]   # 每条: score  sessionId#seq  [user|asst]  原文≤120字
dsh-mem open "07f38d2c-...-#seq=293" --context 2     # 按指针取回原文，可带前后各 N 轮
dsh-mem stats [--json]                               # 会话数 / 轮次 / 库大小 / 水位
dsh-mem export --out dump.ndjson [--json]            # 导出：首行 header + 一行一个 turn
dsh-mem import dump.ndjson [--dry-run] [--json]      # 导入：校验 schema、幂等
dsh-mem selftest                                     # 14 项自检（临时库，不碰真库）
```

全局旗标：`--workspace <path>`、`--home <dir>`（缺省 `$DSH_HOME` 再缺省 `~/.dsh`）、
`--store-dir <dir>`（缺省 `<home>/mem`）、`--exclude <glob>` / `--redact <regex>`（均可重复）。

退出码：`0` 正常 / `1` 用法 / `2` 指针不存在（附最近 3 个候选）/ `3` 读不到输入（sessions 目录、库、空库）/ `4` 解压或数据损坏。
**空结果不算成功**：空库、目录不存在一律非 0 退出并说明原因。

## 插件工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `mem_search` | `query`（必填）、`k` | `{query,k,hits,mode,results:[{pointer,session,seq,role,ts,score,promoted,snippet}]}` |
| `mem_open` | `pointer`（必填）、`context` | `{anchor,session,rows:[{id,seq,role,ts,text}],anchorId}` |
| `mem_ingest` | `file?`、`source?`、`dryRun?` | ingest 统计（无 `file` = 重扫本工作区会话） |
| `mem_stats` | 无 | 库路径/大小、会话数、轮次、fact 计数、水位 |

工作区由 `core.resolveWorkspace` 按固定优先级解析（配置 `workspace` → 宿主会话 `cwd` → `process.cwd()` → profile 目录），CLI 走同一个函数；一工作区一库，按 `<hash8>-<目录名>.db` 分片。

## 隐私闸（入库前生效，不是事后过滤）

```yaml
config:
  redact: ['sk-[A-Za-z0-9]{20,}', 'ghp_[A-Za-z0-9]{36}']   # 命中整段替换成 [redacted]
  excludePaths: ['*scratch*', '*/private/*']                # 命中 glob 的会话/文件不解析、不入库、不写水位
```

CLI 等价写法：`--redact 'sk-[A-Za-z0-9]{20,}' --exclude '*scratch*'`。
先看再写：

```bash
dsh-mem ingest --dry-run --redact 'sk-[A-Za-z0-9]{20,}' --exclude '*scratch*'
# → [dry-run] workspace D:\x → 将入库 4 条、命中 redact 2 条、跳过 1 个路径；未写库
```

`--dry-run` 不建库、不抢锁、不推进水位；`ingest --file` 与 `import` 同样支持。

## 迁移（导出 → 换机 → 导入）

```bash
dsh-mem export --out mem.ndjson      # header {"schema":"dsh-mem/1","exportedAt":...,"workspace":...,"count":N}
dsh-mem import mem.ndjson --dry-run  # 先看会写多少行
dsh-mem import mem.ndjson            # UNIQUE(session,seq) + INSERT OR IGNORE ⇒ 幂等
```

导入只吃 `schema: "dsh-mem/1"`；字段固定 `session,seq,role,ts,text,kind,tags`；坏行/坏 schema 一律 exit 4 且不写半截。

## 从旧的内联 skill 迁过来

旧形态是 `skills/dsh-mem/scripts/mem.mjs` 一个文件。现在唯一实现是 `lib/core.mjs`：

- `skills/dsh-mem/SKILL.md` 改成一行 shim，原文留在 `SKILL.md.bak-inline`；
- `skills/dsh-mem/scripts/mem.mjs` 冻结为 `mem.mjs.deprecated`（另有 `deprecated.txt` 指针说明去向）；
- 逐字节等价由 `test/equivalence.test.mjs` 守着：老文件 `support/mem.legacy.mjs` 与新 CLI
  在同一库、同一批查询上输出完全一致（只把随机的 `"ms"` 归零）。

## 已知边界

- **跨工作区不检索**：一工作区一库。要合并请 `export/import` 到同一库（`session` 指针不冲突）。
- **无语义/同义词**：纯子串 trigram；换个说法就不命中。`NEAR` 在 trigram 下失效，多词只能 AND（空则 OR）。
- **`fact` 表不导出**：它只是"命中即加权的排序提示"，导出字段只有 `turn` 那 7 个；导入后 `promoted` 全为 false，
  原库里被 fact 提权的顺序可能不同。`prune`（降权淘汰）仍未实现。
- **`ingest --file` 的段落切分**：`.md/.txt` 按空行切、`.jsonl` 一行一条；`session = file:<source>@<内容hash8>`，
  文件改了就是一组新指针（守 I1，不覆盖旧原文）。
- **dry-run 的"将入库"** 是"文件里还没有的 `(session,seq)`"；会话 ingest 的 dry-run 不读水位，按实际库比对。
- **Node 版本**：`node:sqlite` 在 Node 22 需要 `--experimental-sqlite`，24+ 直接可用。CI 跑 24/26。
- **Windows 路径**：库名 `<hash8>-<目录名>.db` 的 hash 基于规范化后的工作区路径，换平台/换盘符就是另一个库。

## 验证（本机实测，2026-11-01）

| 项 | 结果 |
|---|---|
| `node --test` | 25 通过 / 0 失败 |
| `selftest` | 14 项全绿 |
| 等价性（真实库副本 266 轮 / 19 会话） | 5 条查询 + open + stats 逐字节一致 |
| 插件加载 | 4 个工具注册成功，宿主真实 `defineTool` 编译通过 |
| round-trip | export → 删库 → import：轮次一致，search 前 3 条逐字段一致 |
| 单查 | 3–5 ms（266 轮，1.3 MB 库） |

## License

MIT
