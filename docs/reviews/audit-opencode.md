# zom-companion 审查 + recipe 层 / zom-bg 设计报告

- 日期：2026-10-02
- 审查对象：zsh-opencode-mini 全仓（7 个源文件全读）
- 验证方式：官方 V2 plugin 文档当日重取核对（https://opencode.ai/v2/docs/build/plugins ，全文 1764 行，本报告引用其 API reference 与 hooks 章节）；zsh 侧证据来自源码直读；session 链路证据沿用派工方 2026-10-02 实测（v2.0.21 --help、run/mini 同 session 接入）
- 边界声明：本报告未跑真实 opencode runtime（禁止改代码/装机路径），凡 mock 测不到的点在 §7 单列

---

## 1. 结论摘要

1. `zom-companion.js` 对 V2 plugin API 的三处使用（default export 形状、`ctx.tool.transform` + `editor.add`、`ctx.session.hook("context")` + `event.system.push`）与官方文档逐字段吻合，无 API 误用。
2. 契约三探针与当前实际调用面**恰好相等**，权重正确。recipe 层若落地，需按 §6 扩探针，原则不变：探针 == 实际触碰的面。
3. 发现 1 处文档-代码失实（F1，README 声称工具结果里返回 tail/jq recipes，实现没有）、1 处工具描述与实现语义不一致（F2，last_failure 查询不走 TTL，文案说"encodes the freshness rules"）、其余为设计注记。
4. recipe 层的关键架构结论：**动作放 opencode 侧**（`ctx.generate.text` 无会话生成 + fs.watch 数据目录），zsh 侧只贡献它已经贡献的 failure 信号文件。owner 草图（zsh 后台 `opencode run -m small`）会把策略启发式（挑哪些失败、用什么模型、prompt 模板）推回 shell，违背本仓已确立的「策略在插件侧」分层。
5. 跨侧回传收敛为单一 **outbox 通道**：plugin 追加写 `outbox.jsonl`，zsh precmd 以游标推进、发 OSC 帧。recipe 结果交付、zom-bg 完成通知、未来 fork 的 AI-DONE 共用一根管子——完成通知不需要新机制。
6. zom-bg 白拿的结构：session 是 server 侧一等对象，`-s` create-if-not-exist + mini `-s` 重连 + `--fork` 分叉 + `--replay-limit` 控回放深度，四个既有旗标拼出后台任务全链路，缺的只有「完成可观测」，由 outbox 补。

---

## 2. 发现清单

判定分级：**失实**（文档/文案与行为不符，需改）、**注记**（行为正确但值得记录的设计后果）、**残余风险**（mock 证据不可达，需真机一步验证）。

### F1【失实】README 声称工具结果内含 tail/jq recipes，实现没有

- 证据：`README.md:63-64`「the agent widens the window itself (tail/jq recipes are returned inside the tool result)」；对照 `opencode-plugin/zom-companion.js:149-153`——`query=recent` 只返回原始 JSONL 行拼接，`query=last_failure` 只返回 `JSON.stringify(sig)`，没有任何 recipe 文本。
- 建议：二选一。改 README（把括号句删掉）成本最低；或在 recent 结果尾部附一行「widen: jq -r .cmd history-YYYY-MM.jsonl | tail -n 50」式的提示。倾向改 README——工具描述已经引导模型"the zom_context tool is the door"，再塞 shell recipe 是两个入口。

### F2【失实】工具描述与 TTL 语义不一致：last_failure 查询不经过 TTL 过滤

- 证据：TTL 只在注入路径生效——`zom-companion.js:104-105`（`readFailureSignal` 内 `age > ttlSeconds` 则返回 undefined，仅被 `:161` 的 context hook 使用）；execute 路径 `zom-companion.js:143-148` 直接读文件返回，无年龄判断。而 `agent/zsh-companion.md:19-20` 说该工具「encodes the freshness rules for you」——只对注入路径成立。
- 判定补充：**行为本身是对的**。TTL 是注入启发式，不该拦截显式查询（模型明确要 last_failure 时，旧的也有价值，payload 里有 `ts`/`epoch` 可自行判断）。错的是文案。
- 建议（文案 + shape 各一条）：
  - 工具 description 补一句「last_failure returns the most recent failure regardless of age — check `ts` before assuming it is what the user means」（`zom-companion.js:128-132`）。
  - execute 的 last_failure 返回值补算 `ageSeconds`（注入路径 `readFailureSignal:106` 已有同样计算，照搬一行），并可附 `fresh: <bool>`（对照 failureTtlSeconds）。这让模型一次调用就能回答「这是不是用户说的刚才那次」，不用自己拿 epoch 减 now。

