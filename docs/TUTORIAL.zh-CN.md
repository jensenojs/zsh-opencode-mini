# zsh-opencode-mini 教学文档

写给要吃透这个项目的人。读完应该能：向别人讲清它为什么长这样；顺着数据流读代码不迷路；自己动手加一个 recipe 或改一个机制。

约定：所有代码指针写成 `文件:行号`，以仓库当前状态为准。涉及真实 opencode 运行时但未复验的行为，会标注「未验证」。

---

## 这个插件解决什么问题

一个 AI 助手要帮忙解释或修复 shell 命令，它需要知道 shell 刚刚发生了什么。这件事听起来简单，做起来会撞上两堵结构性的墙。

第一堵墙是**前台进程组**。zsh 在跑一条命令时，命令的进程组独占 PTY：它持有键盘，它往屏幕上写。任何想在「命令输出」和「下一个提示符」之间插入内容的第三方，只有两个合法窗口——zsh 自己的 hook（preexec/precmd）和提示符本身。想在这个窗口之外画东西（浮动面板、折叠块），就得拥有渲染管线，也就是换掉终端（Warp 路线）或 fork 终端（wez-ai 谱系里的 fork 路线）。这个插件明确不走那条路，所以它的全部画面表达能力被限制为：precmd 里打一行 stderr、以及唤起 `opencode mini` 这个全屏 TUI。

第二堵墙是**上下文成本**。最直接的设计是「每次开 session 都把最近 N 条命令塞进 system prompt」。困境在于：绝大多数对话跟历史无关，注入的历史是纯开销，而且历史越长模型越容易被带偏。这个插件采取懒加载：默认零注入（`zom-companion.js:349` 的 context hook 在没有信号时什么也不 push，测试 `companion.test.mjs:455-467` 明确守护这一点），AI 需要历史时通过 `zom_context` 工具自己来查（`zom-companion.js:285-321`）。行为规则写在 agent 定义里（`agent/zsh-companion.md:11-20`）：场景优先，历史按需。

零注入带来一个新问题：AI 怎么知道「该去查」？答案是失败信号。zsh 侧在命令非零退出时刷新 `last-failure.json`（`zsh-opencode-mini.plugin.zsh:118-123`），opencode 侧的 context hook 检查这个文件，只在信号「新鲜」（TTL 内，默认 600 秒）时注入一行提示（`zom-companion.js:349-360`）。一行说的是：用户 30 秒前跑的 `xxx` 失败了，`zom_context` 工具可以查更多。这样失败场景有了免费的唤起信号，其余场景保持沉默。

把这三件事合起来，插件的形状就定了：**zsh 侧只生产数据（历史、信号、OSC 帧），opencode 侧懒消费（工具按需查、hook 按信号注入、recipe 按事件触发），中间靠文件系统传递，不碰 widget、不碰 prompt、不碰命令输出**（`zsh-opencode-mini.plugin.zsh:5-7` 的零侵入原则）。命令的 stdout/stderr 从头到尾不被捕获（`zsh-opencode-mini.plugin.zsh:92`），记录的只有元数据：命令文本、退出码、耗时、cwd。

这个形状还留了一个后手：precmd 每条命令发一帧 OSC `7777;zom;v1;<base64>`（`zsh-opencode-mini.plugin.zsh:136-138`），格式与 fork 路线的「洞 1」（OSC 扩展）对齐。将来 fork 落地时，fork 侧原样消费这批帧，zsh 侧零改动。

## 一次命令的生命周期

zsh 的 hook 协议：`preexec` 在命令执行前跑（能拿到命令文本），`precmd` 在下个提示符前跑（能拿到 `$?`，拿不到命令文本）。所以插件用两个变量在两个 hook 之间传状态（`zsh-opencode-mini.plugin.zsh:83-99`）：preexec 记 `__ZOM_T0` 和 `__ZOM_CMD`，precmd 用完即 unset。precmd 第一行就取 `$?`（`zsh-opencode-mini.plugin.zsh:94`）——任何后续语句都可能覆盖它，这是 hook 类插件最容易踩的坑。

