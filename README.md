# dsh-mem

零依赖本地记忆层：**只回指针 + 原文切片**，不摘要、不转述、不开端口、不常驻、不调 API。
一个索引库（SQLite FTS5 trigram）从 DSH 自己的会话日志里派生出可复核的
`<sessionId>#seq=<n>` 指针；外加 NDJSON 迁移与入库前隐私闸。

- **DSH 插件**：`cordis.patch.yml` 一行插入，注册 `mem_search` / `mem_open` / `mem_ingest` / `mem_episodes` / `mem_stats` 五个工具。
- **独立 CLI**：`dsh-mem <cmd>`，`node bin/dsh-mem.mjs <cmd>` 等价；吃纯文本不依赖 DSH。
- 只 import `node:*`（含 `node:sqlite`），**没有任何第三方依赖**。

## 三层（0.2）

| 层 | 做什么 | 开关 | 判据（实测见下） |
|---|---|---|---|
| **P0 查询切分** | 整句中文 0 命中时切成相邻 bigram 再 OR；英文/路径整词保留。**先失败才切**，所以原本能命中的查询逐字节不变 | 常开（修 bug） | 12 条自然语言查询 R@3 0 → 0.333 |
| **P1 事件层 `episode`** | 只存「区间 + 指纹」，**不存摘要文本**；摘要要就现算。幂等 pass 扫 `turn` 生成，已封区间永不修改 | `episodeEnabled` 等 | 覆盖 turn 100%，复跑新增 0 |
| **P2 词面重排** | 字符 2+3gram TF-IDF 余弦，**只对 P0 的候选集重排**，不单独当入口 | `rerank` / `rerankLexical` | R@3 0.333 → 0.667（Δ=0.334） |

- **P3 向量层只留门**：`embedding*` 四个键已经进 config 与 `normalizeConfig`，但 `lib/embed.mjs` 不接线；`rerank:'embedding'` 当前按 `off` 处理（缺模型不许假装有）。
- `rerank` 的**缺省口径**：插件 config 默认 `'lexical'`；**CLI 默认 `'off'`**（CLI 没有配置文件，且要能跟冻结的老实现逐字节对账，`--rerank lexical` 显式打开）。


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
**装完需重启 DSH**，5 个工具才会进工具表，面板挂到「设置 → 记忆库（dsh-mem）」（见下节）。

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
      config:
        workspace: ''            # 钉死工作区；空 = 优先级链
        storeDir: ''             # 库目录；空 = $DSH_HOME/mem
        excludePaths: []         # 入库时跳过的路径 glob
        redact: []               # 入库前替换的正则
        autoIngest: false        # 首次工具调用时后台 ingest 一次
        rerank: 'lexical'        # 'off' | 'lexical' | 'embedding'（向量 = RRF(词面,向量)，k=60）
        rerankLexical: true
        episodeEnabled: true
        episodeClosureMinutes: 10
        episodeMaxChars: 4000
        embeddingEnabled: false
        embeddingModel: 'bge-small-zh-v1.5'
        embeddingModelDir: ''
        embeddingFailFast: true
