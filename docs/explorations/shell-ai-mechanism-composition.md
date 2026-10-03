# 终端 AI 工具的机制组合，与 zsh-opencode-mini 的对照

## 概述

这份文档回答一个问题：zsh-opencode-mini 把 zsh 的 hook、ZLE 与 opencode 的插件 API 拼在一起，这种**机制的拼法**在公开的终端 AI 工具里有没有先例，哪些拼法是别人没有的，哪些是别人已经验证过更优的，哪些是我们在重复造轮子。

判断落在机制上，不落在功能清单上。一个工具"支持自然语言"没有信息量；它**用什么办法**把键盘交给谁、把 shell 现场递给模型、把模型输出送回哪里，才有信息量。

结论先放这里：这个插件真正少见的是**数据通道的形状**（一个 shell 侧写入、agent 宿主侧惰性消费、再用一条独立通道把 agent 输出送回 shell），以及一个尚无先例的微机制（无人认领按键的透传）。它最弱的是**交互面**（C-x 呼出全屏 TUI），恰好也是它对外主打的形态；而 2026 年公开工具的主流方向已经走到"在输入行里做分类/路由"，不再要求模式切换或全屏。

## 方法与边界

证据分三类，全部标注来源：

- zsh-opencode-mini 本地代码（行号引用到文件）
- Warp 开源客户端源码与它自带的 `docs/explorations/`（本机 `warp/`，快照 git HEAD `a19bf16`，2026-04-29；Warp 客户端现已开源，仓库 `github.com/warpdotdev/warp`）
- 公开工具的文档与 README（URL 给出）

边界写在最后「未解决的问题」里，最重要的一条：本文没有真正运行任何一个外部工具，外部结论来自文档与源码阅读，不是实测行为。

## 关键文件与证据源

本地：

- `zsh-opencode-mini/zsh-opencode-mini.plugin.zsh` — zsh 侧：记录、失败信号、OSC 帧、outbox 消费、`zom-bg`、C-x widget
- `zsh-opencode-mini/opencode-plugin/zom-companion.js` — opencode 侧：契约检查、`zom_context` 工具、context hook、recipes、outbox 写入
- `zsh-opencode-mini/docs/DESIGN.md`、`README.md` — 设计意图与「vs zsh-kimi-cli」的自我评价
- `zsh-kimi-cli/kimi-cli.plugin.zsh` — 被当作借鉴来源的那个插件的真实代码
- `warp/RESEARCH_NOTES.md`、`PROJECTS_OVERVIEW.md`、`IMPLEMENTATION_ROUTES.md` — 本机已有的第一手调研
- `warp/docs/explorations/natural-language-detection.md`、`warp/docs/explorations/passive-ai-suggestions.md` — Warp 自己的设计文档（开源仓库自带）

外部：

- Warp：`https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes`
- Claude Code：`https://code.claude.com/docs/en/hooks`、`https://code.claude.com/docs/en/hooks-guide`、`https://www.claudelog.com/faq`
- Gemini CLI：`https://geminicli.com/docs/reference/keyboard-shortcuts`、`https://developers.googleblog.com/en/say-hello-to-a-new-level-of-interactivity-in-gemini-cli/`
- Lacy Shell：`https://lacy.sh/tools`、`https://lacy.sh/vs/warp`、`https://dev.to/lacymorrow/2026-ai-terminal-tools-comparison-warp-vs-lacy-shell-vs-traditional-shells-5a8f`
- Atuin AI：`https://docs.atuin.sh/18.17/ai/introduction`
- ShellGPT zsh widget：`https://www.machinefriendly.com/blog/ollama-gemma4-shellgpt-local-ai-terminal`
- Butterfish：`https://butterfi.sh`、`https://github.com/bakks/butterfish`
- Wake：`https://dev.to/joemckenney/wake-give-claude-code-visibility-into-your-terminal-history-55o4`
- opencode：`https://opencode.ai/docs/plugins`、`https://opencode.ai/docs/keybinds`、`https://opencode.ai/docs/ecosystem`
- TIOCSTI：`https://man7.org/linux/man-pages/man2/TIOCSTI.2const.html`、`https://docs.kernel.org/process/deprecated.html`

