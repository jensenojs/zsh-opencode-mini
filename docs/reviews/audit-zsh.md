# zsh-opencode-mini shell 侧审查：机制/策略边界与 recipe 层设计

审查对象：`zsh-opencode-mini.plugin.zsh`（176 行）、`tests/run.zsh`（242 行）、`opencode-plugin/zom-companion.js`、`config.example.jsonc`、`agent/zsh-companion.md`、`README.md`。
方法：全部结论来自代码细读 + 本机 zsh 5.9 实测（文内标注〔实测〕），未改任何代码。
日期：2026-10-02

---

## 总评

机制/策略的边界画线基本正确，管道（记录/信号/OSC/唤起）是干净的机制层；唯一的策略渗漏在 `zom-last` 的 prompt 文案。recipe 层的最干净接入形状是**声明式 config + 一个通用调度器 + 文件输出通道**——不建 recipe 文件 DSL，不建注册表。shell 侧新增的全部同步开销是纯 zsh 模式匹配，模型调用走 `&!` 后台 + 原子落地，红线可守。

防御性发现共 4 条，无阻断性 bug：最重的是 broken config 静默回退（用户改配置无效果且零反馈）；「precmd 零 fork」的说法与事实不符（实测每命令 2 个外部进程）。

---

## 一、机制/策略边界审查

### 1.1 画对的地方

- **信号产生与时效消费分离**：shell 侧无条件写 `last-failure.json`（plugin.zsh:102-107），TTL 判定在 companion 侧（zom-companion.js:99-110，`failureTtlSeconds`）。写者不知道 freshness，读者不知道记录——两侧各自最小。
- **配置分节消费**（plugin.zsh:12-34 / zom-companion.js:39-59）：一个文件两个读者，各读各的节，dataDir 解析逻辑两侧镜像（README.md:88-91 声明了这是刻意的）。
- **agent md 只管行为**（zsh-companion.md 全文无一处策略参数）：策略从 prompt 约定移进代码（README.md:47-48）的迁移已经完成。
- **内部常量不开放配置**（plugin.zsh:36-39）：agent 名、`-c` flag、OSC code 是「召唤谁」的机制参数，不是策略。锁死正确。

### 1.2 渗漏点：zom-last 的 prompt 文案

`plugin.zsh:150`：
```zsh
opencode run "Explain and fix this failed command (run in the current directory): $last_failed"
```

这句文案是「怎么向模型提问」的策略，硬编码在 shell 侧，且是 shell 侧唯一一处。它无法收编进 agent md——`opencode run` 不经过任何 agent 定义。也无法进 config（会破坏「shell 节只有机制参数」的边界）。

**这不是「给 zom-last 加配置」的问题**。owner 的 recipe 锚点例子（exit != 0 → small model → 自动建议）就是 zom-last 的自动触发版：同一策略（failure → 模型建议），触发从手动变自动。recipe 层落地后，zom-last 应重新理解为 failure-hint recipe 的手动路径（同步、默认模型、用户主动按键所以等待合法），文案归入 recipe 的 `prompt` 参数。当前单独存在可以接受——一个例外不值得先建机制——但 recipe 设计时按收编对象对待它，不要为它单独长出配置键。

---

## 二、recipe 层接入形状（设计主体）

### 2.1 裁决：声明式 config，不建 recipe 文件

两个候选形状：

| | 声明式（config recipes 数组） | recipe 文件（zsh hook 约定） |
|---|---|---|
| 表达力 | 受词汇表限制，新类型要改 plugin | 任意 zsh |
| shell 侧复杂度 | 调度器一次写死，加 recipe 零代码 | 每 recipe 都是代码 |
| 安全面 | 纯数据 | 任意代码执行 |
| 当前需要 | **覆盖全部已知需求** | 表达力收益为零 |

当前唯一真实 recipe 是 failure-hint。它的参数面（触发条件、exit 过滤、模型、prompt、输出渠道、开关）全部是声明可表达的。recipe 文件 DSL 的收益为零而安全/测试成本真实。等第二个词汇表达不了的 recipe 类型出现再升级——这是 README.md:113-115「rule table 在第三个真实信号出现前不建」纪律的直接延续，不违反「recipe 开关是 owner 要求不算投机」的豁免（开关与参数面照建，只是载体选最薄的）。

