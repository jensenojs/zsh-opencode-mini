# 配置可见性与单一事实源（设计稿）

状态：设计，未实施。本文只做论证与布局，不改代码。

## 原问题

用户装完插件，想知道两件事：它到底会做什么，能调什么。这个问题拆成四个可回答的子问题：

- 静态发现：全部键位、默认值、语义在哪看（一个权威入口）
- 动态状态：当前生效值是什么，来自 config 还是默认（一个查询命令）
- 变更确认：改了 config、写了 recipe，会被识别吗，何时生效（校验 + 时机说明）
- 无隐藏面：所有行为开关要么在 config.jsonc，要么声明为内部常量（清单 + 测试防线）

现状只有第一问有答案（README 表 + config.example.jsonc），且已实际漂移（见下）。二三四问没有任何入口。

## 现状核实

派工盘点的漂移先修正：recipes 是顶层节的对象（键名 -> recipe），[TARGET] 原话「companion 节 recipes 数组」与代码不符——`zom-companion.js:194` 读 `fullCfg?.recipes`，`config.example.jsonc:52` 顶层 `"recipes"`，`compileRecipes` 用 `Object.entries` 遍历对象。下文按实际结构。

配置的全部藏身点（逐一读文件核实）：

| 事实 | 位置 |
|---|---|
| 配置文件路径，两消费者共用 | `zsh-opencode-mini.plugin.zsh:19`、`zom-companion.js:51-54` |
| zsh 侧逐键解析：每键 fork 两次 sed + 一次 jq | `plugin.zsh:25-32`（`__zom_cfg` 每调用一遍） |
| `shell.dataDir` 双侧都读：zsh 写、js 读同一目录 | `plugin.zsh:34-36`、`zom-companion.js:69-76` |
| `companion.failureTtlSeconds` 默认 600，两侧各写一遍 | `plugin.zsh:108-113`、`zom-companion.js:33`（DEFAULTS） |
| 其余默认值藏在代码分支：keybind `^X`、resume `main`、replay `on`/`50`、passthrough `on`、failurePrefill 中文模板、binary `opencode-zom` | `plugin.zsh:41,52,91,99,122,136,70` |
| js 独有默认值：recentDefaultN 20、recipeTtlSeconds 900 | `zom-companion.js:34-35` |
| recipe 词表（on/deliver/name 正则） | `zom-companion.js:40-42` |
| example 声称「values shown are the defaults」，无机制保证 | `config.example.jsonc:9` |
| agent md frontmatter 三键 description/mode/hidden，opencode 平台格式，config.jsonc 管不到 | `agent/zsh-companion.md:1-5` |
| 用户现网 config.jsonc：仅 shell.resume/replay/replayLimit 三键 | `~/.config/zsh-opencode-mini/config.jsonc`（实测） |
| opencode 侧零件以软链接入 | `~/.config/opencode/plugins/zom-companion.js`、`~/.config/opencode/agent/zsh-companion.md` 均指向仓库文件（实测） |

已发生的漂移：

- README.md 与 README.zh-CN.md 的配置表都缺 `shell.dataDir`（grep 全仓库，该键只出现在 `config.example.jsonc:13`）。
- `tests/companion.test.mjs:58` 硬编码 `const TTL = 600`，与 js DEFAULTS、zsh 侧、example 构成第五处独立副本。
- `agent/zsh-companion.md` 曾被塞过 model 键（owner 已知案例），现已不存在，但机制上无防线：opencode agent frontmatter 原生支持 model 字段，复发没有任何发现入口。

## 判定一：默认值双处维护是真问题，但真实规模比设想的小

跨端真正重复的默认值只有一个：`companion.failureTtlSeconds`（600 出现在 plugin.zsh、js、example、README、测试五处）。`shell.dataDir` 的默认推导规则两侧各有一份，这是结构性的——js 要读 zsh 写的 history/outbox，必须独立算出同一路径，消除不了，只能注释互指加测试锁定（`tests/run.zsh` S9 已覆盖 zsh 侧展开，js 侧 `shellDataDir` 未见对应断言）。

