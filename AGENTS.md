# zsh-opencode-mini 仓库指南

把 opencode（mini 模式）接进 zsh 的插件：shell 侧记录命令历史与状态，opencode 侧的
companion 插件消费它们（`zom_context`、失败感知、recipe 提示、扩展宿主）。

## 结构

- `zsh-opencode-mini.plugin.zsh`：zsh 侧全部逻辑。配置解析（TOML）、launcher
  argv、opencode 侧产物安装（`__zom_install_opencode_parts`）。
- `companion.js`：opencode 侧唯一装进 `~/.config/opencode/plugins/` 的文件。
  事件循环、notices/outbox 通道、扩展宿主（`loadExtensions` + host 服务
  `report`/`onUsageDelta`/`storage`）。根目录直放，`opencode-plugin/` 这类中间
  目录名已被否掉，不要恢复。
- `extensions/*.js`：纯策略模块。宿主管机制（事件、落盘、报告），扩展只做判断。
  新增扩展不需要改安装器——安装器镜像整个目录（含删除），loader 扫到即加载。
- `agent/zsh-companion.md`：agent 提示词，只有行为规则。
- `config.example.toml`：逐键注释的配置模板，是配置面的权威文档。

## 不变量

- 双侧解析同一份 `config.toml`，都用 python `tomllib`（`__zom_python()` 挑解释器），
  不引入第二种 TOML 方言。
- 安装器只做真实复制（cmp 后刷新），不软链：opencode 的配置不能耦合到可能
  正在编辑或被删除的检出。目的地从 `XDG_CONFIG_HOME:-~/.config` 推导，与
  companion 的查找规则同源。
- 落盘有界：新文件要么滚动（history-*.jsonl）、要么截尾（outbox/bg.jsonl）、
  要么覆盖（last-failure.json）；往数据目录加东西必须自带盖子，并在
  `extensions/state-watch.js` 或插件内登记清理路径。
- zsh 侧函数一律 `__zom_` 前缀；插件会在用户的交互 shell 里运行，写代码按
  `nounset`/`err_return` 存活的标准来（参数展开带 `:-`，glob 带 `(N)`）。

## 验证

```zsh
zsh -n zsh-opencode-mini.plugin.zsh          # 语法
node --check companion.js && node --check extensions/*.js
node tests/companion.test.mjs                # companion 单测（mock ctx）
tests/run.zsh                                # 集成套件 S1-S17（沙箱 zsh + mock opencode）
```

改安装器后用 `XDG_CONFIG_HOME=$(mktemp -d)` 沙箱跑一遍安装，验证产物落点与
目录镜像（含孤儿文件清理），不要直接往真实 `~/.config` 里打。

## 提交

一行式 message，`<scope>: <中文摘要>`；插件与 fork（opencode-zom）是两个仓，
跨仓联动的改动各自提交、各自说明。push 与发版前先问 owner。
