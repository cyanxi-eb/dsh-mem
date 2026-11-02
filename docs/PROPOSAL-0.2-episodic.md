# dsh-mem 0.2 提案：分层回忆（事件层 / 词面重排 / 向量层留门）

> 状态：**已定稿（2026-11-02）**。基于三路真实数据核实 + YG 拍板，进入实现。

## 0. 已定的五条（YG 2026-11-02）

| # | 决定 | 落地位置 |
|---|---|---|
| 1 | P0 修查询切分**不动返回体**（保持逐字节兼容） | `search` 内部构造 |
| 2 | 词面重排 **默认开**（`rerank: 'lexical'`） | 配置默认值 |
| 3 | **接受可选依赖**；新增**插件面板**，所有开关集成其上；embedding **默认关闭**、模型由用户自行下载（本机即刻下载并启用） | `dsh.client` + `lib/client.js` |
| 4 | `fact` **不接入**排序（保持只写不读的死表状态，明确标为预留） | 不改 `search` 排序键 |
| 5 | 闭合阈值 10 分钟**可以，但必须可调** | `episodeClosureMinutes` |

**统一配置键**（面板与核心共用，不许各起名字）：
```
rerank: 'lexical' | 'off' | 'embedding'
rerankLexical: true
episodeEnabled: true
episodeClosureMinutes: 10
episodeMaxChars: 4000
embeddingEnabled: false
embeddingModel: 'bge-small-zh-v1.5'
embeddingModelDir: ''
embeddingFailFast: true
```

---
> 基线：`e43cc26`，库 266 turn / 19 会话 / 1.3 MB，会话目录 26 个。

## 0. 一句话结论

**情景向量层现在不做**——零依赖做不到真向量，真向量要 40–300MB 依赖 + 模型下载 + 冷启动，而在没有模型的前提下它的收益**根本无法被证明**。

但这次核实挖出两个更值钱的东西，优先级都高于向量：

1. **现有 FTS 对自然语言查询 12/12 全 0 命中**（把整句中文当一个短语匹配）。修它是一行级改动，实测 R@3 从 0 升到 0.333。
2. **事件层在当前规模就成立**：66 段、190 KB 文本、101 KB 向量，暴力余弦 0.019 ms。性能从来不是瓶颈，**闭合的时效性才是**。

## 1. 核实证据（全部真跑，非估计）

### 1.1 语料口径（推翻了原先假设）

| 项 | 实测 |
|---|---|
| 库里 266 行 | 226 asst + 40 user，**不是 266 轮** |
| 真实用户意图 | **只有 58 条**（`user/message` 且 `source.kind==='user'`；其余是技能目录/时间上下文等注入） |
| turn 总数 | 57 个 `turn/start`、53 个 `turn/end` |
| 文本体量 | 可见正文 19.1 万字；**工具输出 455 万字，占 96%** |
| 事件类型 | 40 种 / 12,224 条：`tool/result` 1748、`tool/call` 1740、`step/start` 1437、`assistant/message` 1433 |

> 推论：**嵌入前必须剔除或截断工具输出**，否则向量被 96% 的机器文本淹没。

### 1.2 检索方案对比（12 条真实查询，答案已知）

| 方法 | R@3 | MRR | 单查询 | 依赖 |
|---|---|---|---|---|
| **A 字符 2+3gram TF-IDF 余弦** | **0.583** | **0.598** | 1.5 ms | 零 |
| C 现有 FTS5 trigram（原句直查） | **0.000** | 0.025 | 0.4 ms | 零 |
| C′ FTS5 + 查询切 bigram 后 OR | 0.333 | 0.371 | 2.8 ms | 零 |
| B 随机投影 256/384 维 | 0.333 / 0.250 | 0.26 | 0.2 ms | 零 |
| 真向量（onnx/transformers） | 未测 | 未测 | — | **40–300 MB** |

- 随机投影被 A 和 C′ 双向支配，建索引还慢 37 倍 → **砍掉**。
- 本机 Node 26 **没有任何推理运行时**（`require('node:ml'|'node:onnx')` 全 `ERR_UNKNOWN_BUILTIN_MODULE`）。