### 2.2 config 形状

```jsonc
"shell": {
  "dataDir": null,
  "keybind": "^X",
  "recipes": [
    {
      "name": "failure-hint",        // 标识 + 单 recipe 开关：数组里在 = 开
      "on": "failure",               // 触发词汇表：failure（v1 唯一值）
      "exitCodes": "any",            // 或 [127, 1]：白名单数组
      "cmdExclude": "^cd( |$)",      // 可选 ERE，命中则跳过
      "cooldownSeconds": 30,         // 同 cmd 去重窗口，防重试风暴
      "model": "qwen3-coder-flash",  // opencode 模型 id，传给 run -m
      "prompt": "这条命令失败了，给一行修复建议: {cmd}",  // {cmd} 占位
      "output": "file"               // v1 唯一实现；osc/echo 预留词汇
    }
  ]
}
```

词汇表刻意的窄：`on` 只有 `failure`，`output` 只有 `file`（另两个值保留不实现）。不建 exit code pattern DSL（`>=100` 之类）——数组白名单覆盖真实需求，模式匹配等真实需求出现再加。

### 2.3 zsh 侧执行形状

**source 时**（一次性，fork 数不敏感）：jq 把 recipes 解析进 zsh 关联数组（`ZOM_R_ON / ZOM_R_MODEL / ZOM_R_PROMPT / ...`，键为 recipe name）。jq 数组迭代是既有 `__zom_cfg` 模式的自然延伸。

**precmd 时**（红线所在，新增同步路径必须零 fork）：

```zsh
# precmd 末尾追加：
__zom_recipes "$exit_code" "$cmd"

__zom_recipes() {
  local exit_code=$1 cmd=$2 name
  for name in ${(k)ZOM_R_ON}; do
    [[ "$ZOM_R_ON[$name]" == failure ]] || continue
    (( exit_code != 0 )) || continue
    # exitCodes 白名单 / cmdExclude ERE / cooldown 检查——全部纯 zsh
    # ... 过滤通过则：
    __zom_recipe_fire "$name" "$cmd" &!
  done
}

__zom_recipe_fire() {
  # 后台子 shell：调模型、原子落地，不碰终端
  local hint
  hint=$(opencode run -m "$ZOM_R_MODEL[$1]" "${ZOM_R_PROMPT[$1]//\{cmd\}/$2}" 2>/dev/null) || return 0
  ...原子写 last-hint.json（tmp+mv，同 plugin.zsh:103-106 模式）...
}
```

红线的机械保证：precmd 同步路径只有关联数组查找和 `[[ =~ ]]`，微秒级；模型调用整体在 `&!` 后台。三个必须守住的细节：

1. **后台输出必须重定向**（上例 `2>/dev/null` + 命令替换捕获）：`&!` 的子进程 stdout 仍连着终端，模型输出会打断已渲染的 prompt。这是后台方案最常见的翻车点。
2. **cooldown 是机制不是策略**：同 cmd 在窗口内只 fire 一次，防的是重试风暴（用户连打 5 次 git push = 5 个并发模型调用）。默认值写死（30s 量级），config 可调但存在。这与 last-failure 的分工同构：shell 侧防失控（机制），companion 侧管时效（策略）。
3. **`&!`（disown）而非裸 `&`**：不进 job 表，不污染用户 `jobs`/exit 通知。边界声明：非交互 shell job control off 时 disowned 进程与 shell 同进程组，终端关闭的 SIGHUP 理论上可达——交互场景（唯一有 precmd 的场景）job control on，无此暴露。不叠 nohup，防过度。

### 2.4 输出通道裁决

| 通道 | 裁决 | 理由 |
|---|---|---|
| **file**（`last-hint.json`） | **v1 实现** | 消费机制已备：companion 的 context hook 多查一个信号文件即可（TTL 逻辑复用 `readFailureSignal`），C-x 后 agent 天然可见。零新机制。 |
| osc | 保留词汇，不实现 | 无接收者。且 hint 是内容不是元数据——与现有 OSC 帧（元数据语义）不符；将来要走 OSC 需 payload 加 `kind` 字段，帧格式不用动（v1 兼容）。 |
| echo | 保留词汇，不实现 | 后台完成时 prompt 已渲染，echo 落在下一条命令中间。正确做法需要 zle 调度（`zle -M`/scheduler，交互限定），成本与收益不配。 |