### F3【注记】context hook 在 agent loop 的每次模型调用上都重新注入

- 证据：官方文档 hooks 章节原文「`context` runs for the agent loop, including tool-driven continuations」。即 fresh 窗口内，一次 mini 会话里每个 tool 续步的请求都携带那一行 system 文本。
- 判定：正确且可接受。system 块是每次请求的组装产物，不进持久 transcript，成本 ≈ 40 token/请求；且失败信息在 debug 会话全程相关。若未来想去重，正规位置是 per-(sessionID, failure-epoch) 的已注入标记，存 `ctx.storage`——现在不值得做，记录即可。

### F4【注记】config 解析失败的爆炸半径两侧不对称——这是对的，别"修"它

- 证据：zsh 侧静默跳过（`zsh-opencode-mini.plugin.zsh:20-23`，`jq ... 2>/dev/null` + 空返回）；opencode 侧 setup 抛错（`zom-companion.js:44-49`，带修复指引的 Error）。
- 判定：非对称是结构正确的。zshrc 来源的代码崩溃会锁死用户 shell，必须哑；opencode 插件加载失败只损失功能，可以响。写进注记防止未来有人把两侧"统一"。

### F5【注记】`loadConfig()` 在 setup 里解析两次

- 证据：`zom-companion.js:119-120`——`{ ...DEFAULTS, ...loadConfig()?.companion }` 与 `shellDataDir(loadConfig())` 各调一次，同一文件两次读盘+正则。顺手改成单变量即可，无行为影响。

### F6【残余风险】mock ctx 无法证明的三个点，需一次真机加载验证收口

- 证据：`tests/companion.test.mjs:44-68` 的 mock 把 `tool.transform` 的 editor 回调实现为同步调用；真实 runtime 的三个未验证点：
  1. **plain object 导出是否被 loader 接受**。文档示例全部用 `Plugin.define({...})`（`@opencode/plugin` 导入）；plain object 是 opencode 长期接受的约定（Plugin.define 本质是 typing wrapper），但 V2 文档页未明写。禁止新增依赖（不能 import `@opencode/plugin`），所以收口方式是真机跑一次：plugin 软链进 `~/.config/opencode/plugins/`，起一个 mini 会话，确认 `zom_context` 出现在工具列表。
  2. **transform 回调的同步执行时机**。文档说「Transforms are synchronous edits」「Register ... with a synchronous transform, including in Promise plugins」，强烈暗示回调同步执行；若实际异步，工具注册时点后移。同一次真机验证顺带覆盖。
  3. **context hook handler 是否支持 async**。文档 compaction 示例有 `async (event) => {}`，context 示例是同步。这直接决定 §3.2 里 lazy 方案可行性。
- 建议：一次真机冒烟（装→起→列工具→问一句带 fresh failure 的话）把三点全收口，结果回填本文件与插件头注释的 verified 日期。

### F7【注记】setup 返回值被忽略——当前正确，recipe 层落地时必须改为返回 cleanup

- 证据：文档 Lifecycle 章节「`setup` runs when the plugin loads. It may return a cleanup function that runs when the plugin unloads」；Events 章节示例在 cleanup 里 `controller.abort()`。当前插件无订阅、无 watcher，不返回 cleanup 是对的；fs.watch 或 `ctx.event.subscribe` 一旦引入，遗漏 cleanup 就是资源泄漏。

### F8【注记】月度 history 文件全量读入后切片

- 证据：`zom-companion.js:152`——`readFileSync(...).trim().split("\n").slice(-n)`。重度 shell 一个月可到几 MB，每次 `query=recent` 全量读。当前量级无害；天花板与升级路径（倒序读/索引文件）值得一条 knockout 注释，现在不动。

---

## 3. 设计：recipe 层（opencode 侧接入形状）

### 3.1 架构选择：动作放哪侧