### 1.3 时间衰减

作用在 A 分数上，τ = 7 / 30 / 90 天：R@3 恒为 0.583，名次变动 3 / 2 / 1 条。
**语料最大年龄 2.59 天**（中位 0.10 天）——这个数据集在原理上测不出月级衰减。结论：**当前零收益，属装饰**。

### 1.4 规模与性能

| N（段） | 暴力余弦（384 维 Float32Array） |
|---|---|
| 66 | 0.019 ms |
| 660 | 0.188 ms |
| 6,600 | 1.88 ms |
| 66,000 | 19.0 ms |

向量体积：66 段 = 101 KB；6,600 段 = 10.1 MB。**ANN 索引在此规模是纯负债**（`sqlite-vec` 是原生扩展，换机加载失败即破 I2）。

### 1.5 闭合判据（可执行）

```
闭合 := 每个 turn 都有 turn/end
      ∧ 文件 mtime 距今 ≥ 10 分钟
      ∧ 末两条事件不属于 {job/registered, step/start, tool/call, delivery-accepted}
      ∧ delivery-accepted.throughSeq ≥ lastSeq
```

- 本机：**22 闭合 / 4 活动**。
- **`session/end-seed` 不是结束标记**（它是 fork/继承标记）：实测有会话 `end-seed` 之后还追加了 1000+ 条，另有会话闭合 **3 天后**又被写入。
- 最强单信号：`max(seq of turn/start) < max(seq of turn/end)`；`step/start 1437 vs step/end 1434` 的 4 条缺口正好是 4 个活动会话。

### 1.6 切分方案

| 方案 | 规则 | 段数 | 中位字数 | 最长 |
|---|---|---|---|---|
| A | 每 step | 316 | 96 | 5691（过碎） |
| B | 每 turn | 58 | 3225 | 7899 |
| **E（推荐）** | turn + 单元边界 4k 上限 | **66** | **2476** | 7899 |

turn 已经近似"意图→执行→结论"；细切（gap 1min）只是把停顿当意图，段数翻倍收益不明显。

## 2. 分层模型

```
L0 原文层    turn          —— 唯一真相，逐字镜像，永不改（现有，不动）
L1 指针层    search/open   —— 只回 sessionId#seq + 原文切片（现有，不动）
L2 事件层    episode       —— 新增：只存「指针区间 + 指纹」，不存摘要文本
L3 词面重排  char-tfidf    —— 新增：可选开关，零依赖
L4 向量层    （留门不做）   —— 需模型 + 评测集 + 证明赢 L3
L5 事实层    fact          —— 现有，不动
```

**形状原则**：越往上越"可丢弃"。L0 不能丢，L1 是视图，L2 是派生，L3/L4 是缓存。

## 3. 分期与验收判据

### P0 修 FTS 查询切分（最高优先级，最小改动）

- 范围：只改 `search` 内部的查询构造（切 bigram/分词后 OR），**不动 DDL、不动返回体格式**（等价性测试逐字节比对，改格式立刻红）。
- 判据：固定 12 条查询集上 `R@3` 从 **0 → ≥0.30**；`open` 输出不变；`node --test` 全绿。
- 风险：低。这是修 bug，不是加功能。

### P1 事件层 `episode`

- `episode(id, session, start_seq, end_seq, seal, sealed_mtime, gen_version, src_hash)` + `UNIQUE(session,start_seq,end_seq,gen_version)`。
- **只存区间**，要摘要时现算——防止 D1（摘要与原文分叉）。
- 幂等：**扫 `turn` 做覆盖 pass**，不依赖事件触发（实测 `INSERT OR IGNORE` 被挡时不触发 trigger → 漏一次即永久漏）。
- 闭合：按 §1.5；已封区间**永不修改**，续写只在尾部追加 continuation 区间。
- 判据：`未覆盖 turn 数 = 0`；`episode ⟕ turn IS NULL 的行数 = 0`；同一 `(session,start,end)` 重复跑不新增。

### P2 词面余弦重排（可选，默认关）