## 一个需要先纠正的前提

把 zsh-kimi-cli 描述成「C-x 全屏切换到 kimi CLI」是不准的。它的真实机制：

- `^X` 绑定 `__kimi_cli_toggle_prefix`，作用是在 `BUFFER` 上切换一个 `✨ ` 前缀（`zsh-kimi-cli/kimi-cli.plugin.zsh:89-108`）。
- 前缀生效后，`zle-line-init` 每次新行自动补回前缀（`:110-123`），`zle-line-pre-redraw` 把光标钉在前缀之后（`:125-145`），另有包装过的 `backward-delete-char` / `backward-kill-word` 等防止退格退进前缀（`:155-198`）。
- 真正把自然语言送进 Kimi 的是 `command_not_found_handler`：带 `✨ ` 前缀的命令行被它接住，转成 `kimi -c "$full_cmd"`（`:22-87`）。Kimi TUI 只是在这一刻短暂地全屏出现。

所以 zsh-kimi-cli 是「输入行前缀模式 + command-not-found 分发」，不是「按键切换到一个全屏窗口」。这一点有价值，因为它把设计空间摊开了：同一目标（在 shell 里问 AI）至少有三种落法——前缀模式（kimi）、全屏呼出（本插件）、输入行分类（下面 Warp / Lacy）。本机 `PROJECTS_OVERVIEW.md:198-202`、`:264` 对它的描述（"pure ZLE — no rendering"、"input-line authority only"）与代码一致。

## 机制对照

每条按「机制 / 谁在用 / 一手证据 / 对我们的含义」组织。

### shell hook 采集命令元数据

- 谁在用：Atuin（`preexec`/`precmd` 采集，见 shell integration 文档）、zsh-histdb、mcfly、hstr；Warp 的 shell 集成脚本发 `Preexec`/`CommandFinished{exit_code}`/`Precmd{pwd}`（`warp/RESEARCH_NOTES.md:67-74`，代码 `app/src/terminal/model/ansi/dcs_hooks.rs:30`）。
- 证据：Atuin `https://docs.atuin.sh/main/guide/shell-integration`；我们 `zsh-opencode-mini.plugin.zsh:164-220`。
- 对我们的含义：采集本身是成熟做法，不构成新颖点。区别在采集物的去向——Atuin 存 SQLite 供人搜，我们存 JSONL 供模型读。

### 失败信号 + 时效窗口，再决定要不要进上下文

- 谁在用：Claude Code 的 hook 体系（`UserPromptSubmit` / `SessionStart` hook 的 stdout 直接进上下文，可由 shell 脚本读现场状态，`https://code.claude.com/docs/en/hooks`）；我们的 `last-failure.json` + TTL（`plugin.zsh:197-204`，`zom-companion.js:349-360`）。
- 对我们的含义：把「何时注入」做成 TTL 门控是合理设计，但机制类别（宿主提供注入点、脚本决定内容）已是标准配置。我们的版本把它搬进了 opencode 的原生插件 API，而不是让用户写 shell hook。

### 把 shell 现场喂给 AI

- 谁在用：Warp 的 `BlocklistAIContextModel` 从块列表装配 `{command, output 截断, exit_code, pwd, git}`（`warp/RESEARCH_NOTES.md:86-97`）；Claude Code hook 脚本惯例性地 `git branch` / `git log` / `git status` 注入（`https://hidekazu-konishi.com/entry/claude_code_hooks_complete_guide.html`）；Wake 用 shell hook 拿结构 + PTY 包装层拿输出，落 SQLite，再经 MCP 暴露给 Claude Code（`https://dev.to/joemckenney/wake-give-claude-code-visibility-into-your-terminal-history-55o4`）。
- 对我们的含义：这条路我们已经有一个更强功能的同类：Wake。差别是 Wake 采集**输出**（stdout/stderr），我们只采元数据（`README.md:140-143` 明说 output 不采）。「刚才那条命令为什么失败」这个问题，有输出和有 exit code 是两种答案质量。