owner 锚点例子：「exit != 0 时启发式地用 small model 做一个自动的提示词建议」，草图动作在 zsh 侧（后台 `opencode run -m <small> "..."`），产出要被 opencode 侧感知。

两个候选：

- **A（zsh 驱动）**：precmd 检出失败 → zsh 后台 `opencode run -m small` → 结果写回数据目录 → 下次 mini 注入。
- **B（opencode 驱动，推荐）**：plugin fs.watch 数据目录 → failure 信号变化 → `ctx.generate.text({model, prompt})`（官方语义：「Generate text with a selected model **without creating a session, invoking tools, or adding to session history**」——正是"无会话小调用"的原生原语）→ 结果存 `ctx.storage` → 注入或 outbox。

选 B 的结构性理由，不是偏好：

1. **分层一致性**。本仓已确立「策略旋钮住 opencode 侧」（`zsh-opencode-mini.plugin.zsh:7-9`、`README.md:44-48`）。方案 A 里「哪些失败值得建议、用哪个模型、prompt 模板长什么样」全是策略，放回 zsh 等于把已完成的分离再拆开。
2. **会话卫生**。A 的每次后台 run 产生一个真实 session（除非 `--standalone`，而 standalone 又使 mini 无法重连），session 列表被失败噪音污染；`ctx.generate.text` 结构上不产生会话。
3. **安全性由结构保证**。`ctx.generate.text` 不能调用工具，建议文本最多是文本；A 的后台 run 是完整 agent 循环。
4. **A 只在一个场景下必要**：opencode service 根本没在跑时。该场景下用户本来就没在用 AI，建议缺席无感。

zsh 侧对 recipe 的全部贡献 = 它已经写出的 `last-failure.json`。零新增 shell 逻辑（OSC 交付路径除外，见 3.4）。

### 3.2 触发时机：eager watcher（稳）与 lazy hook（疑）的取舍

- **eager**：setup 里 `fs.watch(dataDir)`（注意 last-failure.json 是 `mv` 原子替换，必须 watch 目录 + 按 filename 过滤，watch 文件本身会跟丢 inode），变化时 `ctx.generate.text`，结果写 storage；context hook 同步读 storage 注入。优点：建议在用户召唤前就绪（「自动的建议」的本义）；context hook 保持同步。代价：watcher + cleanup（F7）+ 失败过滤的门。
- **lazy**：无 watcher。context hook 内：fresh failure && storage 无该 epoch 的缓存 → 当场 `ctx.generate.text` await → 注入。优点：零常驻开销、没人召唤就不花钱、无需 cleanup。缺点：小模型往返（秒级）串进第一次召唤的响应路径；且 **依赖 context hook handler 支持 async（F6 第 3 点，未验证）**，handler 只能同步则此路不通。

建议：**默认 eager**（不依赖未验证行为，交付时序也符合产品语义）；若 F6 真机验证确认 context hook 可 async 且首prompt 延迟实测可感，再降级到 lazy。两案共用同一套 storage 与 config，切换只动触发点。

### 3.3 config recipes 节与注册机制

config 增一个与 `shell`/`companion` 平级的节（仍是一个文件两个消费者的既有约定）：

```jsonc
"recipes": {
  "auto-suggest": {
    "on": "failure",              // 触发器：failure | bg-done | manual
    "exitFilter": [1, 2, 126, 127],  // 省略 = 全部 exit code
    "ratePerHour": 6,             // 防打爆：ctx.storage 计数
    "model": "<provider>/<small-model-id>",
    "prompt": "Command {{cmd}} failed (exit {{exit}}) in {{cwd}}. Reply with one line: the likely fix.",
    "deliver": "next-session",    // next-session | outbox | synthetic | off
    "ttlSeconds": 900
  }
}
```

注册机制按关注点归位，**不做 per-recipe 的 hook/tool 注册**：