```
用户敲命令                zsh 内部                      磁盘上的数据
──────────                ─────────                     ────────────
 Enter ──► preexec
            记 T0/cmd
 命令执行 ► (前台进程组独占 PTY，
            插件完全不介入)
 命令结束 ──► precmd
              取 $? ──────────────────────►  history-YYYY-MM.jsonl 追加一行
              exit≠0? ────────────────────►  last-failure.json 原子替换(tmp+mv)
              outbox drain ───────────────►  读 outbox.jsonl 增量，打 "zom: …" 行
              OSC 7777 帧 ──► stdout ─────►  (现在无人接收；留给 fork)
 下个提示符 ◄─┘
                 ▲                              │
                 │              opencode 侧插件 watch last-failure.json
                 │                              ▼
                 └──────────────────────  recipe 触发 → generate.text
                                              → 写 outbox.jsonl 或
                                                存进下一场 session 的注入队列
```

precmd 里的四步顺序有讲究：先落历史（唯一的外部进程是 base64，`strftime` 是 builtin），再刷新失败信号（原子替换：先写 `.tmp` 再 `mv`，`zsh-opencode-mini.plugin.zsh:121-122`），然后 drain outbox，最后发 OSC。drain 放在提示符前，是它唯一的合法出场时机。

JSON 转义是手写的（`zsh-opencode-mini.plugin.zsh:69-77`），零依赖，覆盖结构字符和常见控制字符。这是有意为之的权衡：引入 jq 做转义意味着每条命令多一个外部进程；手写版本的风险由 S2 用例守护（引号、反斜杠、tab、换行全部 round-trip，`tests/run.zsh:110-118`）。

## outbox 为什么是唯一的回传通道

recipe 的结果要回到用户眼前。它不能走 zsh 侧的 stdout——opencode 插件进程的 stdout 不是用户的 tty，写上去用户看不见。它也不能走注入 PTY 之类的路——那需要渲染权威。剩下的合法通道只有文件：opencode 侧把结果追加进 `outbox.jsonl`（`zom-companion.js:220-226`），zsh 侧在下次 precmd 时读出来，以 `zom: <text>` 一行的形式打在 stderr 上（`zsh-opencode-mini.plugin.zsh:191-194`）。

读的一方用**字节游标**（`outbox.cursor`，`zsh-opencode-mini.plugin.zsh:157-198`）：游标存第一个未读字节的偏移，drain 时从那里 `sysseek` 起读。困境是性能：这个函数每条命令跑一次，如果每次都 `tail` + `jq` 全量解析，就是每条命令两个外部进程。所以稳态（无新记录）用 `zstat` 比较大小即可零 fork，有增量时也只对增量跑一次 `jq`（`zsh-opencode-mini.plugin.zsh:145-147` 的注释把这笔账写得很清楚）。

游标协议有四个值得说透的语义（`zsh-opencode-mini.plugin.zsh:149-156`）：

- **半行不消费**。写者可能正写到一半，没有结尾换行符的尾巴留在原地等下次（`zsh-opencode-mini.plugin.zsh:179-185`，S16 用 `{"id":"c","te` 半行验证这一点）。
- **坏行跳过不锁死**。解析失败的行随游标一起被跳过，打一行警告。理由是：一条坏行如果卡住游标，之后所有通知全部死锁，损失远大于丢一行。
- **at-least-once 而非 exactly-once**。打印和写游标之间如果 crash，下次会重放这条记录。取舍是：重复通知无害，而为了保证 exactly-once 加锁的复杂度有害。这是「简单优先」在协议层的落点。
- **多 shell 并发时游标 last-writer-wins**。输掉竞争的 shell 可能重复打印一条。README 把这条限制写在明面上，修它不值得（同上：锁的成本大于重复打印的成本）。

游标文件的两个写者身份也要分清：`outbox.jsonl` 只有 opencode 侧写（append-only），`outbox.cursor` 只有 zsh 侧写。各有一个 owner，没有锁。

## recipe 管线：策略全部住在 opencode 侧

recipe 是这个插件里唯一「主动做事」的机制：shell 发生某类事件时，用某个模型跑一段 prompt，把结果送回 shell。它的所有策略逻辑——触发条件、退出码过滤、限频、模型选择、投递方式——都写在 opencode 侧的配置里（`config.example.jsonc:24-57`），zsh 侧一行策略代码都没有。