### AI 输出回到 shell 输入行

- 谁在用：ShellGPT 的 zsh widget `_sgpt_zsh`（Ctrl+L，把 `BUFFER` 换成 AI 生成的命令，失败则还原原输入，并用 `print -s` 记进历史，`https://www.machinefriendly.com/blog/ollama-gemma4-shellgpt-local-ai-terminal`）；Atuin AI（`enter` 直接跑、`tab` 插入到提示行，`https://docs.atuin.sh/18.17/ai/introduction`）；zsh-ai（`#` 前缀，`github.com/matheusml/zsh-ai`）；thefuck 式的纠错回填；Bash 侧 ShellSage 的 `Ctrl+J` 插入代码块。
- 对我们的含义：这是**成熟且更轻**的机制，直接操作 `BUFFER` / `LBUFFER`，不需要任何全屏程序。我们的对应物是 `--prefill`（填进 mini 的 composer，`plugin.zsh:310-336`），更重、更模态；「修上一条命令」这个最高频场景，输入行回填会更快。注意区分：我们的 outbox 输出的 `zom: <text>` 走的是 stderr 提示行（`plugin.zsh:272-275`），不是输入流。

### shell 与 TUI 的键位交接：挂起（SIGTSTP）

- 谁在用：Claude Code（Ctrl+Z → `fg` 回来，`https://www.claudelog.com/faq`）；opencode 上游默认就有 `"terminal_suspend": "ctrl+z"`（`https://opencode.ai/docs/keybinds`）；Gemini CLI 有 `app.suspend`（同为 Ctrl+Z）。
- 对我们的含义：这是操作系统层面的通用机制，不是新东西。上游 opencode 已经支持，且已知有「Ctrl+Z 后 `fg` 回来重绘不全」的 bug（`github.com/anomalyco/opencode/issues/16327`）。fork 里「ctrl+z 单键挂起回 shell」应当理解成对齐上游 + 修重绘，不要当成原创机制宣传。

### 全屏 TUI 呼出（ZLE `zle -I` + 外部程序）

- 谁在用：fzf 的各种 widget、yazi / nnn 的 shell 包装函数、zsh-kimi-cli 的 `kimi -c`、Lacy 的交互式 `claude`。
- 证据：`zle -I` + 跑外部程序 + `LBUFFER` 回填是 zsh 社区标准写法（`https://unix.stackexchange.com/questions/595350`；`https://doronbehar.com/articles/ZSH-FZF-completion/`）。已知坑：在 widget 里跑全屏 TUI 会破坏 bracket paste / 终端状态（fzf issue `#4887`，`https://github.com/junegunn/fzf/issues/4887`）。
- 对我们的含义：我们的 C-x widget（`plugin.zsh:349-366`）就是这个类别的实例。`README.md:326-330` 自己承认「交互形态不是改进，两边都是 keybind 呼出全屏 TUI」。诚实地说，这是全插件最没有想象力的部分。

### 输入行分类取代模式键

