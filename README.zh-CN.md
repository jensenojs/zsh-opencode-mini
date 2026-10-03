# zsh-opencode-mini

让 `opencode` 感知你的 shell 的自包含小层：每条命令记录进本地仓库，opencode
拿到一个懒加载的结构化查询入口。终端仍然是你的。

> **多语言**：[`README.md`](README.md)（英文）是唯一事实源，本文件跟随它、可能滞后。
> 有出入时以英文版为准。

属于 [wez-ai](../IMPLEMENTATION_ROUTES.md) 路线图中的「小做法」路线（shell
hook + opencode mini）。这里设计的数据层（history 仓库、OSC 帧格式、失败
信号）在终端侧就是终态：wezterm fork 可以原样接上。

## 原则

**zsh 环境零侵入**。只经 `add-zsh-hook` 注册（direnv / python-autoenv 同款
惯例），不覆盖任何 widget，不改 prompt。卸载 = 删掉 source 行。

## 架构：两个 hook 面，一个配置文件

```text
  配置: ~/.config/zsh-opencode-mini/config.jsonc
        "shell" 节 → plugin.zsh (jq)    |   "companion"+"recipes" 节 → zom-companion.js

┌─ zsh 侧（plugin.zsh）──────────────┐     ┌─ opencode 侧（zom-companion.js）────┐
│                                    │     │                                     │
│  preexec ─┐                        │     │  setup(): 契约检查——plugin API      │
│           ├─► history-YYYY-MM.jsonl│◄────┤  不匹配时 loud fail                 │
│  precmd ──┤       （读取）          │     │  (major ≠ 2 / ctx 探针缺失)         │
│           ├─► last-failure.json    │◄────┤                                     │
│           │  （非零退出，原子写）    │     │  自定义工具 zom_context:             │
│           │                        │     │   last_failure / recent —— 懒加载   │
│           └─► OSC 7777;zom;v1;<b64>─┼─► wezterm fork 洞1（未来）               │
│                                    │     │                                     │
│  precmd ◄─── outbox.jsonl ─────────┼─────┤  recipes 按 failure / bg-done /     │
│  （字节游标；下个提示符前一行        │◄────┤  manual 触发；outbox 是 plugin→     │
│   `zom: <text>` 提示）              │     │  shell 的回传通道                    │
│                                    │     │                                     │
│  C-x ─► opencode mini ───────────────────► context hook: 仅新鲜失败 →          │
│          --agent zsh-companion ──────────► 注入一行；否则静默                   │
└────────────────────────────────────┘     └─────────────────────────────────────┘
```

- **zsh hook** 生产数据（记录、信号、OSC 帧）。单向写入。
- **opencode hook** 消费数据（契约锚定的自定义工具 + context 注入）。策略在
  这里、以机械方式执行：新鲜度规则不触发、agent 不主动看，就零上下文注入。
- **outbox.jsonl 是唯一的 plugin→shell 回传通道。** opencode 侧是唯一写者
  （append-only）；shell 每次提示符前用它独享的字节游标读一次增量，打一行
  `zom: <text>`。recipe 结果与后台 session 完成通知共用这一根管子——不存在
  第二条通道。
- **agent 定义** 只承载行为规范，不承载策略——策略从提示词约定挪进了代码。
- **一个配置文件，两个消费者。** 插件跑在两个运行时里（zsh 进程和 opencode
  server），所以有两个读取方——但配置文件只有一个，各读各的节。没有
  env-var 配置面。

## 上下文策略

默认懒加载。AI 回答普通问题时只看现场（git、文件、cwd），零注入。history
与失败信号都是按需的，走两条路：

1. **启发式信号**——非零退出时 zsh hook 原子刷新 `last-failure.json`。
   `zom_context` 工具只在信号新鲜（TTL 内）时报告它。于是「刚才那个命令
   不对」只花 agent 一次工具调用，安静的比赛零成本。
2. **按需查询**——agent 自己决定扩多大窗口，走 `zom_context` 工具的查询
   模式。全量 history 永远不会被加载。
3. **Recipes**——config 里声明的声明式模型调用，由 opencode 插件在 shell
   事件上触发；结果经 outbox（见下）或下一场 session 的 context 送达，
   一律带 `[zom:<name>]` 出处标记。

### Recipes

recipe 是 config `recipes` 节下的一个具名条目。事件触发时，插件填充
prompt 模板、调用配置的模型、送达结果：