- **注入类交付**（next-session）：全部走既有的那一个 context hook，hook 内迭代「活跃 recipe 的 storage 输出」。建议文本注入时带出处标记（`[zom:auto-suggest]`），让主 agent 把它当提示而非指令——这是对抗 prompt injection 面的最低成本手段（建议文本由 cmd 文本派生，cmd 本身可能任意）。
- **模型调用**：一律触发时 `ctx.generate.text`，永不发生在 setup。
- **工具类 recipe**（on: manual）：在同一个 `ctx.tool.transform` 里 `editor.add`。若第二个工具真的出现，再考虑文档提供的 `editor.namespace({name:"zom"})`（effective id 变 `zom_<name>`）——现有 `zom_context` 是裸名字，改 namespace 是纯化妆且有测试与描述连带成本，**在第二只工具落地前不做**。
- **setup 校验**：未知 `on`/`deliver` 值 → loud throw，与 assertContract 同一纪律。
- 插件配置面继续用自家 config.jsonc 而非 opencode.jsonc 的 `plugins[] {package, options}` + `ctx.options`：后者无法被 zsh 侧 jq 读取，会破坏「一个文件两个消费者」。`ctx.options` 仅当 recipe 未来变成可分发包时再评估。

### 3.4 outbox：跨侧回传的唯一通道

OSC 帧只能由 zsh 发（plugin 跑在 service 进程里，stdout 不是 tty）。于是 plugin→终端方向需要一个落盘中转，设计为：

- plugin 追加写 `dataDir/outbox.jsonl`，每行 `{id, recipe, ts, kind, text}`；append-only，唯一写者是 plugin。
- zsh precmd（或独立的 hook 段）按字节游标读增量，逐行发 OSC 帧（复用既有 `7777;zom;v1;<b64>` 格式，`kind` 进 payload），游标存 zsh 自己的文件（`outbox.cursor`，唯一写者是 zsh）。无写冲突、无删除协议。
- **同一根管子吃三个需求**：recipe 结果交付、zom-bg 完成通知（§4.2）、未来 fork 的 AI-DONE。这是本设计里最重要的收拢：完成通知不是新机制，是新 producer。
- 在 fork 落地前，zsh 读到 outbox 增量可以退化为 pre-prompt 打一行 `zom: ses_x finished / suggestion ready`——不用 OSC 也有可用交付。

### 3.5 成本门

每个失败命令都打一次小模型是失控点。config 里两道闸就够：`exitFilter`（130/^C 这类高频噪音先滤掉）与 `ratePerHour`（storage 计数）。不再发明更多启发式——本仓自己的纪律是「第三个真信号出现才建规则表」（`README.md:113-115`）。

---

## 4. 设计：zom-bg 与 session 链路上限

### 4.1 zom-bg 形状（shell 函数，设计稿）

```zsh
zom-bg() {
  local sid="ses_zom-bg-${EPOCHSECONDS}-$$"
  print -r -- "{\"sid\":\"$sid\",\"pid\":\"$!\",\"cwd\":\"$PWD\",\"started\":$EPOCHSECONDS}" \
    >> "$ZOM_DATA_DIR/bg.jsonl"          # spawn 后追加（注意 $! 取值顺序，实现时先存 pid）
  opencode run -s "$sid" "$@" >/dev/null 2>&1 &
  print "zom-bg: $sid"
}
```

要点：

- `-s` create-if-not-exist（派工方实测）是全部魔法：后台任务落在 service 持有的具名 session 里，`opencode mini -s <sid>` 随时可接入。
- **禁用 `--standalone`**：standalone 脱离共享 service，session 不在服务端，mini 无法重连——后台语义即告失效。
- bg.jsonl 是 zsh 侧的 spawn 台账，同时是 plugin 的订阅输入（§4.2）。id 带 ts+pid 防并发同名互写。
- 待真机确认一点：`-s` 是否接受任意自造 `ses_*` id（派工证据只写了「ses_ 前缀 ID，create if not exist」，没覆盖 id 格式校验的边界）。

### 4.2 完成通知 = outbox 复用（无新机制）

plugin 侧：setup 时 `ctx.event.subscribe({signal})`（cleanup 里 abort，F7），按 bg.jsonl 里的 sid 集合过滤 session 状态事件，终态时向 outbox 追加 `{kind:"bg-done", sid, ok}`。zsh 侧：precmd 游标读到 `bg-done` → pre-prompt 提示一行（fork 后升级为 OSC AI-DONE 帧）。

