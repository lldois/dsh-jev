# dsh-jev

DeepSeek Harness (DSH) 的 TypeSafe Jev 快思考 (System One) 决策与语义路由插件。

参考 [pi-typesafe](https://github.com/DevMortimer/pi-typesafe) 设计，将 TypeSafe Jev 模型引入 DeepSeek Harness。提供 Cordis 服务注入、DSH 工具注册 (`typesafe_evaluate` / `jev_evaluate`)、指令系统 (`/typesafe` 与 `/jev`)、成本与额度控制、历史样本阈值校准套件，以及会话前置钩子。

---

## 为什么 Coding Agent 需要接入 Jev？

很多 Coding Agent 都在用昂贵、缓慢的主模型处理“小判断”：
- 这个 Issue 属于哪一类？
- 回复有没有真正回答问题？
- 改动风险是低、中还是高？
- 这个 PR 是可以自动合并还是必须人工审查？

能做，但有点像让架构师每天帮你分快递。**pi-typesafe** / **dsh-jev** 提供了另一种思路：把 TypeSafe 的判断模型 Jev 接进 Agent，专门处理这类小而频繁、需要结构化结果的决策。

Jev 不负责写代码，也不适合长链路推理。你给它一段 `state`，再提出几个 typed `questions`，它直接返回选项、分数或概率（耗时在数百毫秒内，价格低至 $0.042 / 百万输入 token，输出 token 免费）。

### 1. 把主模型从机械判断里解放出来
主模型继续负责读代码、规划、修改和调试。分类、打分、筛选、检查回复是否答题，这些任务交给 Jev。如果一个 Agent 每轮都要检查十几个文件、Issue 或工具结果，这种拆分比反复调用主模型更适合自动化。

### 2. 决策可以真正写进代码
普通 LLM 经常返回一段 JSON，但 JSON 只是输出格式正确，不代表判断本身可以安全执行。Jev 会返回概率分布。你可以自己定阈值：
```javascript
if (riskProbability > 0.85) {
  requireHumanReview();
} else {
  continueAutomatically();
}
```
低置信度时交给主模型或人工，高置信度时继续跑。这里要注意，confidence 只是概率分布的集中程度，不是“判断一定正确”的证明。

### 3. 一次批量问多个独立问题
Jev 支持 Choice、Score 和 Noul 三种问题。同一个 state 可以一次提交多个问题，每个问题并行、独立执行。互相不偷看答案，最后由你的代码组合结果。

---

## 功能特性

- **类型化决策工具 (`typesafe_evaluate` / `jev_evaluate`)**: 从任何 LLM 轮次直接调用 Jev，支持 `choice`（单选与概率分布）、`noul`（0–1 是非概率）、`score`（阶梯量表与打分）。
- **技能语义发现 (`jev_find_skill`)**: 语义检索并推荐当前任务最相关的专业技能 (`SKILL.md`)，不污染全局 Prompt 上下文。
- **工具语义发现 (`jev_find_tools`)**: 语义评估并找出当前会话中匹配的 DSH 工具。
- **Slash 指令 (`/typesafe` 与 `/jev`)**:
  - `/typesafe status` — 查看配置、认证状态、本次运行消耗与每日额度限制。
  - `/typesafe login [key]` — 校验并将 API Key 保存到 `~/.pi/agent/pi-typesafe/auth.json`。
  - `/typesafe logout` — 清除已保存的 API Key 并重置认证状态。
  - `/typesafe enable` — 在当前会话开通 TypeSafe 工具调用。
  - `/typesafe disable` — 关闭 TypeSafe 工具调用。
  - `/typesafe test [prompt]` — 执行 Bug 分类连通性测试或指定提示词判断。
  - `/typesafe playground [json]` — 直接提交自定义 state 和 questions JSON 测试。
  - `/typesafe calibrate` — 历史样本阈值校准工具。
  - `/typesafe skills [query]` — 在输入框快速搜索当前会话技能。
  - `/typesafe tools [query]` — 在输入框快速搜索当前会话工具。
  - `/typesafe auto [on|off]` — 开关每轮提示词技能自动推荐。
  - `/typesafe help` — 查看完整帮助。
- **请求次数、Token 与美元成本上限**:
  - 会话请求次数上限（默认 20 次）。
  - 每日请求、Token、美元成本上限（支持环境变量 `PI_TYPESAFE_MAX_REQUESTS_PER_DAY`、`PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY`、`PI_TYPESAFE_MAX_USD_PER_DAY`）。
  - 本地跨进程 31 天账本持久化 (`~/.pi/agent/pi-typesafe/usage.json`)。
- **历史样本阈值校准套件 (`calibrate.js`)**:
  提供 Mann-Whitney 秩和 AUC 计算、网格扫描、F1 寻优与回放器，用于在带标签的历史样本上校准最佳自动化阈值。
- **CI/CD 验收门禁 CLI (`dsh-jev-gate` / `jev-gate`)**:
  对 git diff、文件或管道输出进行自然语言规范检查并返回退出码。

---

## 快速上手与认证

### 1. 配置 API Key

进入 DSH 后输入：
```text
/typesafe login your_api_key_here
```
Key 会保存在 `~/.pi/agent/pi-typesafe/auth.json`。

在 CI 或自动化脚本中，也可使用环境变量：
```bash
export TYPESAFE_API_KEY=your_key_here
export PI_TYPESAFE_ENABLED=1
```

### 2. 状态检查与开通

```text
/typesafe status
/typesafe test
/typesafe enable
```

---

## 提问技巧

- **判断“文本写了什么”，不要让 Jev 猜最终结论**：例如不要问“这个 Bug 能复现吗？”，更准确的是“report.body 是否明确表示该问题每次都会发生？”。
- **Score 别写“低、中、高”这种空等级**：最好换成可检查的状态，如“仅影响外观”、“存在可用绕过方案”、“阻止核心流程”。
- **Choice 一定留一个 other 或 unclear**：模型不能选择你没有提供的答案，漏掉兜底项会迫使它在错误选项里硬选。
- **保持边界**：跨多个步骤推理、理解大型代码库、设计架构继续交给主模型；Jev 负责做路由、过滤、评分和验收信号。

---

## 运行测试

```bash
npm test
```

---

## 许可证

MIT © [lldois](https://github.com/lldois)

