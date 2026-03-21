# Codex API Manager（nayuyyyu）

## 项目简介

**nayuyyyu** 是一套在本地运行的 **Codex API 管理器**：把 ChatGPT Team 账号下的 Codex 用量，通过反向代理聚合成 **OpenAI 兼容的 HTTP API**（`/v1`），让你用熟悉的客户端（Codex 桌面版、CLI、OpenClaw、任意 OpenAI SDK）统一调用。

**核心能力概览**

| 能力 | 说明 |
|------|------|
| OpenAI 兼容 API | 提供 `/v1/responses`、`/v1/chat/completions` 等，Base URL 指向本地反代即可 |
| 多账号轮转 | 多账号 round-robin，额度与容错叠加 |
| Web 控制面板 | 浏览器里管理账号池、卡密、额度检测、API Key |
| 自动化流水线 | Playwright 驱动注册、激活、提 Token、质保等（见 `automation/`） |
| Token 维护 | 定时检查并续期，减少手工登录 |

**技术栈**：Node.js（控制面板与调度）、Python FastAPI（反代）、Playwright（浏览器自动化）。适用于 **macOS**，需本机安装 Node、Python 3.11+ 等（见下文环境要求）。

**仓库与克隆**：若在 GitHub 上浏览本仓库，请使用页面上的 **Code** 按钮复制克隆地址；不同 fork/镜像下的「所有者/组织名」可能不同，以你实际打开的仓库为准。若你已在 GitHub 上转移仓库或改用 fork，可在本机执行 `git remote set-url origin <新地址>`，使本地 `git remote -v` 与目标仓库一致。

对外只需一个 API Key，即可配合 **Codex 桌面版**、CLI、OpenClaw 及任意 OpenAI 兼容客户端使用。

---

## 快速开始

```bash
# 1. 安装依赖（首次）
brew install node python3
pip3 install fastapi uvicorn httpx python-dotenv tiktoken

# 2. 双击启动
open 启动.command

# 3. 浏览器自动打开控制面板 → 输入卡密 → 全自动完成
```

启动后：
- **控制面板**：http://localhost:3001 （所有操作在这里点按钮完成）
- **API 地址**：http://localhost:9000/v1
- **API Key**：自动生成，控制面板里可查看/复制

---

## 用 Codex 桌面版 / CLI

### 方法一：环境变量（推荐）

已自动写入 `~/.zshrc` 和 `启动.command`，新终端窗口直接可用：

```bash
export OPENAI_API_KEY="你的Key"       # 控制面板里查看
export OPENAI_BASE_URL="http://localhost:9000/v1"
```

然后：
- **Codex CLI**：直接运行 `codex`
- **OpenClaw**：在配置里设 baseUrl 为 `http://localhost:9000/v1`

### 方法二：Codex 桌面版

Codex 桌面版通过上述环境变量自动识别反代。如果不生效，在 Codex 设置里手动填入 API Key 和 Base URL。

> **注意**：通过 API Key 方式接入时，Codex UI 里不会显示 Fast 模式按钮，但反代已在服务端强制开启（见下方配置说明）。

---

## 配置说明

### `proxy/.env` — 核心配置

```env
HOST=0.0.0.0              # 监听地址
PORT=9000                  # API 端口
KEY=sk-ZPhFC...            # API Key（首次启动自动生成）
REASONING_EFFORT=xhigh     # 默认推理深度：none / low / medium / high / xhigh
REASONING_SUMMARY=true     # 是否返回推理摘要
REASONING_COMPAT=think-tags
ACCOUNTS_DIR=../accounts
FAST_MODE=true             # Fast 模式开关（见下方说明）
```

#### API Key

- 所有客户端用这一个 Key 调用 API
- 首次启动自动生成长随机 Key（类似 `sk-ZPhFC21rWwq...`）
- 修改后重启生效，所有客户端需同步更新

#### Fast Mode（加速模式）

- `FAST_MODE=true`：开启，请求自动附带 `service_tier: "priority"`，速度 **+1.5×**，额度消耗 **×2**
- `FAST_MODE=false`：关闭，使用标准速度
- 此设置作用于服务端，与 Codex UI 里的 speed 选择器无关

