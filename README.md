# dsh-context-optimizer

`dsh-context-optimizer` 是一个 DeepSeek Harness（DSH）插件，用于审计并优化模型每轮请求携带的上下文。它将“上下文诊断”和“工具渐进式发现”合并在同一个插件中。

## 它解决什么问题

当 Agent 接入大量工具、MCP 服务、技能和项目指令时，工具 schema、技能说明与系统指令会在每轮请求中持续占用上下文。这个插件会：

- 审计 `AGENTS.md` 指令链、技能、工具 schema 和 MCP 工具的 token 成本；
- 识别重复指令、重复技能说明和同名技能遮蔽；
- 将低频工具收进按需发现的工具目录，避免把完整 schema 始终注入模型；
- 保留核心工具和最近使用的工具，并提供 `tool_search`、`tool_describe`、`tool_call` 供模型按需发现和调用长尾工具；
- 在 DSH Web 会话输入框右侧展示上下文健康度、优化前后 token、节省比例、Tier、延迟加载工具数和 warm tools。

## 安装

### 从 GitHub 安装

仓库安装依赖已提交的构建产物，适合使用最新版本：

```sh
dsh plugin --profile web add "github:lovesong1026/dsh-context-optimizer"
```

### 从 npm 安装

发布到 npm 后可使用包名安装：

```sh
dsh plugin --profile web add dsh-context-optimizer
```

安装完成后重启 Web：

```sh
dsh web
```

进入任意已有会话，在底部输入框工具栏最右侧点击心跳/波形图标即可打开 Context Optimizer 面板。

## 功能

### 上下文审计

插件提供 `context_audit` 工具，输出指令、技能、工具与 MCP 工具的 token 估算、重复/遮蔽检测结果及优化建议。审计全程只读，不修改工作区文件。

### 工具渐进式发现

插件会按当前工具规模和配置决定 Tier。核心工具与近期工具保持直接可见，其余工具由精简目录表示。模型可使用下列工具继续操作：

- `tool_search`：在延迟加载工具中检索相关工具；
- `tool_describe`：读取指定工具的完整定义；
- `tool_call`：通过桥接层调用真实工具，真实工具自身的审批和事件记录仍然生效。

### Web 面板

面板会显示：

- 上下文 token 构成及健康状态；
- 优化前、优化后和节省的 token；
- 当前 Tier、可见工具数、延迟加载工具数；
- 当前 warm tools；
- 审计刷新结果和优化建议。

## 配置

DSH bundle 的基础配置：

```yaml
context-optimizer:
  audit:
    cacheTtlMs: 60000
  tools:
    enabled: auto
    thresholdPct: 5
    maxWarmTools: 8
```

工具分组、rerank 配置、预加载工具和额外核心工具可写入：

```text
~/.dsh/dsh-context-optimizer.json
<工作区>/.dsh/dsh-context-optimizer.json
```

## 开发

需要 Node.js 22.19+，以及兼容 `0.1.2-rc.1` 的 DeepSeek Harness checkout。

```sh
npm run build -- --checkout /path/to/deepseek-harness
npm test
npm run test:audit
npm run test:optimizer
npm run test:integration
```

各测试层覆盖独立的渐进式发现逻辑、审计逻辑、DSH 宿主集成以及浏览器构建产物。

## 兼容性

为了兼容已有 Agent 工作流，插件保留公共模型工具名：`context_audit`、`tool_search`、`tool_describe`、`tool_call`。

## 许可证

本项目以 MIT 许可证发布。详见 [LICENSE](LICENSE)。