```

- `workspace` — 钉死的工作区绝对路径（例如 `'D:\dsh-sp1'`）；空 = 按下面的优先级链自动解析。**解析只有 `core.resolveWorkspace` 一份实现，CLI 与插件共用**：`workspace` 配置 > 宿主会话 `cwd`（`exec.agent.session.header.cwd` / `workingDirectory.get(session)`，取不到就跳过）> `process.cwd()` > profile 目录（`DSH_PROFILE_DIR` / `<DSH_HOME>/profiles/<DSH_PROFILE>`）
- `storeDir` — 库目录，空 = `<DSH_HOME>/mem`；换机器/换盘改这里
- `excludePaths` — ingest 时跳过的路径前缀
- `redact` — 入库前替换的正则数组（见下节）
- `autoIngest` — 默认 `false`：**不自动索引**，由你显式触发

0.2 新增的键（**逐字绑定面板**，改名会让面板写了不生效）：

| 键 | 默认 | 作用 |
|---|---|---|
| `rerank` | `'lexical'` | `'off'` 与 P0 逐字节一致 / `'lexical'` 词面重排 / `'embedding'` 向量重排（RRF(L3,向量) k=60；模型缺失时按 `embeddingFailFast` 报错或退回词面） |
| `rerankLexical` | `true` | 词面重排的独立开关；`false` 等价于 `rerank:'off'` |
| `episodeEnabled` | `true` | ingest 时幂等 pass 生成 episode 区间 |
| `episodeClosureMinutes` | `10` | 闭合阈值：源文件 mtime 距今 ≥ N 分钟才算闭合 |
| `episodeMaxChars` | `4000` | 单段字符上限；超了在 assistant 消息边界再切 |
| `embeddingEnabled` | `false` | 向量层开关（默认关：要 90MB 模型 + 可选依赖） |
| `embeddingModel` | `'bge-small-zh-v1.5'` | 模型 id（宿主按 `embed-models.MODELS` 白名单校验） |
| `embeddingModelDir` | `''` | 模型根目录；空 = `$DSH_HOME/mem/models` |
| `embeddingFailFast` | `true` | 模型不可用时显式失败（`false` = 静默退回词面重排，只 warn 一次） |

默认值**只有一份**：`index.mjs` 的 `DEFAULTS`（`cordis.patch.yml` 与它逐键相等，`test/routes.test.mjs` ⑥ 看着）。
`lib/settings-schema.js` 只留值域（`BOUNDS`）与消毒，不再持有默认值。

### 设置面板（0.2）

`dsh.client` 让 web 端加载 `lib/client.js`，面板落在「设置 → 记忆库（dsh-mem）」。
它读写的 5 条路由由宿主半注册在 GUI 同一个 web 服务上（`docs/PANEL-CONTRACT.md` 是契约）：

```
GET  /dsh-mem/panel/state               只读：库健康数 + 当前 9 键 config + 能力探测
PUT  /dsh-mem/panel/settings            {patch:{…}} → 消毒后原子写 $DSH_HOME/mem/panel-config.json
POST /dsh-mem/panel/models/download     启动模型下载，返回 jobId（同一时刻只允许一个）
GET  /dsh-mem/panel/models/download?jobId=…  轮询进度
POST /dsh-mem/panel/reindex             增量 ingest + episode pass
```

插件 `inject: ['tools', 'webServer']`：宿主没有 webServer 服务就不挂面板（5 个工具照旧）。

## 命令（CLI）

```bash
dsh-mem ingest [--all] [--dry-run] [--no-episodes] [--json]  # 增量入库本工作区会话；--all 忽略水位全量重扫
dsh-mem ingest --file <path> [--source <name>]       # 吃 .md/.txt/.jsonl，按段落切块入库
dsh-mem search "Router Worker 分工" --k 8 [--rerank lexical] [--json]   # 每条: score  sessionId#seq  [user|asst]  原文≤120字
dsh-mem open "07f38d2c-...-#seq=293" --context 2     # 按指针取回原文，可带前后各 N 轮
dsh-mem open "07f38d2c-...#293-441"                  # 按 episode 区间取回该区间全部原文（不摘要）
dsh-mem episodes [--rebuild] [--json]                # 列情景区间：session / 区间 / 是否封 / 段数
dsh-mem stats [--json]                               # 会话数 / 轮次 / 库大小 / 水位
dsh-mem export --out dump.ndjson [--json]            # 导出：首行 header + 一行一个 turn
dsh-mem import dump.ndjson [--dry-run] [--json]      # 导入：校验 schema、幂等
dsh-mem selftest                                     # 自检（临时库，不碰真库）
```

全局旗标：`--workspace <path>`、`--home <dir>`（缺省 `$DSH_HOME` 再缺省 `~/.dsh`）、
`--store-dir <dir>`（缺省 `<home>/mem`）、`--exclude <glob>` / `--redact <regex>`（均可重复）。

退出码：`0` 正常 / `1` 用法 / `2` 指针不存在（附最近 3 个候选）/ `3` 读不到输入（sessions 目录、库、空库）/ `4` 解压或数据损坏。
**空结果不算成功**：空库、目录不存在一律非 0 退出并说明原因。

## 插件工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `mem_search` | `query`（必填）、`k` | `{query,k,hits,mode,results:[{pointer,session,seq,role,ts,score,promoted,snippet}]}` |
| `mem_open` | `pointer`（必填）、`context` | `{anchor,session,rows:[{id,seq,role,ts,text}],anchorId}`；指针是区间时按区间回原文 |
| `mem_ingest` | `file?`、`source?`、`dryRun?` | ingest 统计（无 `file` = 重扫本工作区会话） |
| `mem_episodes` | `session?`、`limit?` | `{count,sealed,open,turnsCovered,episodes:[{session,startSeq,endSeq,seal,genVersion,turns,chars,pointer}]}` |
| `mem_stats` | 无 | 库路径/大小、会话数、轮次、fact 计数、水位 |

`mode` 的取值：`AND` / `OR` / `LIKE` / `AND+LIKE` / `split`（P0 切分回落后命中）。
`episode` 是**派生索引**：它只给区间，证据永远是 `open` 出来的原文（I3 红线）。

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
- **无语义/同义词**：P0 只是把整句切成 bigram 再 OR（召回），P2 只是对候选集按 2+3gram TF-IDF 重排；
  **同义改写（"怎么修" vs "如何修复"）仍然不命中**——那是 P3 的活，现在没接线。
- **P0 的切分是"兜底"不是"主路径"**：整句/整词能命中就绝不切（这也是等价性测试能守住的原因）；
  代价是多词自然语言查询若 OR 先命中了几条，就不会再切分召回。
- **P2 的 IDF 取自全库**，进程内按 `turn` 总数缓存；语料变了自动重建（首查 ~70 ms，热查 ~18 ms @266 轮）。
  重排模式下 `promoted` 退成次级键——否则 68 条 fact anchor 会把候选全压在 cosine 之上，重排等于没做。
- **`episode` 只对 DSH 会话生效**：`file:` / `ndjson import` 进来的会话没有事件流，无法判定 `turn/end`，
  一律不切（`build` 计数里记 `noSource`）。`episode` 不存摘要，读完区间要摘要请自己算。
- **`fact` 表不导出**：它只是"命中即加权的排序提示"，导出字段只有 `turn` 那 7 个；导入后 `promoted` 全为 false，
  原库里被 fact 提权的顺序可能不同。`prune`（降权淘汰）仍未实现。
- **`ingest --file` 的段落切分**：`.md/.txt` 按空行切、`.jsonl` 一行一条；`session = file:<source>@<内容hash8>`，
  文件改了就是一组新指针（守 I1，不覆盖旧原文）。
- **dry-run 的"将入库"** 是"文件里还没有的 `(session,seq)`"；会话 ingest 的 dry-run 不读水位，按实际库比对。
  dry-run **只读打开**（`readOnly`），不跑 DDL、不推 `user_version`——否则 episode 表一进 DDL，dry-run 就是一次 schema 迁移。
- **Node 版本**：`node:sqlite` 在 Node 22 需要 `--experimental-sqlite`，24+ 直接可用。CI 跑 24/26。
- **Windows 路径**：库名 `<hash8>-<目录名>.db` 的 hash 基于规范化后的工作区路径，换平台/换盘符就是另一个库。

## 验证（本机实测，2026-11-02 / 0.2）

| 项 | 结果 |
|---|---|
| `node --test` | 全绿（0 失败）；本层新增 12 条 = P0/P2 判据 6 条 + P1/dry-run 判据 6 条 |
| P0（12 条自然语言查询，真实库副本 266 轮） | R@3 **0.000 → 0.333**（要求 ≥0.30） |
| P2（同一批查询） | R@3 **0.333 → 0.667**（Δ=0.334，要求 ≥0.15）；`rerank:'off'` 与 P0 逐字节一致 |
| P1（真实库副本 ingest） | 50 段 / 44 封印 / 6 开放，覆盖 266/266 turn；复跑新增 0 |
| dry-run | 老库副本跑完 mtime/大小不变，`episode` 表没被建出来，`user_version` 仍是 0 |
| 真库只读 | `53fe3fff-dsh-sp1.db` 只读打开可读全部旧数据；迁移在 %TEMP% 副本上做，`turn` 266 行不变 |
| 等价性（真实库副本） | 5 条查询 + open + stats 与冻结老实现逐字节一致 |

## License

MIT