#### Reasoning Effort（推理深度）

仅影响 `/v1/chat/completions` 端点的默认值。Codex 桌面版走 `/v1/responses` 端点，推理深度由 Codex UI 底部的下拉菜单控制，**不受此配置影响**。

| 值 | 速度 | 适用场景 |
|----|------|---------|
| `none` | 最快 | 简单问答 |
| `low` | 快 | 日常编码 |
| `medium` | 平衡 | 通用（默认） |
| `high` | 慢 | 复杂调试 |
| `xhigh` | 最慢 | 大型重构、安全审计 |

### `automation/config.json` — 浏览器自动化

```json
{
  "headless": false,       // false=弹窗可见, true=后台运行
  "slow_mo": 1200,         // 每步延迟(ms)，太快会被检测
  "password": "ChangeYourPassword123!",  // 注册账号统一密码
  "proxy": null            // HTTP 代理（如 "http://US代理IP:端口"）
}
```

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/responses` | POST | **Responses API**（Codex 桌面版使用，3 次重试 + 账号轮换） |
| `/v1/responses/{id}/cancel` | POST | 取消正在进行的响应 |
| `/v1/chat/completions` | POST | Chat Completions API |
| `/v1/completions` | POST | Text Completions API |
| `/v1/models` | GET | 可用模型列表 |
| `/v1/accounts` | GET | 已加载账户状态 |
| `/v1/admin/check-drop` | POST | 检测账号是否掉车 |
| `/v1/admin/quota` | GET | 账号基本信息 |
| `/health` | GET | 健康检查 |

### 支持的模型

`gpt-5.4`、`gpt-5`、`gpt-5-codex`、`gpt-4.1`、`gpt-4.1-mini`、`gpt-4.1-nano`、`gpt-4o`、`gpt-4o-mini`、`o3`、`o3-mini`、`o4-mini`、`gpt-4`、`gpt-3.5-turbo`

编辑 `proxy/models.json` 可增减。

---

## Web 控制面板功能

双击 `启动.command` 后自动打开 http://localhost:3001：

- **账户池总览**：邮箱、密码（脱敏）、状态、Plan 类型、卡密、绑定日期、剩余天数
- **输入卡密**：粘贴卡密自动执行注册→激活→提 Token 全流程
- **实时检测所有账号状态**：调 gpt-5.4 验证每个账号是否可用
- **一键质保掉车账号**：自动用绑定的卡密重新激活掉车账号
- **剩余额度检测**：通过 Playwright 浏览器登录抓取 5h/周额度
- **绑定日期同步**：查询卡密绑定时间和到期状态
- **API Key 展示/复制**

---

## 自动化机制

### Token 自动续期

- 每 **6 小时**自动检查所有 active 账号的 token 有效期
- 剩余不足 **48 小时**时，自动用存储的邮箱密码重新登录提取新 token
- 续期完成后自动重启反代加载新 token
- Token 有效期约 10 天

### 多账户轮转

- 启动时扫描 `accounts/*.json` 加载所有有效账户
- 每次请求 **round-robin** 切换到下一个健康账户
- 连续 3 次失败标记为不健康，自动跳过
- 所有账户不健康时重置重试
- 效果：**N 个 active 账号 = N 倍额度**

### 端口冲突自动处理

如果 dashboard 端口 3001 被占用，自动释放并重试，不会崩溃。

---

## 项目结构

```
codex-api-manager/
├── 启动.command              # macOS 双击启动（自动设环境变量）
├── app.js                    # 主程序（反代 + Dashboard + Token 续期）
├── dashboard.html            # Web 控制面板
├── manage.py                 # CLI 管理工具
├── account_pool.py           # 账户池管理
│
├── accounts/                 # 账户数据
│   ├── pool.json             # 账户池（邮箱、密码、状态、卡密）
│   └── <label>.json          # 各账户 auth token
│
├── automation/               # Playwright 浏览器自动化
│   ├── pipeline.js           # 一键流水线：注册→激活→提 token
│   ├── add_account.js        # 登录提取 token
│   ├── activate_account.js   # 卡密激活/质保
│   ├── check_quota.js        # 额度检测（浏览器方式）
│   ├── chatgpt_account_creator.js  # 注册新账号
│   └── anti-detect.js        # 反检测（指纹/延迟/隐身）
│
└── proxy/                    # OpenAI 兼容反代（FastAPI）
    ├── .env                  # 配置文件
    ├── models.json           # 模型列表
    └── codex2api/
        ├── server.py         # 路由（/v1/responses, /v1/chat/completions 等）
        ├── request.py        # 请求转发（→ ChatGPT 后端）
        └── multi_auth.py     # 多账户轮转
```

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│  Codex 桌面版 / CLI / OpenClaw / 任意 OpenAI 客户端  │
│       OPENAI_BASE_URL = http://localhost:9000/v1     │
│       OPENAI_API_KEY  = sk-ZPhFC...                  │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│             反代 (FastAPI @ :9000)                    │
│                                                      │
│  /v1/responses     ← Codex 桌面版（SSE 直接透传）     │
│  /v1/chat/completions ← 其他客户端（格式转换）        │
│                                                      │
│  ┌──────────────────────────────────────────┐        │
│  │  MultiAccountManager (round-robin)       │        │
│  │  账号A ──→ 账号B ──→ 账号C ──→ 账号A ... │        │
│  └──────────────────────────────────────────┘        │
│                                                      │
│  功能: 重试(3次) · 账号轮换 · Fast mode · 错误恢复    │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
         ChatGPT Responses API (upstream)
         chatgpt.com/backend-api/codex/responses
```

**两条路径**：
- **Codex 桌面版** → `/v1/responses` → SSE 事件直接透传（零转换损耗）
- **其他客户端** → `/v1/chat/completions` → 反代做格式转换

---

## CLI 管理命令

```bash
cd ~/Desktop/codex-api-manager

python manage.py help              # 帮助
python manage.py status            # 总览
python manage.py pool              # 查看账户池

python manage.py go ZB-XXXXXXXX    # 一键：注册→激活→提token
python manage.py check-drop        # 检测掉车并自动质保
python manage.py proxy             # 单独启动反代

python manage.py register          # 仅注册新号
python manage.py add email pass    # 仅提取 token
python manage.py activate warranty ZB-XXX  # 手动质保
```

---

## API 使用示例

```bash
# 用控制面板里的 API Key 替换 sk-YOUR_KEY
curl http://localhost:9000/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-YOUR_KEY",
    base_url="http://localhost:9000/v1",
)
resp = client.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

---

## 故障排查

| 问题 | 解决 |
|------|------|
| `ModuleNotFoundError: fastapi` | `pip3 install fastapi uvicorn httpx python-dotenv` |
| `Address already in use` | 重启程序会自动释放端口 |
| 注册遇到 CAPTCHA | 在 `automation/config.json` 设 `proxy` 使用美国 IP |
| Token 过期（10 天后）| 程序每 6h 自动检查并续期，无需手动 |
| Codex 桌面版 404 | 确保反代在运行，且环境变量正确 |
| Codex 显示 reconnecting | 反代可能挂了，检查终端日志 |
| 反代返回 401 | 检查 API Key 是否与 `proxy/.env` 的 `KEY` 一致 |
| 账号掉车 | 控制面板点"一键质保"，或 `python manage.py check-drop` |

---

## 安全注意事项

- `accounts/` 目录含敏感 token，**不要提交到 Git**
- `proxy/.env` 的 `KEY` 是 API 凭证，不要泄露
- `pool.json` 含明文密码，不要共享
- 仅供个人使用

---

## 环境要求

| 依赖 | 最低版本 | 安装 |
|------|---------|------|
| macOS | 12+ | — |
| Node.js | 18+ | `brew install node` |
| Python | 3.11+ | `brew install python@3.13` |
| Firefox | 自动安装 | Playwright 管理 |

Python 包：`pip3 install fastapi uvicorn httpx python-dotenv tiktoken`

Node 依赖首次运行自动安装。
