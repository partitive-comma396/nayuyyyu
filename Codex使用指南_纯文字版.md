# Codex 使用指南（纯文字版）

> 原文档最后修改日期：3月2日  
> 转换说明：本文档由原始飞书云文档PDF（含大量截图）转换为纯文字格式，所有截图中的标注信息均已用文字描述替代。

---

## 目录

- 一、VSCode 插件使用
  - 1、安装插件
  - 2、登陆
  - 3、相关功能
- 二、CLI 使用
  - 1、安装 Codex
  - 2、登陆 Codex
  - 3、使用
- 三、OpenCode
  - 桌面版
  - CLI
- 四、OpenClaw（待更新）
- 五、查看额度

---

## 一、VSCode 插件使用

### 1、安装插件

在 VSCode 的扩展商店中搜索 `codex`，找到由 **OpenAI** 发布的插件 **"Codex – OpenAI's coding agent"**（注意认准发布者为 OpenAI）。

**插件基本信息：**
- 标识符：`openai.chatgpt`
- 版本：0.4.79
- 大小：117.55 MB
- 类别：AI、Chat

**插件功能说明：**
- **Pair with Codex**：在 VS Code 中以侧面板形式添加 Codex，可以聊天、编辑和预览代码更改。支持从打开的文件和选中的代码获取上下文，提示越短越精确，结果越快越相关。建议将 Codex 面板移动到编辑器右侧使用。
- **Delegate to Codex in the cloud**：将较大的任务委托给云端的 Codex，可以在不离开 IDE 的情况下跟踪进度和查看结果。对于最后的修改，在本地打开云端任务，Codex 会保持上下文一致。
- **Sign in with your ChatGPT account**：Codex 支持 Plus、Pro、Business、Edu 和 Enterprise ChatGPT 计划。

**安装步骤：**
1. 点击插件进行安装
2. 安装插件后**重启 VSCode**

安装完成后，点击 VSCode 右上角的 Codex 小图标，会弹出右侧的 Codex 窗口（包含"聊天"和"CODEX"两个标签页），可以在这里和 ChatGPT 聊天对话。

### 2、登陆

在 Codex 面板中，你会看到两个登陆选项：
- **通过 ChatGPT 登录**
- **使用 API 密钥**（已通过 API 密钥即可运行任务）

**登陆步骤：**
1. 点击"通过 ChatGPT 登录"按钮
2. 输入邮箱和密码进行登陆（支持邮箱密码登录，也支持 Google、Apple、Microsoft、手机号等方式登录）
3. **关键步骤：选择工作空间时，不要选个人空间！** 要选择刚刚邀请你进入的工作空间（注意：不是你的个人空间，是你在工作空间网站拉的工作空间）
4. 显示 "Signed in to Codex - You may now close this page" 页面代表登陆成功，返回 VSCode 中进行下一步操作
5. 登陆后返回 VSCode 会显示当前页面，代表登陆成功了，点击 "Next" 一路点下去即可

### 3、相关功能

**设置与账号管理：**

点击 Codex 面板右上角的齿轮图标，可以看到以下选项：
- **Codex settings**：Codex 相关设置
- **IDE settings**：IDE 设置
- **MCP settings**：MCP 设置
- **Skills settings**：Skill 相关设置（如需使用可以参考网上教程）
- **Keyboard shortcuts**：快捷键设置
- **Log out**：退出账号

> 提示：如果额度不够用，可以在这里退出登陆，重新登陆时选择另外的工作空间就好了。

**选择模型：**

在 Codex 面板底部，可以选择要使用的模型。可用模型包括：
- GPT-5.3-Codex（当前默认，最新的前沿 agentic 编码模型）
- GPT-5.2-Codex
- GPT-5.1-Codex-Max
- GPT-5.2
- GPT-5.1-Codex-Mini

**选择推理模式：**

在模型选择旁边，可以选择推理功能等级：
- **低** (Low)
- **中** (Medium)（默认）
- **高** (High)
- **超高** (Extra High)