更大的问题不是「双处」而是「无一致性机制」：example 声称自己就是默认值全集、README 表号称列全键位、测试里又埋了一份字面量，三处同步全靠人肉，README 已经掉队。所以方向 a 的正确落地：

- 不造跨语言单源文件。zsh 侧要读仓库内的 defaults.jsonc，就得在 source 时推导仓库路径并多一轮 fork，加重每次开 shell 的开销；而且「默认值声明」与「示例文件」本来就是同一内容，example 已在扮演这个角色，缺的只是机器保证。
- plugin.zsh 内部把散在 case 分支的字面量收拢为一张命名表（`typeset -gA ZOM_DEFAULTS`），分支逻辑引用表常量。等价重排，行为不变，收益是表可被测试 dump、可被 zom-config 打印——一份数据两用。
- 新增测试场景 S18：dump plugin.zsh 默认值表 + jq 提取 example 值 + node 读取 js DEFAULTS，三方断言相等。把「必须一致」从口头约定变成 `./tests/run.zsh` 的机械检查。

## 判定二：「可视化」的最小正确形态是 zom-config 函数

被排除的形态，先说为什么：

- README 单独承担：静态文档，答不了动态状态与校验，且已漂移。保留为安装前概览。
- 首跑生成带注释的 config.jsonc：生成物与用户手改文件冲突，需要合并逻辑；生成模板是 example 的第二份拷贝；且 example 本身就是带注释的全集样例，复制它是 README 已写明的既有动作。排除。
- 独立 doctor 脚本：仓库既有惯例是 `zom` / `zom-last` / `zom-bg` 三个 shell 函数（`plugin.zsh:381,387,300`），`zom-config` 与命名惯例对齐，零新概念；独立脚本反而多一个入口形态。

`zom-config` 是只读报告函数，四段输出：

1. **shell 节逐键**：当前值 + 来源（config/default）+ 默认值 + 一句话说明。数据源是 plugin.zsh 已解析的变量与默认值表，说明文案内嵌函数。
2. **companion 节逐键**：jq 从 config.jsonc 读当前值，默认值取自同一张表（与 js DEFAULTS 由 S18 锁一致）。
3. **recipes 逐个**：jq 提取名字/on/model/deliver/exitFilter/ratePerHour，并做 shell 侧廉价校验——on 是否在 {failure,bg-done,manual}、deliver 是否在 {next-session,outbox}、名字匹配 `^[a-zA-Z0-9_-]+$`、model 含 `/`。词表是第四处副本（js 之后的），标注「与 zom-companion.js:40-42 由 S18 锁同步」。收益：recipe 写错在 shell 侧立即暴露，不用等 opencode 加载。末尾打印生效时机：「zsh 侧在新 shell source 时读取；opencode 侧在 server 启动时读取（zom-companion.js:191，setup 内 loadConfig），改动后需重启 opencode server」。
4. **opencode 侧零件**：两个软链是否存在且指向本仓库（readlink 检查）、agent md frontmatter 当前键集合。这直接回答「还有哪些不在 config.jsonc 里的行为开关」。

recipe 生效确认的完整链路（问题 d 的答案）：格式错——zom-config 第三段立即暴露；model 不存在或调用失败——`fireRecipe` 已有兜底，失败写 outbox 的 `recipe-error` 行（`zom-companion.js:260-264`），用户在下个提示符前看到 `zom: recipe <name> failed: ...`；rate 满静默跳过（`zom-companion.js:246-247`）不发通知——每次限流都发会很吵，接受这个静默，写进 README Known limits。未验证项：opencode 对插件 setup 抛错的表现（会话内报错还是静默禁用）未经实测，zom-config 的 shell 侧校验降低了对该路径的依赖。

不做 `zom config set` 写命令。硬理由：jsonc 注释会被任何「读-改-写」抹掉（`__zom_cfg` 用 sed 剥注释，写回必然丢用户注释），加上原子写与手改冲突问题。由此固化为设计原则：**插件对用户配置面只读；写操作的唯一出口是 dataDir 下的数据文件**。这条与既有裁决（永不写 `~/.config/opencode/opencode.jsonc`）同构，一并写进 README。

