# dsh-jev

基于 [TypeSafe](https://typesafe.ai) Jev 的 **DeepSeek Harness (DSH)** 语义工具路由与类型化 System One 决策插件。

本项目参考 Pi coding agent 的 Jev 插件 (`pi-jev`)，结合 DeepSeek Harness 的 Cordis 插件架构、服务注入、工具系统与指令体系，为 DSH 提供了原生、高内聚、零破坏性的语义决策插件。

---

## 功能特性

- **类型化决策工具 (`jev_evaluate`)**：模型在对话中直接调用 TypeSafe Jev 获得快速、确定性、高置信度校准的 System One 判定结果，涵盖 `choice`（分类）、`noul`（真伪概率判定）、`score`（等级量表评分），输出 Token 完全免费（Jev 不生成冗长文本）。
- **技能语义发现 (`jev_find_skill`)**：在工作区技能较多时，通过 Jev 语义理解用户任务与各技能描述的相关度（相关概率 $P \ge 0.65$），精准推荐对应 `SKILL.md`，避免全部加载污染上下文。
- **工具语义发现 (`jev_find_tools`)**：对当前 DSH 会话中已注册的所有工具（包括原生工具、MCP 工具、第三方插件工具）进行语义匹配与打分，推荐最契合当前任务的工具。
- **人机指令交互 (`/jev`)**：
  - `/jev status`：查看 Jev 配置来源、会话请求数、消耗 Token 数、平均延迟及当前生效工具/技能数。
  - `/jev test [prompt]`：即时测试与 TypeSafe Jev API 的连通性或对输入 prompt 进行现场判定。
  - `/jev skills [query]`：直接在聊天框内语义检索匹配技能。
  - `/jev tools [query]`：直接在聊天框内语义检索匹配工具。
  - `/jev auto [on|off]`：开关每轮对话前自动推荐技能的 Auto 模式。
  - `/jev help`：显示指令帮助信息。
- **自动建议钩子 (`agent/pre-step`)**：集成于 DSH 的 `agent/pre-step` 瀑布流拦截器中，在用户提出复杂任务时自动语义评估匹配技能，并以轻量 `<system-reminder>` 引导模型先调用 `skill` 工具加载完整指南。
- **任务门禁检查 CLI (`dsh-jev-gate` / `jev-gate`)**：可在流水线、子智能体后置校验或自动化脚本中调用的独立命令行工具。评估 Git Diff、文件或管道输入是否满足自然语言验收标准（通过返回 0，未达标返回 1，出错返回 2）。
- **无损兜底与安全保底**：当未配置 API 密钥或网络不可用时，自动降级至本地关键词启发式排序，绝不阻塞或中断 DSH 正常对话。

### 针对 DSH 特性的迁移适配与取舍

- **子代理编排**：DSH 拥有原生的第一方子代理体系（`@deepseek-ai/dsh-subagent`、typert 协议与会话树），原 `pi-jev` 中针对 `pi-subagents` 的私有 RPC 工作流脚本不适用且会产生冲突，故不作迁移。
- **模型自动切换**：DSH 的模型由预设（presets）、`agent-default-model` 及 `settings.yaml` 统一纳管，不适合每轮 prompt 强制改写底层模型配置，故保持 DSH 原生模型调度。
- **上下文压缩**：DSH 会话基于不可变日志与 chunked-list 结构，压缩机制由官方 `@deepseek-ai/dsh-compaction` 全程接管，避免非官方改写导致投影错位。

---

## 在 DeepSeek Harness 中安装

### 1. 添加插件依赖

在 DSH 配置文件目录（通常为 `~/.dsh/profiles/web`）下安装或链接本插件：

```bash
# 通过 GitHub 仓库安装
pnpm add github:lldois/dsh-jev

# 或本地链接开发
pnpm add file:C:/Users/lldois/workspace/dsh-jev
```

### 2. 启用 Bundle

在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 列表中添加 `"dsh-jev"`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-jev"
      ]
    }
  }
}
```

插件自带的 `cordis.patch.yml` 会自动将 `id: jev` 注入至 Cordis 服务容器。

---

## 凭据配置

可通过以下任一途径配置 TypeSafe API Key（插件会自动按优先级探测）：

1. **环境变量**：`TYPESAFE_API_KEY=your_key_here`
2. **DSH 密钥文件**：写入至 `~/.dsh/secrets/typesafe_api_key`
3. **跨 Agent 共享密钥**：写入至 `~/.pi/agent/secrets/typesafe_api_key`
4. **工作区环境变量**：工作区 `workspace/chat/typesafe-eval/.env`
5. **DSH 配置文件**：在 `~/.dsh/settings.yaml` 的 `jev:` 小节中配置。

配置完成后在 DSH 中输入 `/jev status` 即可验证状态。

---

## 工具接口示例

### 1. `jev_evaluate`（类型化判定）

```json
{
  "state": "用户提交退款申请：订单商品延误超过3周，且客服多次未回应。",
  "questions": {
    "is_complaint": {
      "type": "noul",
      "instructions": "该请求是否属于客诉类事件？"
    },
    "reason": {
      "type": "choice",
      "instructions": "该问题的主要原因为？",
      "criteria": {
        "logistics": "物流或延误问题",
        "product_quality": "商品瑕疵或破损",
        "service_attitude": "服务态度差"
      }
    },
    "priority": {
      "type": "score",
      "instructions": "处理优先级评估",
      "criteria": ["低", "中", "高", "紧急"]
    }
  }
}
```

### 2. `jev_find_skill`（技能发现）

```json
{
  "query": "分析优化大模型多目标排序模型的交叉特征和重排策略",
  "threshold": 0.65
}
```

### 3. `jev_find_tools`（工具发现）

```json
{
  "query": "执行带有超时保护的系统命令并获取终端回显"
}
```

---

## 门禁检查 CLI (`dsh-jev-gate`)

```bash
# 检查当前 Git Diff 是否满足验收标准
dsh-jev-gate -c "所有公开导出的接口均有详尽的注释且没有新增 any 类型" -d

# 检查测试或构建输出
npm test 2>&1 | dsh-jev-gate -c "全部单元测试通过且无未处理的 Promise rejection"

# JSON 格式输出与指定阈值
dsh-jev-gate -c "文档已完整更新" -f ./README.md -p 0.85 --json
```

判定通过退出码为 0，不通过为 1，异常为 2（可搭配 `--fail-open` 参数兜底返回 0）。

---

## 自动化测试

```bash
node --test test/*.test.js
```

测试套件已覆盖客户端密钥探测、异常边界、三项工具注册与执行、slash commands、门禁逻辑及与 TypeSafe 远程服务的 live-probe 集成校验。

---

## 开源协议

MIT © [lldois](https://github.com/lldois)