> ⚠️ 注意：越高的推理模式对于额度的消耗越高。

**查看剩余额度：**

点击 Codex 面板底部左下角的图标，可以查看额度信息，包括：
- 继续使用：本地项目
- 剩余额度：
  - 5 小时额度：显示百分比和重置时间（如 100%，20:06 重置）
  - 1 周额度：显示百分比和重置日期（如 100%，3月7日重置）

> ⚠️ 注意：VSCode 插件中的额度和网页版中的额度是独立的。

---

## 二、CLI 使用

### 1、安装 Codex

#### macOS / Linux

**方法一：Homebrew 安装**

打开终端，执行以下命令：

```bash
# 更新 Homebrew
brew update

# 安装 Codex CLI
brew install codex

# 验证安装（出现版本号说明安装成功）
codex --version
```

执行 `brew update` 后，Homebrew 会更新本地仓库信息，然后执行 `brew install codex` 进行安装。安装完成后，运行 `codex --version` 查看版本号（如 `codex-cli 0.106.0`），出现版本号说明安装成功。

**方法二：npm 安装**

首先检查电脑上是否安装了 Node.js：

```bash
node -v
```

如果出现 `zsh: command not found: node`，说明没有安装 Node.js。

**安装 Node.js：**

可以使用 brew 安装 Node.js：

```bash
brew install node
```

没安装 brew 的可以先安装 brew，也可以到 Node.js 官网安装。Node.js 安装教程可参考：  
https://www.runoob.com/nodejs/nodejs-install-setup.html

安装后再次检查 Node.js 版本：

```bash
node -v
```

出现版本号（如 `v25.6.1`）说明安装成功。

**安装 Codex CLI：**

```bash
npm install -g @openai/codex
```

**查看是否安装成功：**

```bash
which codex
codex --version
```

如果 `which codex` 返回路径（如 `/opt/homebrew/bin/codex`），并且 `codex --version` 返回版本号（如 `codex-cli 0.106.0`），说明安装成功。

#### Windows

1. 先在 Windows 上安装 Node.js，参考：https://zhuanlan.zhihu.com/p/442215189
2. 安装完后在终端（cmd 或 PowerShell）中查看是否已经安装了 Node.js：
   ```
   node -v
   ```
   应显示版本号，如 `v24.12.0`

3. 安装 Codex：
   ```
   npm install -g @openai/codex
   ```

4. 检查 Codex 是否安装成功：
   ```
   codex --version
   ```
   应显示版本号，如 `codex-cli 0.106.0`

### 2、登陆 Codex

在终端输入 `codex` 启动 Codex：

```bash
codex
```

启动后会显示 Codex 的 ASCII 艺术 Logo，以及欢迎信息：

```
Welcome to Codex, OpenAI's command-line coding agent

Sign in with ChatGPT to use Codex as part of your paid plan
or connect an API key for usage-based billing
```

显示三个登陆选项：
1. **Sign in with ChatGPT** — Usage included with Plus, Pro, Team, and Enterprise plans（**选择这个**）
2. **Sign in with Device Code** — Sign in from another device with a one-time code
3. **Provide your own API key** — Pay for what you use

选择第 1 项 "Sign in with ChatGPT"，回车后会自动跳转到网页进行登陆。

**网页登陆步骤：**
1. 输入邮箱和密码进行登陆
2. 选择邀请你进入的工作空间登陆（这一步和上面的 VSCode 插件使用登陆的步骤是一样的）
3. 选择后点击下面的 "Continue"

登陆成功后，终端会显示：

```
✔ Signed in with your ChatGPT account

  Before you start:

  Decide how much autonomy you want to grant Codex
  For more details see the Codex docs

  Codex can make mistakes
  Review the code it writes and commands it runs

  Powered by your ChatGPT account
  Uses your plan's rate limits and training data preferences

  Press Enter to continue
```

按回车进入下一步。

### 3、使用

进入 Codex 后，会显示当前版本和模型信息：

