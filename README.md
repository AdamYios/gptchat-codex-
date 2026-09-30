# ChatGPT ↔ Codex 自动桥接

这个项目把 Edge 中的 ChatGPT 会话连接到本机 Codex 桌面任务。Edge 扩展负责识别指令卡片和回传最终报告；`bridge.py` 负责把指令投递到所选 Codex 任务并等待最终回答。长对话加速器已集成在同一个扩展里，不需要安装另一个扩展。

适用于 Windows、已登录的 Edge/ChatGPT、Codex 桌面应用和可用的 Codex CLI。桥接器只用 Python 标准库。

## 功能

- 自动把 ChatGPT 指令卡片发送到对应 Codex 任务，并把 Codex 最终报告发回同一 ChatGPT 会话。
- 指令卡片协议：标题为“给 Codex 的指令”，卡片带复制按钮。自动流程只发送卡片正文，不会把整条 ChatGPT 回复当成指令。卡片不明确时，可在 popup 的“更多操作”中查看候选并手动选择。
- 防重复：扩展根据会话路径、消息单元标记和规范化正文生成稳定的 `instructionId`；无消息单元标记时回退到正文 hash。发送前在当前标签页的 `sessionStorage` 记为 `pending`，成功后记为 `seen`；两种状态都不会自动重发。bridge 对已接受的相同 ID 返回幂等成功，不会再次启动 Codex。
- “结束当前流程”：结束桥接的自动流程，但保留 bridge 连接和标签页绑定。已经运行的 Codex 不会被取消，它之后的报告不会自动发送。Codex 仍在运行时，新流程的“开始”按钮会暂时禁用；任务完成后可选择 A/B 重新开始。
- popup 按当前状态切换工作流：未绑定时显示连接配置；连接处于 `setup` 或 `stopped` 时显示起点选择；活动阶段显示当前任务。查看卡片、报告恢复和操作记录放在“更多操作”。
- 内置长对话加速：启用后，首次会话请求限制为最近 N 轮；阻止 `messages?before=...` 的旧历史分页，并将响应的 `page_info.has_previous_page` 设为 `false`。可设置实时滑动窗口和屏幕外渲染优化。
- 每个 ChatGPT 标签页可绑定一个独立 Codex 任务；同一个扩展可管理多个任务。

## 安装和启动

### 1. 准备项目和命令

在 PowerShell 中进入仓库目录。也可以从 GitHub 克隆：

```powershell
git clone https://github.com/AdamYios/gptchat-codex-.git
cd .\gptchat-codex-
python --version
codex --version
```

需要 Python 3.10 或更高版本，以及可运行的 Codex CLI。若 `python` 命令不可用，可按本机配置使用 `py -3`。

### 2. 在 Edge 加载扩展

1. 打开 `edge://extensions`，开启“开发人员模式”。
2. 选择“加载解压缩的扩展”，指定仓库里的整个 `extension` 文件夹。
3. 打开目标 ChatGPT 会话并刷新页面，让页面脚本加载。

修改扩展文件后，在 `edge://extensions` 点击扩展的“重新加载”，再刷新已打开的 ChatGPT 标签页。刷新前确认输入框没有未发送草稿。

### 3. 为 Codex 任务启动 bridge

每个要连接的 Codex 任务单独开一个 PowerShell 终端，在仓库目录运行：

```powershell
python .\bridge.py
```

在任务列表中输入目标任务的序号。bridge 启动后会显示一行 `端口|令牌` 连接信息；保持该终端运行。默认端口 `8765` 被占用时会自动选择空闲端口。

### 4. 绑定 ChatGPT 标签页并开始

1. 在 Edge 切换到目标 ChatGPT 会话，点击扩展图标。
2. 未绑定时，在“连接配置”里只需填写对应终端输出的 `端口|令牌`，点击“绑定当前 ChatGPT 标签页”。
3. 在“选择起点”中选 A 或 B，点击“开始”。

- **A · 网页现有指令卡片**：从当前 ChatGPT 会话里最新的“给 Codex 的指令”卡片开始。
- **B · Codex 最新最终报告**：将所选 Codex 任务最近一轮已完成的最终报告发给 ChatGPT，再继续自动循环。

标题和 CSS 选择器是可选的旧版卡片识别覆盖配置，不是连接必需项；新连接使用内置识别规则。已保存的旧连接仍会沿用其标题或选择器配置。

需要管理多个任务时，为每项任务各运行一个 `bridge.py`，再把各自的连接信息绑定到不同 ChatGPT 标签页。popup 的任务列表可切换标签页或单独解除绑定。关闭 ChatGPT 标签页会自动解除该标签页的扩展绑定，不会关闭对应 bridge 进程。

## popup 工作流和操作

| 当前状态 | popup 显示 |
| --- | --- |
| 未连接或当前标签页未绑定 | 连接配置 |
| 已连接，phase 为 `setup` 或 `stopped` | A/B 起点选择和“开始” |
| phase 为 `await_instruction`、`codex_running` 或 `report_ready` | 当前任务和“结束当前流程” |

报告恢复控件只会在存在待处理报告时显示，并位于“更多操作”中。长对话加速始终是独立区域；日志和“查看卡片”等低频操作也位于“更多操作”。

长对话加速区域包括：

- **启用**：默认开启。
- **最近 N 轮**：默认 10，范围 1–500。
- **实时滑动窗口**：将页面中保留的消息窗口维持在最近轮次附近。
- **屏幕外渲染优化**：减少屏幕外消息的渲染开销。
- **应用并刷新**：保存设置、应用到当前 ChatGPT 页面并刷新。

优化器不会删除 ChatGPT 服务端历史；它限制首次请求，并阻止扩展尝试加载更早的分页历史。设置只在 ChatGPT 页面启用该扩展时生效。

## 操作记录和常见事项

每次启动 bridge 都会在仓库 `logs/` 下创建独立 JSONL 日志，按任务标题和启动时间命名。popup 的“查看最近操作记录”查看当前绑定任务最近的记录；日志记录阶段、长度和错误类别，不记录令牌或指令/报告正文。

按“结束当前流程”会停止后续自动识别和报告回传，但不会取消已运行的 Codex。等待该 Codex 任务完成后，popup 会允许再次选择起点。若要关闭 bridge 进程，在对应终端按 `Ctrl+C`；重新启动后按终端显示的新连接信息重新绑定。

报告发送状态不确定时，可在“更多操作”中使用报告恢复控件。先检查 ChatGPT 会话中是否已收到报告，再选择重新检查、确认已发送或重试发送，避免重复消息。

## 开发测试

在仓库根目录运行完整测试：

```powershell
python -m unittest -q
node test_card.js
node test_popup.js
node test_log.js
node test_optimizer.js
```

检查扩展 JavaScript 语法：

```powershell
Get-ChildItem .\extension -Filter *.js | ForEach-Object { node --check $_.FullName }
```