为什么这样切分？看两边的运行环境。zsh 侧的纪律是每条命令只付得起一两个外部进程（见上一节），策略逻辑（限频计数器、状态机）在 shell 里既写不起也测不起。opencode 侧是常驻 Node 进程，有 storage（持久计数器）、有 event 流、有 generate API，策略逻辑放这里是顺路的。所以切分原则是：**zsh 侧只产生信号，信号的解释和消费全部在 opencode 侧**。加一个 recipe 不需要碰任何 zsh 代码。

三个触发源汇聚到同一条管线 `fireRecipe`（`zom-companion.js:242-271`）：

```
watcher(fs.watch last-failure.json)──┐
event流(session.execution.succeeded)─┼──► fireRecipe ──► ratePerHour(storage 闸门)
zom_recipe_<name> 工具(agent 调用)───┘         │
                                              ▼
                                       generate.text(model, fill(prompt, slots))
                                              │
                              deliver=outbox ─┤── appendOutbox → 下个提示符前一行
                              deliver=next-session ─┤ outputs.set → 下场 session 注入
                                                    │   带 [zom:<name>] 前缀，TTL 过期
```

管线里的几个决定：

- **watcher 监听目录而不是文件**（`zom-companion.js:372-374`）。因为 zsh 侧是 tmp+mv 原子替换，监听文件本身会跟着旧 inode 走，第一次替换后就永远沉默。这是文件系统语义直接逼出来的写法。
- **同一 epoch 只触发一次**（`zom-companion.js:379-382`）。一次失败会在文件系统上表现为多个 fs 事件；epoch 是那次失败的唯一身份，去重靠它。
- **限频是硬闸门**（`zom-companion.js:243-249`）。计数 key 是 `zom/rate/<name>/<hour>`，存进平台 storage，进程重启也不丢。没有限频的 recipe 会在连续失败的循环里每小时烧几十次模型调用。
- **recipe 失败本身也走 outbox**（`zom-companion.js:262-264`）。一条建议没到且没有原因，用户会当成插件坏了；报错行和结果行走同一条通道，失败就是可见的。
- **`generate.text` 的返回形状做了容错**（`zom-companion.js:256-259`）：文档钉住了调用形状但没有钉返回形状，所以同时接受裸字符串和 `{text}` 信封。这是对未验证平台行为的显式标注，不是猜测。

## 契约与失败显性

这个插件依赖一个自己不控制的上游：OpenCode 的插件 API。上游发 breaking change 时，插件的正确行为是**拒绝加载并说清楚去哪里重新核实**，而不是带着一半能用的表面静默运行。这就是 `assertContract`（`zom-companion.js:134-153`）做的事：锚定大版本号（V2），逐个探测要调用的 API 面是否存在，任何一项不符就 throw，错误信息里带文档 URL 和上次核实日期。

探测是按需的（`zom-companion.js:201-214`）：`event.subscribe` 无条件探测（bg-done 通知常开），`generate.text` 和 `storage` 只在配置了 recipe 时才探测。这个门控让「不用 recipe 的用户」不被 recipe 的依赖绑架，测试 `companion.test.mjs:239-262` 守护这两条门控各自成立。

配置走同一纪律：`compileRecipes`（`zom-companion.js:89-117`）在 setup 时把每个 recipe 的每个字段验一遍——name 的字符集（它要变成工具名和 outbox key 的一部分）、on/deliver 的取值域、model 的 `provider/id` 形状、exitFilter 的整数数组——任何一项不对就 loud throw。坏值在加载时炸，比在三个月后的某次失败事件里静默不触发要好查得多。

事件形状则靠**真机实证**而不是文档：bg-done 通知依赖的事件信封是 2026-10-01 对 opencode 2.0.21 全量事件 dump 验证出来的——事件形状是 `{id, created, type, durable, location?, data}`，`session.status` 不存在，终态信号是 `session.execution.succeeded` 且 `data = {sessionID}`（`zom-companion.js:388-394`）。验证不了的路径显式标注：`session.execution.failed` 的 data 形状没有失败样本，所以插件在 `sessionID` 读不出来时保持沉默（`zom-companion.js:420-421`），宁可少通知也不编造行为。

两套测试的分工也从这个契约观里长出来：