```
>_ OpenAI Codex (v0.106.0)

model:     gpt-5.3-codex medium   /model to change
directory: ~

Tip: Run /review to get a code review of your current changes.

> [在此输入指令]

gpt-5.3-codex medium · 100% left · ~
```

**输入 `/` 可以查看有哪些命令可以使用：**

| 命令 | 功能 |
|------|------|
| `/model` | 选择使用什么模型和推理等级 |
| `/permissions` | 选择 Codex 被允许做什么 |
| `/experimental` | 切换实验性功能 |
| `/skills` | 使用 Skills 来改进 Codex 执行特定任务的方式 |
| `/review` | 审查当前更改并发现问题 |
| `/rename` | 重命名当前线程 |
| `/new` | 在对话中开始新聊天 |
| `/resume` | 恢复已保存的聊天 |

**`/model` — 选择模型和推理等级：**

输入 `/model` 后回车，可以选择模型：

```
Select Model and Effort
Access legacy models by running codex -m <model_name> or in your config.toml

> 1. gpt-5.3-codex (current)   Latest frontier agentic coding model.
  2. gpt-5.2-codex              Frontier agentic coding model.
  3. gpt-5.1-codex-max          Codex-optimized flagship for deep and fast reasoning.
  4. gpt-5.2                    Latest frontier model with improvements across
                                 knowledge, reasoning and coding
  5. gpt-5.1-codex-mini         Optimized for codex. Cheaper, faster, but less capable.
```

选择模型后，还可以选择推理等级：

```
Select Reasoning Level for gpt-5.3-codex

  1. Low                         Fast responses with lighter reasoning
> 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks
  3. High                        Greater reasoning depth for complex problems
  4. Extra high                  Extra high reasoning depth for complex problems
```

**`/status` — 查看当前用户信息：**

输入 `/status` 后，可以看到：

```
Visit https://chatgpt.com/codex/settings/usage for up-to-date
information on rate limits and credits

  Model:              gpt-5.3-codex (reasoning xhigh, summaries auto)
  Directory:          ~
  Permissions:        Custom (workspace-write, untrusted)
  Agents.md:          <none>
  Account:            xxxxxxxxx (Team)
  Collaboration mode: Default
  Session:            xxxxxxxxxxxxxxxx

  5h limit:           [████████████████] 100% left (resets 20:06)
  Weekly limit:       [████████████████] 100% left
                      (resets 15:06 on 7 Mar)
```

**基本使用：**

在 `>` 后面输入你的指令即可使用。例如输入"你好你是谁"，Codex 会回复：

```
● 我是 Codex，你的编程助手。
  我可以帮你看代码、改 bug、写功能、跑命令、做代码评审。
```

一些常用的命令可以问一下 AI，其他进阶使用方法自己可以借助 AI 的帮助慢慢摸索。

---

## 三、OpenCode

### 桌面版

#### 1、安装 OpenCode

访问 OpenCode 官网下载：https://opencode.ai/download

页面提供以下下载选项：

**[1] OpenCode Terminal（命令行版）：**
- `curl -fsSL https://opencode.ai/install | bash`
- `npm i -g opencode-ai`
- `bun add -g opencode-ai`
- `brew install anomalyco/tap/opencode`
- `paru -S opencode`（Arch Linux）

**[2] OpenCode Desktop (Beta)（桌面版）：**
- `brew install --cask opencode-desktop`
- macOS (Apple Silicon) — Download
- macOS (Intel) — Download
- Windows (x64) — Download

> 选择自己电脑对应的型号下载即可。

#### 2、使用

打开 OpenCode 桌面版后，会看到主界面：
- 显示 "opencode" Logo
- 显示 "Local Server" 连接状态
- 左侧显示"最近项目"列表
- 右侧有"打开项目"和"创建项目"按钮

**设置模型提供商：**

1. 点击左下角选择模型提供商
2. 在"连接提供商"弹窗中，可以看到以下选项：
   - **热门**：OpenCode Zen（推荐）、Anthropic、GitHub Copilot、**OpenAI**、Google、OpenRouter、Vercel AI Gateway
   - **其他**：自定义、302.AI