| 字段 | 含义 |
|---|---|
| `on` | 事件源：`failure`（失败的 shell 命令）、`bg-done`（后台 session 结束）、`manual`（agent 得到一个 `zom_recipe_<name>` 工具） |
| `model` | 执行 prompt 的 `provider/model-id` |
| `prompt` | 模板；`failure` 事件填 `{cmd}` `{exit}` `{cwd}`，`bg-done` 事件填 `{sid}` `{cwd}` |
| `deliver` | `outbox`（下个提示符前一行 `zom:` 提示）或 `next-session`（注入下一场 mini session，`ttlSeconds` 后过期） |
| `exitFilter` | 可选，只在这些 exit code 上触发（省略 = 全部） |
| `ratePerHour` | 可选，每小时模型调用上限（省略 = 不限） |
| `ttlSeconds` | `next-session` 注入的存活时间（默认 900） |

失败全部可见：字段非法是加载期 loud error，模型调用失败以 `recipe-error`
行落进 outbox，每小时上限是硬闸门。可用的完整示例（`failure-hint`）在
[`config.example.jsonc`](config.example.jsonc) 里。

### 配置体系

唯一事实源：**`~/.config/zsh-opencode-mini/config.jsonc`**（带注释的模板见
[`config.example.jsonc`](config.example.jsonc)）。复制过去按需改；没有这个
文件时全部走默认——零配置可用。

两节，各归各的运行时：