- **平台契约**（opencode 运行时自己的行为——工具 schema 接不接受、hook 事件在真实运行时的形状、fs.watch 在 macOS 上丢事件）不在插件测试的守护范围，由 assertContract 的版本锚 + 真机实证负责。`fireViaWatcher` 辅助函数（`companion.test.mjs:89-95`）的存在就是这条边界的直接产物：macOS 的 fs.watch 低概率丢事件是平台行为，测试守护的是插件的管线（读信号 → epoch 去重 → exitFilter → fire），所以 fire 类断言换新 epoch 重试，而不是假设平台投递可靠。
- **插件契约**（记录格式、信号原子性、outbox 游标语义、recipe 管线、限频、TTL、去重）全部有测试。`tests/run.zsh` 的 S1–S17 守 zsh 侧，`companion.test.mjs` 守 opencode 侧。

## 动手：从零写一个 recipe

在 `~/.config/zsh-opencode-mini/config.jsonc` 的 `recipes` 段加一个条目。逐个字段讲：

```jsonc
"recipes": {
  "flake-hint": {                          // 名字必须匹配 ^[a-zA-Z0-9_-]+$，
                                           // 因为它会变成工具名 zom_recipe_flake-hint
                                           // 和注入前缀 [zom:flake-hint] 的一部分
    "on": "failure",                       // 触发源：failure | bg-done | manual
    "model": "anthropic/claude-haiku-4.5", // 必须 "provider/model-id"，setup 时校验
    "prompt": "命令 {cmd} 在 {cwd} 以退出码 {exit} 失败。这是第 N 次了，判断是否值得修。一句话。",
                                           // {cmd}/{exit}/{cwd} 从事件填充（fill，
                                           // zom-companion.js:235）；bg-done 触发时
                                           // 槽位是 {sid}/{cwd}
    "exitFilter": [1, 2],                  // 可选。只在这些退出码上触发；省略 = 全部
    "ratePerHour": 3,                      // 可选。每小时最多 fire 几次模型调用
    "deliver": "outbox",                   // outbox = 下个提示符前一行 "zom: …"
                                           // next-session = 注入下场 mini session，
                                           //   带 [zom:flake-hint] 前缀，ttlSeconds 过期
    "ttlSeconds": 900                      // 只对 next-session 有意义
  }
}
```

保存后重启 opencode 进程（setup 只在加载时跑一次）。验证路径：故意跑一条 `exitFilter` 命中的失败命令，看下个提示符前有没有 `zom:` 行；deliver 用 next-session 时，开 `opencode mini` 问一句「你上下文里有没有 zom 开头的行」。

三条现成的触发语义可以组合：

- `on: "failure"`——watcher 路径，实时，受 exitFilter/ratePerHour 约束；
- `on: "bg-done"`——某个 `zom-bg` 会话结束时，槽位是 `{sid}` `{cwd}`，与完成通知共享一次 per-sid 去重（`zom-companion.js:432-435`）；
- `on: "manual"`——注册成 `zom_recipe_<name>` 工具，agent 自己决定何时调用（`zom-companion.js:324-343`），槽位由 agent 填。

两个容易漏的点：ratePerHour 的闸门在 generate 之前（省了钱但建议也没了，这是有意的——闸门的语义是「这个 recipe 每小时最多值 N 次调用」）；prompt 模板里没写的槽位不会自动进上下文，模型只看到 fill 出来的字符串。

### 改 zsh 侧的红线

改 `zsh-opencode-mini.plugin.zsh` 之前，三条从已有结构里长出来的约束：

1. **err_return 安全**。这个文件会被 source 进任何 zshrc，包括开着 `err_return` 的。插件路径上所有早退必须显式 `return 0`（keybind 冲突警告分支是范本：警告后仍 return 0，一条警告不能杀用户的 shell）。测试 S12 守护这条。同理，测试套件自己的计数器用 `PASS=$(( PASS + 1 ))` 而非 `((PASS++))`——后缀形式首次求值为 0 会触发 err_return（`tests/run.zsh:61-62` 的注释）。
2. **fork 纪律**。precmd 每条命令跑一次，新增逻辑先问「这加几个外部进程」。现在全路径只有 base64 一个 fork；`zstat`/`sysseek`/`sysread`/`strftime` 都是 builtin。能靠参数展开解决的不要起进程（OSC 帧剥 base64 换行就是这么做的，`zsh-opencode-mini.plugin.zsh:137`）。
3. **不碰 widget、不碰 prompt**。唯一合法的 ZLE 操作是唤起 mini 时 `zle -I` 暂停行编辑器（`zsh-opencode-mini.plugin.zsh:235`）。keybind 绑定走冲突探测 + prompt 自愈（`zsh-opencode-mini.plugin.zsh:262-331`）：用户已占用的键警告一次并放弃，绝不抢；绑定落在过期 keymap（加载时 main 还指 viins，用户的 zshrc 事后 `bindkey -e` 切走）的情况由首个 prompt 复验并重绑，落稳或放弃后自摘钩子。