3. 选择 **OpenAI**（使用 ChatGPT Pro/Plus 或 API 密钥连接）
4. 在"连接 OpenAI"弹窗中，选择 OpenAI 的登录方式：
   - **ChatGPT Pro/Plus (browser)**（**选择这个**）
   - ChatGPT Pro/Plus (headless)
   - API 密钥

**登陆步骤：**

和之前 VSCode 插件、CLI 使用的登陆步骤一样：
1. 输入邮箱和密码
2. 选择对应的工作空间
3. 点击 "Continue"

登陆成功后，右下角会弹出提示："OpenAI 已连接 - 现在可以使用 OpenAI 模型了。"

**选择模型：**

在对话界面左下角，可以选择模型：
- OpenCode Zen
- Trinity Large Preview（免费）
- **OpenAI 分类下**：
  - GPT-5.2
  - GPT-5.3 Codex
  - GPT-5.3 Codex Spark

选择模型后即可在左侧聊天窗口中对话使用。

### CLI 版

#### macOS

建议使用 npm 安装（npm 安装参考上面二、CLI 使用中的教程）：

```bash
npm install -g opencode-ai
```

**查看是否安装成功：**

```bash
which opencode
opencode -v
```

`which opencode` 应返回路径（如 `/opt/homebrew/bin/opencode`），`opencode -v` 应返回版本号（如 `1.2.15`）。

**启动 OpenCode：**

```bash
opencode
```

输入后进入 OpenCode 的终端界面（TUI），显示 "opencode" ASCII 艺术 Logo，底部显示：

```
Ask anything... "Fix broken tests"

Build  GPT-5.3 Codex Spark  OpenAI

               ctrl+t variants  tab agents  ctrl+p commands
```

#### Windows

安装可以使用 npm 安装比较方便，npm 的安装参考上面 CLI 中的教程：

```
npm install -g opencode-ai
```

**查看是否安装成功：**

```
opencode -v
```

应显示版本号，如 `1.2.15`。

**启动 OpenCode：**

```
opencode
```

进入 OpenCode 终端界面后：

**连接提供商：**
1. 按 `Ctrl + P` 进入 Commands 菜单
2. 用上下箭头选择最后一项 **"Connect provider"**
3. 在 "Connect a provider" 列表中，选择 **"OpenAI (ChatGPT Plus/Pro or API key)"**
4. 在 "Select auth method" 中选择 **"ChatGPT Pro/Plus (browser)"**（选择浏览器登陆）
5. 然后进行登陆就可以愉快地使用了

**Commands 菜单完整列表：**

| 命令 | 快捷键 |
|------|--------|
| Switch theme | ctrl+x t |
| Toggle appearance | |
| Help | |
| Open docs | |
| Exit the app | |
| Toggle debug panel | |
| Toggle console | |
| Write heap snapshot | |
| Disable terminal title | |
| Disable animations | |
| Disable diff wrapping | |
| **Agent** | |
| Switch model | ctrl+x m |
| Switch agent | ctrl+x a |
| Toggle MCPs | |
| **Provider** | |
| Connect provider | |

更详细的教程参考：  
https://www.runoob.com/ai-agent/opencode-coding-agent.html

---

## 四、OpenClaw

待更新.......

---

## 五、查看额度

访问下面网站查询 Codex 额度：  
**https://chatgpt.com/codex/settings/usage**

打开后需要登陆 ChatGPT 账号（和前面登陆方式一致，支持邮箱密码、Google、Apple、Microsoft、手机号登录），登陆后即可查看 Codex 的使用额度和剩余情况。

---

> **重要提醒汇总：**
> 1. 登陆时**选择工作空间，不要选个人空间**
> 2. **越高的推理模式，额度消耗越高**
> 3. **VSCode 插件中的额度和网页版中的额度是独立的**
> 4. 额度不够用时，可以退出登陆，重新登陆选择另外的工作空间
> 5. 有问题可以在原文档底部全文评论留言