插件侧还有 `ctx.session.wait({sessionID})` 与 `ctx.session.synthetic({sessionID, text})` 可用：前者是同步等终态（适合短任务的 wrapper 场景），后者能把一条文本推进指定 session（比如把「后台任务完成，结果如下」作为 synthetic 消息喂进用户当前停留的 session）。**注意文档边界**：synthetic 等消息不触发 prompt hook——若 recipe 未来想拦截/改写 synthetic 注入的内容，prompt hook 不是那个位置。

### 4.3 既有旗标白送的结构性机会

- **`--fork` 的两个真实用途**：(1) bg session 跑出了有价值的上下文 → fork 成交互 mini 继续聊，原 session 保持冻结；(2) 长 `-c` 主会话里要做风险实验 → fork 出分支试，失败即弃。fork 把「对话也能 branch」变成一等操作，这是 kimi-cli 形态产品结构上给不了的。
- **`--replay-limit`（默认 200）**：接进长 bg session 时控制 TUI 回放深度，重连体验的流量阀。
- **命名 session 约定 ≈ 免费的项目记忆**：`run -s ses_zom-<project>` 可让一次性 shell 命令维护长命会话（如持续喂日志分析的 ses_zom-log），mini `-s` 随时接入。跨 session 记忆的另一层已有——history JSONL 本来就是 host 级记忆，任何 session 都能 `zom_context` 查。
- 需要留意的坑：session 只增不减（平台是否有 GC 未验证），zom-bg 大量使用后 session 列表膨胀是运维问题，先记录不设计。

---

## 5. mini 交互形态的 UX 缺口（按价值排序）

1. **失败信号不含命令输出**——「为什么失败」这个最高频问题，agent 只拿到 cmd+exit，看不到 stderr，只能重跑或猜。这是 companion 质量的第一天花板。repo 已声明 output capture 是独立 opt-in 组（`README.md:100-103`），维持不建；但值得指出它的 recipe 形态：一个 `capture` recipe（opt-in、带 redaction），把 stderr 尾部写进信号文件，agent.md 加一句「present 时优先读」。设计上与 §3 完全同构——触发器换成「失败 && capture 开启」。
2. **plugin 缺席在 mini 里不可见**：contract refuse 后 mini 照常工作，只是 zom_context 不存在，agent 悄悄退化成纯场景回答。一个 `zom doctor`（只读检查：config 两侧可解析、数据目录可写、插件软链在位、last-failure 新鲜度）把这条静默失败变成可诊断项。
3. **bg 完成在 fork 前无推送面**：§4.2 的 pre-prompt 一行提示是 fork 前的过渡交付。
4. **并发 mini 语义未测**：两个 mini 同时 `-c` 同一 session 的行为（串行排队？互踩？）无证据。低频场景，记录待测。
5. **zom-last 的一次性 session 与主会话脱节**（`zsh-opencode-mini.plugin.zsh:150`，裸 `opencode run` 无 `-c/-s`）：可接受——主会话对失败的感知已由注入钩子覆盖（failure 文件是共享的），不必为此接 session。
6. 月文件全量读（F8）与 TTL 内逐请求注入（F3）是两个已量化的成本注记，均未到行动线。

---

## 6. 契约探针扩展建议（recipe 层落地时）

原则不变：探针 == setup 实际触碰的面，逐面报错文案指向 docs + verified 日期。recipe 编译进来后新增：

```js
["ctx.event.subscribe",   (ctx) => typeof ctx?.event?.subscribe === "function"],
["ctx.generate.text",     (ctx) => typeof ctx?.generate?.text === "function"],
["ctx.storage",           (ctx) => typeof ctx?.storage?.get === "function" && typeof ctx?.storage?.set === "function"],
```

major 锚点检查本身无需改：`Number(version.split(".")[0]) !== 2` 对空版本/非数字前缀都会 NaN !== 2 → loud refuse，行为正确。

---

## 7. 验证边界声明

- 官方文档核对：当日（2026-10-02）全文重取，本报告引用的 API 语义（generate.text 无会话语义、synthetic 不走 prompt hook、context hook 每续步触发、transform 同步编辑、cleanup 返回值）均出自文档原文，非记忆。
- 未跑真实 opencode runtime：F6 三点（plain object 导出、transform 回调时机、context hook async 支持）与 4.1 的 `-s` 自造 id 边界，需一次真机冒烟收口。
- session 链路结论（-s 接入、service 架构、旗标面）沿用派工方同日实测证据，本报告未重复执行。