`last-hint.json` 与 `last-failure.json` 同 shape（`ts/epoch/cwd/cmd` + `hint`），复用原子写模式。**hint 不进 history JSONL**——hint 是命令记录的派生物不是原始事实，单一 owner。

### 2.5 与 zom-last 的收编关系

recipe 落地后：`zom-last` 保持手动同步路径（用户按键、等待合法），但 prompt 文案从 recipe 的 `prompt` 参数取（无 recipes 配置时回退现有硬编码）。这样策略文本只有一份 owner，zom-last 是它的另一个触发器。

---

## 三、健壮性发现

〔实测〕标注 = 本机 zsh 5.9 (arm-apple-darwin23) 复现验证过。

### 3.1 broken config 静默回退（最值得修）

`plugin.zsh:22`：`jq -r "$1 // empty" 2>/dev/null`。config.jsonc 语法坏了 → jq 失败被吞 → `__zom_cfg` 返回空 → 全部静默走默认。用户改了配置、多打一个逗号，行为静默回退且零反馈。

与 companion 侧行为不一致：js 侧对坏 config **loud 抛错**（zom-companion.js:44-49）。zsh 侧不能 loud（source 时抛错会在 err_return 环境炸用户 shell），但应该 stderr 警告一行。修法：解析分两步，先 `jq -e . >/dev/null` 校验整体合法性（失败则警告"config unparsable, using defaults"），通过后再取键。配 S12 测试。

### 3.2 「zero fork」的说法与事实不符

`plugin.zsh:115`：`b64=$(printf '%s' "$json" | base64 | tr -d '\n')`。
〔实测〕每条命令 2 个外部进程（mock base64/tr 计数确认）。

`plugin.zsh:42-43` 注释「the recording path stays fork-free」只对 strftime 部分成立；README.md:195「pure write, zero cost」同样不成立。实际成本 0.2ms 量级，可接受，但文档要改准。顺手优化：`tr` 可用参数替换消掉——`${$(printf '%s' "$json" | base64)//$'\n'/}`——macOS base64 本就不换行（tr 是 no-op），GNU base64 靠参数替换兜住，fork 2→1。

### 3.3 mkdir 失败静默

`plugin.zsh:48`：`mkdir -p "$ZOM_DATA_DIR" 2>/dev/null`，失败不查。dataDir 不可创建时（权限/路径错），之后每条命令的 `print >> history` 都会失败：普通环境下每条命令 stderr 一次噪音；err_return 环境下 `__zom_precmd` 在记录处中断（其余 hook 逻辑静默跳过）。source 时失败应警告一行。

### 3.4 multi-key prefix 的警告缺席〔实测〕

用户绑定了 `^X^A` 两键序列时，`bindkey '^X'` 查询返回 `undefined-key`（zsh 对 prefix 查询不报告）——冲突检测（plugin.zsh:164-166）看不到，plugin 直接绑定。**实测损害为零**：zsh keymap 中单键与序列共存，绑定 `^X` 后 `^X^A`/`^X^B` 原样保留，无键被偷。只是「never steal」的警告在这个场景缺席。可选补丁：`[[ -n "$(bindkey -pM main "$seq" 2>/dev/null)" ]]` 非空则警告。低优先级。

顺带：`plugin.zsh:166` 的 `"$current" == "$seq-prefix"` 分支实测构造不出来（bindkey 对 prefix 返回的是 undefined-key 而非 `^X-prefix` 字样），是死防御分支——无害，但注释 line 160 对它的解释（"zsh's own unbound prefix is safe to take over"）描述的是一个 bindkey 不会返回的状态。

### 3.5 并发写安全〔实测，无需修〕

8 个并发 zsh × 300 行 append：2400/2400 行完整合法（`print -r` 单次 write + O_APPEND 偏移原子性）。**不加锁**，README.md:219-221 的 last-writer-wins 声明成立。last-failure 的 tmp+mv 读侧永不见到半文件。这条是给未来改动者的红线：不要往这条路径上加锁或缓冲。

### 3.6 err_return 环境安全性〔实测，无需修〕