## 测试怎么读

`tests/run.zsh`（17 个场景，全部在一个 `zsh -f` 沙箱里跑，HOME/XDG 指到临时目录——插件自己的 config 发现逻辑因此也被真实地测试到）：

| 场景 | 守护什么 | 性质 |
|---|---|---|
| S1 | 每条命令一行 JSONL，字段正确 | 插件契约 |
| S2 | JSON 转义 round-trip（引号/反斜杠/tab/换行） | 插件契约 |
| S3 | 失败信号：非零退出原子刷新，零退出不动；无 .tmp 残留 | 插件契约 |
| S4 | 裸 `zsh -f` 下自加载 zsh/datetime（回归：曾因 EPOCHREALTIME 为空整条记录链瘫痪） | 插件契约 |
| S5 | OSC 帧格式 + base64 payload 与落盘 JSON 逐字节一致 | 插件契约（也是 fork 洞 1 的线格式锚） |
| S6/S7 | zom 与 zom-last 走到 mock opencode 的 argv 形状 | 插件契约 |
| S8/S9 | keybind 默认与 off 令牌；config dataDir（含 ~ 展开） | 插件契约 |
| S10 | companion 的 V2 加载 / fresh 注入 / stale 沉默 / V3 loud refuse（node 可用时跑 companion.test.mjs） | 插件契约 |
| S11 | keybind 冲突：警告、保留用户绑定、不注册 widget | 插件契约 |
| S12 | err_return + nounset 环境下函数内 source 存活 | 插件契约 |
| S13 | 坏 config：一行响亮警告 + 默认值生效 | 插件契约 |
| S14 | 双 shell 各 200 条并发记录，400 行全部完好（行级 append 原子性） | 插件契约 |
| S15 | zom-last 无记录：stderr 提示、退出 1、零外部调用 | 插件契约 |
| S16 | outbox 游标：完整行投递、游标停在最后完整行、半行等待、补全后恰一次投递、二次 drain 零输出 | 插件契约 |
| S17 | zom-bg：sid、台账、`run -s`（永不 --standalone）、空 prompt 拒绝 | 插件契约 |

套件头部（`tests/run.zsh:45-48`）声明了不自动化的部分：真实按键→ZLE→widget→`zle -I` 链需要活的交互 shell，那是 zsh 上游的 hook 语义保证，装好后按一次 C-x 手工验收。

`companion.test.mjs`（29 个断言，跑在一个 mock V2 ctx 上）的 mock 形状（`companion.test.mjs:98-146`）值得单独看：`tool.transform` 把注册的工具收进 `state.tools`；`session.hook` 收进 `state.contextHooks`；`storage` 是普通对象；`generate.text` 记录调用并返回 `{text}`；`event.subscribe` 返回一个可手动 `push` 事件的 AsyncIterable。测试全部通过操作这些 state 断言插件行为，从不 mock 插件内部——它把 zom-companion.js 当黑盒，从 V2 公开面驱动。

mock 里两处直接对应上一节的契约观：`fireViaWatcher`（丢事件重试，守护插件管线而非平台投递）和 bg-done 用例里同时喂真实运行时信封 `{type, data:{sessionID}}` 与 legacy `{properties}` 事件（插件对旧线格式的容错是被测试钉住的行为，`companion.test.mjs:400-410`）。

---

最后一条读码建议：这个仓库的注释不是文档的复述，大多是「为什么排除别的写法」的裁决记录（watcher 为什么听目录、游标为什么 at-least-once、outputs 为什么在内存）。读卡住的地方先读旁边的注释，再回这份文档对框架；文档和注释冲突时，以代码和测试为准。