- 谁在用：Warp、Lacy。
- Warp 的证据（第一手，Warp 自带设计文档 `warp/docs/explorations/natural-language-detection.md`）：输入框有 Shell / AI 两种模式，默认靠自动检测切换；三层分类器（ONNX BERT-tiny → FastText → 启发式，`app/src/input_classifier.rs:11-39`）；启发式里先查一次性自然语言词白名单，再用 completion engine 的 token 描述 + shell 语法特征做阈值判定，最后用词库打分。手动覆盖是前缀 `* `（切 AI 并锁）、`!`（切 shell 并锁）、`#`（AI 命令搜索），或 `Ctrl+I` 快捷键（`app/src/ai/agent_tips.rs:93` 的文案就是 "toggle natural language detection and switch between agent and terminal input"）。自动检测在手动设定后被禁用 250ms 防抖。
- Lacy 的证据（`https://lacy.sh/tools`、`https://dev.to/lacymorrow/2026-ai-terminal-tools-comparison-warp-vs-lacy-shell-vs-traditional-shells-5a8f`）：zsh/bash 插件，逐行做**本地**词法分类（不调 API），shell 命令走绿色指示、自然语言路由到配置的 AI CLI（Claude `claude -p`、OpenCode `opencode run -c`、Gemini）；判成自然语言但作为命令失败时再自动 reroute。它的卖点就是"no prefix, no mode switching"。
- 对我们的含义：这是 2026 年公开工具的主流方向——把「要不要问 AI」这件事从**一次按键切换**降到**输入内容本身**。我们的插件完全没有这一层。

### 把 shell 嵌进 agent 里（PTY + 焦点切换）

- 谁在用：Gemini CLI。
- 证据：`Tab` = `app.focusShellInput`（从 Gemini 焦点移到活动 shell），`Shift+Tab` 移回，`Ctrl+B/L/K` 管理后台 shell 列表（`https://geminicli.com/docs/reference/keyboard-shortcuts`）；交互式 shell 命令跑在 `node-pty` 里，快照 + 流式回放，`ctrl+f` 聚焦（`https://developers.googleblog.com/en/say-hello-to-a-new-level-of-interactivity-in-gemini-cli/`）。
- 对我们的含义：这是与「呼出式 TUI」相反的架构——agent 宿主居留，shell 是它内部的一个可聚焦区域。它同样不需要退出/重放按键，但代价是 agent 必须自己实现终端。

### 终端内语义区 / 私有 hook 协议

- 谁在用：Warp 的 OSC 9278 / DCS `$d`（私有，hex JSON，`warp/RESEARCH_NOTES.md:74`）；iTerm2 / WezTerm 的 OSC 133（Input/Output/Prompt 区）、OSC 7（cwd）、OSC 1337（user vars），`https://wezterm.org/shell-integration.html`、`https://iterm2.com/documentation-shell-integration.html`；frankenterm 用 OSC 133 判「提示符活跃」来决定能不能往 pane 打字（本机 `frankenterm/docs/architecture.md:199-201`、`README.md:220`）。
- 对我们的含义：我们留了一个 OSC `7777;zom;v1;<base64>` 帧、目前没有接收者（`plugin.zsh:210-219`，`README.md:302-315`）。预留私有号给未来的 wezterm fork 是清醒的前向兼容动作，但机制本身是行业常规。

### 后台会话完成通知

- 谁在用：opencode 生态有 `opencode-notify` / `opencode-notificator`（桌面通知 + 声音，`https://opencode.ai/docs/ecosystem`）；Warp 被动建议在块结束后异步出结果（`warp/docs/explorations/passive-ai-suggestions.md`）。
- 对我们的含义：我们用 `ctx.event.subscribe` 监听 `session.execution.succeeded`，再用 outbox 在**下一个提示符前**打一行（`zom-companion.js:386-442`，`plugin.zsh:238-279`）。把通知塞进 shell 的提示符节奏、而不是弹桌面通知，是与众不同的选择，也更贴合"人就坐在终端前"的场景。

### 双宿主扩展点