- 实现：字符 2+3gram TF-IDF，向量只存内存（进程内），或落 `episode_vec` 缓存。
- 用途：**只做重排**（对 L1 的候选集重新排序），不单独作为检索入口——这样即使它坏了，L1 仍然完整。
- 判据：R@3 ≥ P0 基线 + 0.15；关闭开关后结果与 P0 完全一致。

### P3 向量层（**门槛制，现在不开**）

开启门槛（全部满足）：
1. 本机有可用的**本地**嵌入（决定：可选依赖 or Python 子进程 or 别的）
2. 评测集扩到 **≥30 条**真实语义查询（同义/改写，"答案在库里但词面不同"）
3. 在同一评测集上**赢过 P2 的 L3** ≥ 10 个百分点
4. 有 `dim/model_id/normalize/metric` 全套指纹 + `needs-rebuild` 标记
5. 模型不可用时**显式失败**，绝不写零向量

### P4 时间衰减（**门槛制**）

门槛：语料跨度 ≥ 90 天，且在同一评测集上不降低 R@3。
实现约束：**只用于排序、不用于过滤、默认关**；同一查询连续两次结果集必须相同（现在 `fact.hits/last_hit` 只写不读，一旦读它就会让查询变成非确定）。

## 4. 禁改清单（来自审计，一行都不能动）

- `turn` DDL + `UNIQUE(session,seq)`；`turn_fts(content='turn', content_rowid='id')` + `turn_ai/turn_ad`；`fact` + `fact_live`
- `insertRows` 的 `INSERT OR IGNORE` + `if(!res.changes) continue`；`parseSession` 的 R1/R2 过滤
- `search` 返回体/排序/`SNIPPET=120`；`openPointer` / `parsePointer`
- 水位键 `session:<id>` 与其 payload 形状（`stats` 靠 `k.slice(8)` 解析）
- `SCHEMA='dsh-mem/1'` + `EXPORT_FIELDS`

迁移只能用 `user_version`（实测 = 0 空闲）；`schema_version` 永不升级，不要指望它。

## 5. 已知坑（核实中挖出来的，写进实现前必读）

1. **`ingest --dry-run` 会写库**：对已存在的库走 `openDb` → 执行 DDL + 写 meta。一旦 episode 表进 DDL，dry-run 就变成一次 schema 迁移，README 的承诺当场失效。→ 必须先修 dry-run 的打开方式。
2. **`INSERT OR IGNORE` 被挡时不触发 AFTER INSERT**：基于 trigger 的增量会漏一次就永久漏。
3. **闭合是时点快照，不是终态**：有会话闭合 3 天后又被写入。任何"闭合即永久水位"的假设都会分裂区间。
4. **`partialTail` 时 turn 入库但水位不推进**：此时切情景会盖在"半截前缀"上，补全后同一区间重切 → 重叠 episode，且 `src_hash` 仍匹配、漂移检测不响。

## 6. 明确不做

- 不做摘要落库（要摘要现算）
- 不做 ANN / `sqlite-vec`（原生扩展 = 破 I2）
- 不做随机投影（被支配）
- 不做跨会话合并/矛盾仲裁（没有可信判据）
- 不把 episode 当真来源（**I3 红线**：证据永远是 `open` 的原文）
- 不为了"对齐主流"而加层——主流不构成判据

## 7. 待讨论（需要你拍板）

1. **P0 要不要改返回体**？我倾向不改（保持逐字节兼容），用同一批查询前后对比即可。
2. **L3 词面重排默认开还是关**？开了才用得上，但会让"同一查询结果随语料增长变化"。
3. **P3 的门槛 40–300MB 依赖你接不接受**？如果不接受，向量层就永久留门，L2+L3 已是终态。
4. **`fact` 要不要接进排序**？它现在是只写不读的死表——要么接入（并承担非确定性），要么明确标为"只是预留"。
5. **P1 的闭合阈值 10 分钟**是否合适？本机活动会话 mtime ≤1 分钟，闭合会话 ≥123 分钟，中间是空的；10 分钟是保守值。
