# Session Fleet 精简：目标、评估标准与逐项对比（2026-11-17）

## 目标

把 Session Fleet 从"6 个工具 + 4,240 字符常驻策略"收窄到有证据支撑的最小能力面。判据不是"功能多少"，而是**单位成本换来的真实使用**：每个会话常驻的 token、每项能力的实测使用频率、删减后协调成功率是否下降。

不做什么：不新增工具，不重建索引（该项目 2026-11-03 建过、11-04 回滚，见 `2b4189e`/`ed478a8`），不为低频场景继续加协议。

## 五项评估指标

| 指标 | 定义 | 测量方法 | 基线（0.7.0） |
| --- | --- | --- | --- |
| M1 注入成本 | 每个会话常驻的策略 + 六个工具 schema 字符数 | 宿主 `Tool.listTools` 取 Fleet 六工具的 `description+parameters` JSON 长度；策略取 `src/policy.ts` 加动态后缀 | 12,967 字符（策略 4,240 + 工具 8,727，≈3.7k tokens） |
| M2 能力覆盖 | 默认 profile（仅 dsh-base）与增强 profile（含 experimental-session-search）下各能力是否有提供方 | 出厂补丁静态核对 + 独立 profile 实测：路径（a）默认、(b) 增强，逐项检查 发现/读证据/检索/建会话/投递/协作/收件箱 | 默认：检索=无、原生读=无；增强：两者都有 |
| M3 协调成功率 | 真实模型在 4 个场景下的达标率 | `evals/` 回放，candidate 臂每场景 ≥2 次 | candidate 2–4/4，baseline 1/4，none 1/4（样本小） |
| M4 兼容面 | 公开工具名/参数/输出字段的破坏性变更数；需同步的文档义务数 | diff 已发布 schema；统计 AGENTS.md 强制同步点（代码/测试/README×2/CHANGELOG/策略） | 6 工具、10 配置项、7 种消息类型、4 种 inspect 模式 |
| M5 认知成本 | 新人回答"发一条消息会发生什么"需读的文件与概念数 | 源码行数、配置项、概念计数 | 源码 2,035 行、测试 2,495 行、10 配置项 |

## 五个杠杆的逐项对比

| 杠杆 | 对象 | M1 收益 | M2 风险 | M4 兼容 | 可测性 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 删除 | `search_sessions` | −1,091 字符、−180s 超时、−1 决策文档 | 默认 profile 本就不可用；增强 profile 有原生 `session_search` 替代 | 破坏 1 个工具名 | 高：直接查 M2 两路径 | **优先做**，风险最低 |
| 退役 | `transcript: true` 导出 | −159 行、−4 配置项、−1 模式 | 可能有人依赖 grep 导出；未经统计 | 破坏 1 个参数 | 中：需先统计真实调用 | 先统计再定 |
| 收敛 | `inspect_session` 四模式 → outline + read | −~250 行、−2 模式 | 默认 profile 唯一读入口，不能降能力 | 中 | 高 | 第二阶段 |
| 提示词 | policy 4,240 → ≤1,500 字符 | −2.7k 字符常驻 | 可能降低触发率 | 无（非公开契约） | 高：M3 对比 | **先测后改** |
| 收敛 | 协作协议 7 种 → propose/accept/complete/release | −~200 行、−CAS | A/B 类真实协作依赖 propose/accept/complete | 破坏 3 种类型，需 major | 中 | 最后做 |

## 验证装置（独立 profile + ego）

1. `dsh --profile fleet-test --from-default-profile web` 建一个只含 dsh-base 的干净 profile，用于 M2 默认路径验证。
2. `dsh --profile fleet-enhanced --from-default-profile web` 加装 experimental-session-search，用于增强路径验证。
3. 每个 profile 用 `--patch` 注入 Fleet 的 link 包与 magpie 模型配置，`--port 0 --no-open` 启动，ego-browser 打开页面。
4. 在页面里新建会话，输入真实任务（如"看下现在有哪些会话在并行改这个仓库"），从会话日志的 `tool/call` 事件读模型实际调用了什么——这才是 M2/M3 的真实数据，不靠 schema 推断。

## 执行顺序

1. 采集基线（M1/M5 静态 + M3 回放）。
2. 搭两个独立 profile，实测 M2 的两条路径。
3. 按上表"优先做"逐项实施，每项后跑 M1/M3 回归。
4. 更新双语文档与 CHANGELOG，按 semver 发布。

## 基线实测（2026-11-17，独立 profile）

验证装置：

```sh
dsh --profile fleet-base --from-default-profile web --dump-config   # 只含 dsh-base + dsh-web-app
dsh plugin --profile fleet-base add link:/Users/sivan/workspace/dsh-session-fleet-plugin
dsh --profile fleet-base --port 0 --no-open                          # 独立实例
```

用 ego 打开页面、新建会话并发送真实任务，从界面读取模型的工具清单与实际调用结果。

### M2(a) 默认路径实测

| 观测 | 结果 |
| --- | --- |
| 模型可见的 `session` 工具 | 只有 Fleet 的 6 个；原生 `session_search`/`session_event_read`/`session_trace` 等 **0 个**（它们不在 dsh-base） |
| `search_sessions` 实际调用 | 失败，原文：`session search is disabled: this deployment configures the session-query index with openAt "never". Use list_sessions({query: "fleet"}) for title matches, then inspect_session...` |
| 单轮上下文 | 20.5K tokens 输入，缓存命中 2%（含 AGENTS.md、skill catalog、runtime context） |

结论：**默认路径下 `search_sessions` 是确定的死路**，而 `inspect_session` 是唯一读入口——这两点从推断升级为实测。

### 额外发现：headless 模板无法承载 Fleet

`dsh --profile fleet-headless --from-default-profile headless` 安装 Fleet 后，插件停在 `pending (waiting for services: sessionController, workspaceRegistry)`，因为 headless 模板不含这两个服务。含义：Fleet 的可用前提是「profile 含 session-controller + workspace-registry」，即 desktop/web 系模板；headless 与最小模板用户装上也用不了。这条应写进 README 的安装前提。

## P0 结果：删除 search_sessions（已完成）

| 指标               | 改前   | 改后     | 变化                    |
| ------------------ | ------ | -------- | ----------------------- |
| 工具数             | 6      | 5        | −1                      |
| 工具 schema 字符   | 8,727  | 7,636    | −1,091                  |
| 常驻注入（含策略） | 12,967 | 11,876   | **−1,091（−8.4%）**     |
| 配置项             | 10     | 7        | −3（searchCursor 三项） |
| 源码行数           | 2,035  | 约 1,690 | −约 345                 |

隔离 profile 实测（fleet-base，只含 dsh-base + web-app + Fleet，无原生会话工具）：

- 模型列出的会话工具从 6 个变为 **5 个**，`search_sessions` 已消失；
- 替代路径可用：`list_sessions({ query: "fleet", limit: 2 })` 返回 1 条、`hasMore: false`；
- 删除前同一实例实测 `search_sessions` 必然失败（`SESSION_QUERY_SEARCH_DISABLED`）。

结论：该工具在默认路径本来就是死路，删除不损失任何可用能力，且它在增强路径也有原生 `session_search` 竞争。测试 135 个全过。

遗留说明：删除导致 11 个只测该工具的用例被移除，覆盖重心转向 list/inspect/coordination。