- 谁在用：最接近的是 Wake（shell hook + PTY 采集 → MCP server → Claude Code 的 tool）。但 Wake 用的是 MCP（一个通用服务器协议），不是 Claude Code 自己的插件 API。
- opencode.nvim（`github.com/nickjvandyke/opencode.nvim`、`github.com/sudo-tee/opencode.nvim`）只扩 Neovim 一个宿主，通过 opencode 的 server API/SDK 对话，不注册 opencode 插件。
- Gemini 是把 shell 嵌进 agent（单宿主，agent 侧）。
- 我们的做法：同一个仓库同时是（a）zsh 的 `add-zsh-hook` 消费者/生产者（`plugin.zsh`），（b）opencode 的原生插件 `setup(ctx)`，用 `ctx.tool.transform` 加工具、`ctx.session.hook("context")` 注入、`ctx.event.subscribe` 订阅（`zom-companion.js:186-214`、`:285-321`、`:349-370`）。两侧共享一个 config、一个 data dir，各读各的节（`README.md:98-131`）。
- 对我们的含义：这是这个插件**最具辨识度**的结构选择，而且暂未找到完全同形的先例。

### 无人认领按键的透传（假设待证）

- 机制：mini 遇到自己没绑定的键，就把原始字节写进 `ZOM_PASSTHROUGH_FILE` 并退出；widget 回来后 `zle -U -- "$keys"` 把按键塞回 ZLE（`plugin.zsh:106-120`、`:333-336`、`:359-364`）。
- 找到的最近邻，都不是同一个东西：
  - Ctrl+Z 挂起（Claude Code / opencode / Gemini）：回到 shell，但 TUI 进程作为 job 仍存在，且是**一个指定键**触发；
  - 指定模式键（Warp `* `/`!`/Ctrl+I、kimi `^X`、Gemini `Tab`）：恰好一个键改变输入归属；
  - 包装函数退出后把**状态**（cwd）交回 shell（yazi 的 `y`、nnn 的 `n`）：交回的是状态不是按键。
  - TIOCSTI（向终端输入队列注字符）自 Linux 6.2 起默认禁用、且因提权问题被内核弃用（`https://docs.kernel.org/process/deprecated.html`），不能作为同类。
- 结论：按目前的检索，「**任意**未认领键 → 退出 + 回放」没有找到直接先例。这是最可能原创的一处。不确定性写在后文。

## 我们的组合里少见的部分

一句话概括：少见的不是 C-x，而是**数据的方向**。

- **双宿主 + 各占一半 owner**：shell 侧只负责生产（记录、信号、OSC 帧，`plugin.zsh:160-220`），agent 宿主侧只负责消费（工具、context hook、recipes，`zom-companion.js`）。两侧没有互相调用，只通过文件系统上的约定交汇。Wake 是最接近的形态，但走 MCP 而非宿主原生插件 API，且它把 shell 采集和 agent 消费分开成两个东西；我们是一个仓库、一个 config、两个 runtime 读各自的节（`README.md:55-59`）。
- **一条独立的返回通道（outbox）**：`outbox.jsonl` 是唯一的 agent→shell 通道，shell 用字节游标每次提示符前恰好消费新增部分（`plugin.zsh:238-279`）。把 agent 的输出送回 shell 提示符节奏，而不是弹窗或另开面板，是少见的组合。
- **无人认领键透传**：见上，尚无先例。
- **把「策略」从 prompt 挪进代码**：`agent/zsh-companion.md` 只管行为，策略参数（TTL、recipe、deliver）都在 `zom-companion.js`（`README.md:47-59`）。这个选址本身是设计品味，不是机制新颖，但值得保留。

## 已被验证、值得考虑替换的做法

- **用输入行分类取代 C-x 呼出**。Warp 和 Lacy 各自独立地把「是否问 AI」下沉到输入内容里。我们的 C-x 是模式键 + 全屏，恰恰是它们试图去掉的那一步。如果目标是"AI 就在 shell 里"，分类路线更轻。（注意：分类器本身有非英文偏斜的已知缺陷，Warp 自己的文档 `natural-language-detection.md:193` 就写了。）
- **AI 产出直接回填提示行**。ShellGPT 的 `_sgpt_zsh`（Ctrl+L）、Atuin（tab 插入）都是几行 zsh 就能做到、且失败可还原。对「修上一条失败命令」这个主场景，比 `--prefill` 进全屏 composer 更顺手。我们的 `zom-last` 已经走了非 TUI 路线，但它把结果打印出来，没有回填到 ZLE。
- **补上输出采集**。Wake 证明「shell hook 拿结构 + PTY 拿输出」可行。我们明确只采元数据（`README.md:140-143`）。是否补是一个取舍（仓库体积、密钥脱敏），但当前的「为什么失败」答案质量确实受限。
- **重新定位 ctrl+z**。上游 opencode 已有 `terminal_suspend: ctrl+z`。把它当作"和上游对齐 + 修 bug"，而不是 fork 的卖点。