静态审查怀疑 `plugin.zsh:167` 的 `[[ ... ]] && return 0` 短路返回 1 会在 err_return 函数内引发连锁（`__zom_bind` 注释 line 161 自己声明了这条纪律）。实测（用户占用 ^X + `setopt err_return` + 函数内 source）：警告正常打印、用户绑定保留、wrap 函数不炸、shell 存活。zsh 的 ERR_RETURN 不对 `&&` list 的短路失败触发。S11 现有断言有效，建议补「函数内 source」变体（见 4.1）。

### 3.7 zsh 版本下限

`EPOCHREALTIME`/`EPOCHSECONDS` 需 zsh ≥ 5.0.8。`zmodload zsh/datetime` 自加载（plugin.zsh:43）解决了模块未加载，解决不了老模块没有这两个变量——5.0.2（CentOS 7）下 `__ZOM_T0=$EPOCHREALTIME` 在 nounset 环境会炸 preexec。owner 机群（macOS 5.9 / fedora 5.7+）无暴露。建议 README 声明下限 5.0.8，source 时 `(( $+EPOCHREALTIME )) || 警告+降级`。低优先级。

---

## 四、测试盲区（S1-S11 之外）

| # | 盲区 | 现状证据 | 补测形状 |
|---|---|---|---|
| T1 | **函数内 source + err_return**（§3.6 已实测安全，需固化防回归） | S11 只测 `zsh -f -c` 顶层 | S12：`zsh -f -c 'setopt err_return; f(){ source ... }; f; print alive'` 断言 alive |
| T2 | **broken config 警告**（§3.1 修复后） | 现状静默，无断言 | S13：写坏 JSON 进 sandbox config，断言 stderr 有警告且默认值生效 |
| T3 | **并发 append 行完整性**（§3.5 已实测，可固化） | 无并发测试 | S14：两进程各写 200 行，断言 400 行全部 `jq -e` 合法 |
| T4 | zom-last 无失败记录路径 | S7 只测命中 | 一行：无 last-failure.json 时 stderr 消息 + return 1 |
| T5 | **recipe 层**（落地后） | — | mock opencode 已记录 argv（tests/bin/opencode），断言：失败命令后后台调用最终发生（wait 循环轮询 mock log）、exit=0 不调用、非白名单 exit 不调用、precmd 返回 < 100ms、cooldown 窗口内第二次失败不重复调用 |

S8 的环境局限说明在案（tests/run.zsh:35-38 已声明 ZLE 链不自动化）；S8 断言的「默认 ^X 绑定成功」在 `zsh -f` 的空 keymap 里成立，真实交互由用户日常使用覆盖，不需要 pty 基建。

---

## 五、结构性机会

1. **last-hint.json**（§2.4）：机制三件套——原子写、TTL 消费、信号文件约定——全部现成，recipe 只是第一个生产者。last-failure 模式的同构复制。
2. **companion 的 context hook 升级为多信号**：目前单查 failure（zom-companion.js:161-171）。hint 落地后天然变成「信号列表 + 各自 TTL」——这是 README.md:113 说的 rule table 的第一个真实形态，到那时再抽象，现在不用。
3. **OSC 帧的 `kind` 字段预留**：帧格式 `zom;v1;<b64(json)>` 不用动；将来 hint/其他内容走 OSC 时 payload JSON 加 `"kind"` 区分元数据与内容。fork 洞 1 的注记，现在只写进 README 不实现。
4. **preexec cwd 快照**：当前记录的 cwd 是命令完成后的 `$PWD`（precmd）。`cd /tmp && make` 记录 /tmp——对「AI 诊断刚才为什么失败」恰好正确（用户看到的目录）。真正歪掉的场景（想知道命令开始时在哪）罕见，不建议改。
5. **每命令 fork 2→1**（§3.2 的优化面）：`tr` 消掉，一行改动。

---

## 六、优先级

| 级别 | 项 |
|---|---|
| 建议做 | §3.1 broken config 警告（用户可感知的无声失败）；§2 recipe 设计定稿后按 §4-T5 长测试 |
| 顺手做 | §3.2 文档措辞修正 + tr 消除；§3.3 mkdir 警告；§4-T1/T3 测试固化 |
| 记录不动 | §3.4 multi-key 警告（损害实测为零）；§3.7 版本下限声明；§5.4 cwd 快照 |
| 红线 | §3.5 并发路径不加锁；precmd 同步路径保持零 fork；recipe 不建文件 DSL、不建注册表 |