## 判定三：隐藏面收编靠测试防线，不是靠搬迁

agent md frontmatter 不能读 config.jsonc（opencode agent 文件格式不支持注入），`mode: primary` / `hidden: true` 属于「写死在平台格式里」的合法形态。方向 c 的正确落地是两件事：

- **可见**：zom-config 第四段打印 frontmatter 当前键与值，README 配置表后加一小节列出「opencode 侧固定行为」及其位置。
- **不可复发**：新测试 S20 断言 `agent/zsh-companion.md` 的 frontmatter 键集合属于允许集 {description, mode, hidden}。owner 遇到的 model 私货案例，防线在此。

## 文件布局

- 改 `zsh-opencode-mini.plugin.zsh`：顶部默认值命名表（约 15 行）；`zom-config` 函数（约 50 行，只读，无 ZLE 依赖）；各 case 分支改引表常量。
- 不改 `opencode-plugin/zom-companion.js`：DEFAULTS 已是表形态；仅 DEFAULTS 处加一行注释互指 plugin.zsh 表与 S18。
- 不改 `config.example.jsonc` 内容；头注释加一行「值与两侧代码默认值由 tests S18 锁同步」。
- 改 `README.md` / `README.zh-CN.md`：配置表补 `shell.dataDir` 行；Usage 表加 `zom-config` 行；Known limits 加「改动 config 的生效时机（zsh 新 shell / opencode 重启 server）」与「recipe rate 满静默跳过」；Configuration 节指明当前值查询入口。
- 改 `tests/run.zsh`：S18 三源默认值一致性；S19 zom-config 输出冒烟（含全部键名）；S20 agent md frontmatter 允许集。补 js 侧 `shellDataDir` 的 sandbox 断言（companion.test.mjs 现未覆盖）。
- 不新增任何文件（无 defaults.jsonc、无 doctor 脚本、无生成器）。

## 迁移步骤与成本

用户现网 config 三个键（resume/replay/replayLimit）全部仍是合法键，无键名变更、无键废弃，**用户侧零动作**。全部变更在仓库内，而安装方式就是 source 仓库文件加两个软链（README.md:21-25），`git pull` 即完成部署。

顺序：

1. plugin.zsh 默认值表重构（纯等价变换）+ zom-config 函数。
2. tests S18/S19/S20 与 js 侧 dataDir 断言。
3. README 双语补表。

量级：plugin.zsh 约 +70 行，tests 约 +70 行，README 数行。无新依赖（jq 已是既有依赖，README.md:41）。风险点：zom-config 依赖 config.jsonc 可解析——文件坏时它应退化为「打印默认值表 + 一行 unparsable 警告」，与 `__zom_cfg` 的响亮失败纪律一致（plugin.zsh:21-29）。

## 视场内的其余结构性问题

- `__zom_cfg` 每键 fork 三进程，source 时十余键约 30 次 fork（plugin.zsh:27-31）。zom-config 不复用此模式（一次读入再提取）。顺手把逐键解析改为一次解析填表属于可选优化，不与可见性绑定。
- 边缘不一致：`failureTtlSeconds: 0` 在 zsh 侧被判非法回 600（plugin.zsh:110-112），js 侧照单全收导致永不 fresh（`zom-companion.js:192` 的展开无正数校验，`readFailureSignal` 在 ttl=0 时 age>ttl 恒真）。病态配置，影响小，可在 js 侧补同款正数校验对齐，记为顺带项。
- 「off」禁用 token 各键不统一：keybind/resume/replay/passthrough/failurePrefill 支持 off，binary 与 dataDir 无 off 概念。不改机制（会破坏现网配置），zom-config 说明文案逐键写清即可。
- 仓库现有 `ZOM_AGENT` / `ZOM_MAIN_SESSION` 已声明为内部常量不可配（plugin.zsh:79-81），这个「内部/可配」边界声明是对的，zom-config 输出沿用同一分类：可配键、内部常量两段分开。