## 我们在重复造轮子的部分

- **命令历史存储**：Atuin（SQLite、端到端加密同步、600M+ 命令）、zsh-histdb、mcfly、hstr 都已解决。"自己写一个 JSONL store"本身没有新意；我们的价值只在"给模型读"，不在"存"。
- **command-not-found → AI**：zsh-kimi-cli、thefuck、大量 zsh 插件、以及多篇 Medium 教程都在做。不是差异化点。
- **把 shell 现场注入 agent 上下文**：Claude Code 的 hook（`UserPromptSubmit` / `SessionStart` 注入，exit code 2 阻断，`https://code.claude.com/docs/en/hooks`）和 opencode 生态的一堆插件（`opencode-type-inject`、`opencode-supermemory` 等，`https://opencode.ai/docs/ecosystem`）都在做。我们的 context hook 是其中一个实例。
- **zle widget 里呼出全屏 TUI**：fzf / yazi / kimi 的常规写法，连坑（bracket paste 被破坏，fzf `#4887`）都是公开的。
- **失败触发的模型建议**：Warp 的被动建议（块结束后异步请求 → 内联 banner，`warp/docs/explorations/passive-ai-suggestions.md`）和 thefuck 都在做；我们的 recipe 是更干净的声明式版本，但不是新类别。

## 结论

这个插件的机制组合里，真正稀缺的是三样，按稀缺度排：无人认领键透传（最可能原创）、双宿主 + 各占一半 owner 的结构、agent 输出经 outbox 回到 shell 提示符节奏。

它最大的问题是把最不稀缺的部分当成了门面：C-x 呼出全屏 TUI 是一个 2022 年形状的交互，而公开工具在 2026 年已经把重心移到输入行分类（Warp / Lacy）、agent 内嵌 shell（Gemini）、提示行回填（Atuin / ShellGPT）。因此若要谈"机制组合的想象力"，应该把叙述从「C-x 呼出」改成「两套宿主扩展点的分工 + 两条独立通道（OSC 给未来渲染层、outbox 给现在的 shell）」。前者是可替换的交互皮，后者才是这个项目独有的结构。

数据层（history store、失败信号、OSC 帧）是刻意做成"终态可复用"的（`README.md:10-13`），这个判断成立：它与交互面解耦，换掉 C-x 不影响它。但"存储"这一层本身是重复造轮子，真正的资产是数据**形状**和**消费方式**，不是存储实现。

## 未解决的问题

- 没有真正运行任何外部工具。Warp 结论来自源码与它自带的设计文档；Lacy / Atuin / Gemini / Claude Code 结论来自官方文档与 README，可能与其当前实际行为有偏差。Warp 快照为 `a19bf16`（2026-04-29），仓库演化快。
- 「无人认领键透传」的先例检索用了多组关键词，均未命中直接同类。这是**未找到**，不是**不存在**；可能存在于未公开的 dotfiles、Discord 讨论或小众项目里。
- 没有核实 Bracketed paste 在 `zle -U` 回放路径下是否会被打乱（fzf 有同类已知 bug），这需要实机验证。
- 没有评估 Lacy 的分类器准确率与是否真能处理中文（Warp 的分类器已被文档自己承认偏英文）。
- 没有清点本机 17 个 zshrc.d 模块里是否已有键位/历史采集与 C-x 冲突（`IMPLEMENTATION_ROUTES.md:9` 提到的深度定制环境）。
