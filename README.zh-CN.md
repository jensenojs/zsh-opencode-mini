# zsh-opencode-mini

在 shell 里按 `C-x` 唤起 [opencode](https://opencode.ai) mini 助手。插件在后台记录你的命令（文本、退出码、目录），并给 AI 一条懒加载、结构化的查阅通道——不用粘贴任何东西，AI 就知道你的现场。

交互形状借鉴自 [zsh-kimi-cli](https://github.com/teddy0207/zsh-kimi-cli)，在此致谢。

> 设计笔记：[`docs/DESIGN.md`](docs/DESIGN.md) · 教程：[`docs/TUTORIAL.zh-CN.md`](docs/TUTORIAL.zh-CN.md)

## 安装

```zsh
git clone https://github.com/jensenojs/zsh-opencode-mini
cd zsh-opencode-mini

# 1+2. opencode 侧：agent 与插件（AI 能力的来源）
mkdir -p ~/.config/opencode/agent ~/.config/opencode/plugins
ln -sf "$PWD/agent/zsh-companion.md" ~/.config/opencode/agent/zsh-companion.md
ln -sf "$PWD/opencode-plugin/zom-companion.js" ~/.config/opencode/plugins/zom-companion.js

# 3. zsh 侧：记录 + 键位
echo "source $PWD/zsh-opencode-mini.plugin.zsh" >> ~/.zshrc
```

任何 zsh 插件管理器都可用（`<name>.plugin.zsh` 约定）——以
[sheldon](https://github.com/rossmacarthur/sheldon) 为例：

```toml
[plugins.zsh-opencode-mini]
github = "jensenojs/zsh-opencode-mini"
use = ["zsh-opencode-mini.plugin.zsh"]
```

**卸载**：删掉 source 行和两个软链；可选
`rm -rf ~/.local/share/zsh-opencode-mini ~/.config/zsh-opencode-mini`。
没有其它残留：不覆盖 widget、不动 prompt。

依赖：`opencode`（最新 v2）、`jq`、`base64`。

## 使用

| 按键 / 命令 | 作用 |
|---|---|
| `C-x` | 打开/关闭 AI mini 会话（`ses_zom-main`，配自建二进制可感知目录） |
| `ctrl+z`（mini 内） | 干净退出 mini——与 `C-x` 收起同一条路径；再按 `C-x` 召回 |
| 其它未绑定键（mini 内） | 交还 shell 生效——比如 `ctrl+o` 落到 zsh 提示符执行 |
| `zom [args]` | 脚本可用的启动器 |
| `zom-last` | 把最近失败的命令交给 `opencode run` |
| `zom-bg <prompt>` | 后台长任务；完成通知以 `zom:` 行送达 |
| `zom: <text>` | 送达行（recipes / 后台通知），出现在下一个提示符前 |
| `zom-config` | 打印全部配置项的生效值与来源（只读） |

命令失败后，输入框会预填一条分析提示词（你确认后才发送）。AI 也能用
`zom_context` 工具自己查历史——新鲜的才注入，没问的不加载。

## 配置

可选。把 [`config.example.jsonc`](config.example.jsonc) 复制到
`~/.config/zsh-opencode-mini/config.jsonc`；没有配置文件时全部走默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `shell.keybind` | `"^X"` | 唤起键；`"off"` 关闭 |
| `shell.dataDir` | `~/.local/share/zsh-opencode-mini` | 历史 / 失败信号 / outbox 存储（允许 `~`） |
| `shell.resume` | `"main"` | `"main"`=专属会话；`"off"`=每次全新 |
| `shell.replay` / `replayLimit` | `"on"` / `50` | 重开时回放的消息量（`"off"`=不回放） |
| `shell.binary` | `"opencode-zom"` | mini 启动用的二进制；默认是 `scripts/install-zom-binary.sh` 装的 zom fork（官方构建没有 inline resume/透传，缺了会报错而不会静默回落） |
| `shell.passthrough` | `"on"` | 未绑定键交还 shell，而不是吞掉 |
| `shell.failurePrefill` | 内置模板 | 失败后预填的模板（`{cmd}` `{exit}` `{cwd}`；`"off"` 关闭） |
| `companion.failureTtlSeconds` | `600` | 失败信号对 AI 保持「新鲜」的秒数 |
| `companion.recentDefaultN` | `20` | `zom_context` 工具 `query=recent` 返回的行数 |
| `recipes.<name>`（顶层） | — | 事件驱动的声明式模型调用（`failure` / `bg-done` / `manual`），名字须匹配 `^[A-Za-z0-9_-]+$`，见示例配置 |

配置在插件加载时读一次，改完开新 shell 生效。`zom-config` 可查看全部生效值
（含装在 `~/.config/opencode/` 下的部件状态）；插件绝不写任何配置文件。

## 工作原理

- zsh `preexec`/`precmd` hook 把命令元数据追加进本地 JSONL 存储；非零退出
  额外刷新失败信号。只记元数据，不抓输出。
- opencode 插件把这个存储暴露成 `zom_context` 工具和带新鲜度门槛的
  context 注入；结果与通知经唯一的 `outbox.jsonl` 返回，shell 在每个
  提示符前消费。
- opencode 插件 API 漂移时大声拒绝加载（锚定最新 v2）。

## 已知限制

- TUI 里跑的命令不经过 zsh hook（无自引用污染）
- 并发 shell 会互相覆盖 `last-failure.json`（后写胜出）
- 后台会话失败时只在能读到 session id 的情况下上报；上游失败事件形状未验证