| 节 | 键 | 默认 | 含义 |
|---|---|---|---|
| `shell` | `dataDir` | `~/.local/share/zsh-opencode-mini` | 数据目录（尊重 XDG_DATA_HOME） |
| `shell` | `keybind` | `^X` | 唤起键；`"off"` 显式禁用绑定 |
| `shell` | `resume` | `"main"` | C-x 接哪个会话：`"main"`=专属会话 `ses_zom-main`（与你的其它 opencode 会话隔离）；`"off"`=每次全新会话 |
| `shell` | `replay` | `"on"` | 重开主会话时 mini 重画多少：`"on"`=最近 `replayLimit` 条；`"off"`=传 `--no-replay`，直接落在输入行（会话全历史仍在） |
| `shell` | `replayLimit` | `50` | replay 的最新 N 条上限（上游默认 200，铺屏就是它） |
| `shell` | `binary` | `"opencode"` | mini 启动用的 opencode 二进制。可钉绝对路径换指定构建——比如自建版，resume 已存在会话时保持 inline 不清屏（官方 v2.0.22 二进制 resume 时会从屏幕顶重画） |
| `shell` | *（fork 版专属）* | | 配自建二进制（`zom-inline-resume` 分支）：resume 跟随唤起目录（工具在你所在目录跑）；新鲜失败会经上游 `--prefill` 预填输入框——文本不自动发送，你确认后再回车 |
| `companion` | `failureTtlSeconds` | `600` | 失败信号新鲜窗口（秒） |
| `companion` | `recentDefaultN` | `20` | `zom_context` 查 recent 的默认条数 |
| `recipes` | *（具名对象）* | *（无）* | 声明式模型调用；见 [Recipes](#recipes) |

两侧同一个解析约定：**只支持整行注释**，字符串值里不放 `//`（zsh 侧
`sed` 去注释后 `jq`；js 侧正则去注释后 `JSON.parse`——刻意不做完整 jsonc
解析器）。**不是配置**的内部常量（agent 名、mini 旗标、OSC 号）以只读全局
活在插件源码里。

两个运行时共享同一个数据目录：`zom-companion.js` 用和 `plugin.zsh` 相同的
规则解析 `dataDir`（config 值，缺省走 XDG），opencode 从哪里启动都能读到
zsh 侧写入的仓库。

**API 契约暴露。** `zom-companion.js` 平台耦合——跑在 opencode 的 plugin
API 上。`setup()` 时断言运行中的 major 版本并探测它用到的每个 ctx 面；任
一不匹配就抛出显式错误，指向文档页和本文件最后一次对照验证的日期。上游
破坏性变更会 loud refuse，不会半死不活地静默加载（与 opencode.nvim 的
contract check 同一纪律）。

**捕获范围**（什么进 history）：命令文本、exit code、耗时 ms、cwd。命令
**输出**（stdout/stderr）不捕获——只有元数据。输出捕获是另一个独立
opt-in 维度（仓库体积、密钥脱敏），当前不做。

**策略维度**（信号怎么变成上下文）在 opencode 侧、以机械方式活在
`zom-companion.js` 里：今天两个内建信号（新鲜失败、最近窗口），外加
declarative `recipes` 承载新信号。启发式工具选择
——比如大输出命令用 [rtk](https://github.com/) 包装——是同类维度；环境里
已经有全局 opencode rtk 插件时它自动生效，本仓库不重复、不配置。只有独立
安装场景需要时才在这里提升为 `tools` 组。

策略刻意保持薄：两个内建信号，recipes 只在你声明时才存在。规则表（输入
关键词 → 上下文动作）是出现第三个真实信号之后的自然下一步——在那之前不
做。

## 组件

```text
zsh-opencode-mini/
├── README.md                    # 事实源（英文）
├── README.zh-CN.md              # 中文对照（跟随英文）
├── config.example.jsonc         # 带注释的配置模板（复制到 ~/.config/zsh-opencode-mini/）
├── zsh-opencode-mini.plugin.zsh # zsh 侧：记录 + 信号 + OSC + outbox 读取 + zom-bg + 唤起
├── agent/
│   └── zsh-companion.md         # opencode agent：只放行为规范
├── opencode-plugin/
│   └── zom-companion.js         # opencode 侧：契约检查 + zom_context + context hook + recipes + outbox
└── tests/
    ├── run.zsh                  # 集成 suite S1-S17（sandbox zsh + mock opencode）
    ├── companion.test.mjs       # zom-companion.js 单测（mock V2/V3 ctx）
    └── bin/opencode             # mock opencode 二进制
```

运行时数据（与代码分离）：

```text
~/.local/share/zsh-opencode-mini/
├── history-YYYY-MM.jsonl        # 按月命令历史，append-only
├── last-failure.json            # 最近一条非零退出命令（原子替换）
├── outbox.jsonl                 # plugin→shell 消息（opencode 侧追加）
├── outbox.cursor                # shell 侧的 outbox.jsonl 字节游标（只有 zsh 写）
└── bg.jsonl                     # zom-bg 启动的后台 session 台账
```

## 安装

三步，两个生态。第 1–2 步是 **opencode 侧资产**（agent 定义与 companion
插件——AI 的能力都在这：查历史的工具、失败感知、recipe）。第 3 步才是
**zsh 侧**（记录、键位、outbox 消费）。下面的 zsh 插件管理器只覆盖第
3 步；第 1–2 步就是两个软链，因为 opencode 的插件机制就是「`plugins/`
目录放文件」——只新增，不改任何已有内容。跳过第 1–2 步：zsh 插件照常
工作，但 AI 是瞎的——没有历史工具、没有失败信号、没有 recipe。

```zsh
git clone <this-repo> ~/Projects/zsh-opencode-mini

# 1. agent → opencode 配置
mkdir -p ~/.config/opencode/agent
ln -sf ~/Projects/zsh-opencode-mini/agent/zsh-companion.md \
       ~/.config/opencode/agent/zsh-companion.md

# 2. companion 插件 → opencode 插件目录
ln -sf ~/Projects/zsh-opencode-mini/opencode-plugin/zom-companion.js \
       ~/.config/opencode/plugins/zom-companion.js

# 3. zshrc.d 入口
echo 'source ~/Projects/zsh-opencode-mini/zsh-opencode-mini.plugin.zsh' \
  > ~/.config/zsh/zshrc.d/35-zsh-opencode-mini.zsh
```

### zsh 插件管理器

仓库遵循 `<name>.plugin.zsh` 命名约定，管理器无需包装，直接指向仓库根：

**sheldon**（`~/.config/sheldon/plugins.toml`）：

```toml
# 仓库未发布前，用本地路径
[plugins.zsh-opencode-mini]
local = "~/Projects/wez-ai/zsh-opencode-mini"
use = ["{name}.plugin.zsh"]

# 发布到 GitHub 后可改用
# [plugins.zsh-opencode-mini]
# github = "<you>/zsh-opencode-mini"
# use = ["{name}.plugin.zsh"]
```

**oh-my-zsh**：把仓库 clone（或软链）为
`$ZSH_CUSTOM/plugins/zsh-opencode-mini`，然后 `plugins=(... zsh-opencode-mini)`。

**zsh-defer**：能用但没意义——插件顶层只有 config 读取 + 两个 hook 注册 +
一个 bindkey，全是亚毫秒级；defer 只会拉长「键位尚未绑定、首条命令尚未
被记录」的空窗。

上面两个 opencode 侧软链与 zsh 管理器无关——它们是 opencode 资产，
不属于 zsh 代码。

### 卸载

安装产生的三处，按任意顺序删除：

```zsh
# 1. zsh 侧：你管理器里的条目，或 zshrc.d 行
rm ~/.config/zsh/zshrc.d/35-zsh-opencode-mini.zsh

# 2. opencode 侧：插件与 agent 软链
rm ~/.config/opencode/plugins/zom-companion.js
rm ~/.config/opencode/agent/zsh-companion.md

# 3. 可选：清掉记录的数据（history、失败信号、outbox、bg 台账）
rm -rf ~/.local/share/zsh-opencode-mini ~/.config/zsh-opencode-mini
```

没有其他残留：不覆盖任何 widget（键位冲突检测会保留你的），插件只在
自己的数据目录内写文件。

依赖：`opencode`、`jq`、`base64`。

**版本支持**：只承诺 opencode **最新 v2**。`zom-companion.js` 加载时锚定
契约（major 版本 + ctx 面探针），不匹配就 loud refuse——它对照验证过的
plugin API 形状写在文件头注释里（最近一次：2026-10-02，官方
`Plugin.define` / `ctx.*` 形状）。

**键位冲突**：插件在 source 时尽力绑定，之后每个 prompt 复验直到绑定
落稳——这样 zshrc 在插件加载后才切换 keymap（`bindkey -e`/`-v`）也不会
静默丢键。目标键已被你占用时，保留你的绑定、stderr 打一次警告（`zom`
函数仍可用）——想换键改 config 里的 `shell.keybind`，或 `"off"` 跳过。
zsh 自带的、未被使用的 `^X-prefix` 默认前缀视为可安全接管。

## 用法

- `C-x` — 唤起 `opencode mini`（暂停 ZLE 里的全屏 TUI）。默认 `resume:"main"`
  接的是专属助手会话 `ses_zom-main`（与你的其它 opencode 会话隔离）；
  `resume:"off"` 每次全新会话。重开时只回放最近 `replayLimit` 条消息
  （默认 50，上游默认 200）；`replay:"off"` 则传 `--no-replay` 完全不回放，
  直接落在输入行——会话全历史仍在
- `zom` — 脚本化入口，额外参数转发给 mini
- `zom-last` — 把最近失败命令直接丢给 `opencode run`，不开 TUI
- `zom-bg <prompt>` — 在后台跑一个长时的 `opencode run`；打印 session id
  和接入命令。session 进入 idle 时，companion 插件往 outbox 落一条
  `zom: background session <sid> finished` 通知，你在下个提示符前就能看到
- 提示符前的 `zom: <text>` 行 — outbox 送达的 recipe 结果和 `zom-bg` 通知
  （每条带出处标记；agent 把它们当插件建议，不当你的原话）
- 任何装了本插件的 opencode 会话里，直接问 agent：「刚才那个为什么失败」、
  「我今天跑了什么」

## OSC 帧格式（预留给 wezterm fork 洞1）

```
ESC ] <code> ; zom ; v1 ; <base64(json)> BEL
```

- base64 payload：命令文本里的任意字节不会污染帧（warp 用 hex，同理）；
  编码代价是每条命令一个 `base64` 进程
- `v1` 是协议版本位；未来 `v2` 并行上线，旧解析器不受影响
- 当前无接收方（帧写出后被忽略）；fork 的 termwiz OSC 扩展解析的就是这个格式

## 与 zsh-kimi-cli 的账

| | zsh-kimi-cli | zsh-opencode-mini |
|---|---|---|
| 交互形态 | C-x 全屏切换给 kimi CLI | 同形态（C-x → mini）+ `zom-last` |
| 现场感知 | 无 | cwd/git 经工具，零注入 |
| history 感知 | 无 | 懒加载：`zom_context` + 新鲜度启发 |
| AI 运行时 | kimi CLI 锁死 | opencode（session 持久化、模型任选、自定义 agent/工具、MCP） |
| 记忆 | 无 | 跨 session 的 history 仓库 |
| fork 衔接 | 无 | 第一天起 OSC 帧就是洞1 线格式 |

诚实的部分：交互形态没有提升（都是「按键唤出全屏 TUI」）。提升全在 AI
侧——现场、记忆、可扩展。这正是小做法的定位：数据层做到终态，画面层留给
fork。

## 已知边界

- `zom-last` 依赖 `jq`
- opencode/TUI 内部执行的命令不经过 zsh hook，天然不进仓库（无自指污染）
- 失败信号启发是每主机每用户的；并发 shell 会互相覆盖 `last-failure.json`
  （最后写入者胜）——单人开发没问题，fan-out 场景再改
- 后台 session 不回收：`zom-bg` 只往 `bg.jsonl` 追加，session 清理交给平台
  （未验证）——台账目前只增不减
- `zom-bg` 完成通知以 `session.execution.succeeded` 为准（已真机验证，
  opencode 2.0.21，2026-10-01）；成对的 `session.execution.failed` 的 data
  形状未验证——出错的后台 session 只在能读到 `sessionID` 时以 `ok:false`
  通知，读不到就保持沉默
- `outbox.jsonl` 里解析失败的行会被跳过（游标照常推进）并打一行警告——
  一条坏行不会卡住 drain，但它的内容丢了
