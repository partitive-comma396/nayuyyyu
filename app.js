#!/usr/bin/env node
/**
 * Codex API Manager — 双击启动，打开网页控制面板
 *
 * 启动反代 + Web 控制面板，所有操作在浏览器中点按钮完成。
 *
 * Usage: node app.js
 */

import { execFileSync, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_DIR = path.join(__dirname, 'automation');
const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
const PROXY_DIR = path.join(__dirname, 'proxy');
const ROOT = __dirname;

const CARD_KEY_PATTERN = /^[A-Z0-9]+-[A-Z0-9]{6,}$/;
const DEFAULT_ACTIVATION_URL = 'team.654301.xyz';
const API_KEY = loadApiKey();
const PROXY_PORT = 18923;
const DASHBOARD_PORT = 18924;

let proxyProcess = null;
let isProcessing = false;
let proxyRestartCount = 0;
const PROXY_RESTART_MAX = 8;

/** 释放本机占用端口的旧进程（常见原因：上次反代未退出、重复启动 app.js） */
function freePort(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pids = out.trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    if (pids.length) {
      log(`🔧 端口 ${port} 已被占用，已尝试结束旧进程 (${pids.join(', ')})`);
      try {
        execSync('sleep 1', { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 无占用或 lsof 不可用 */
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function emailToLabel(email) {
  if (!email || !email.includes('@')) return (email || '').replace(/\s/g, '_');
  return email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
}

function loadPool() {
  try {
    const p = path.join(ACCOUNTS_DIR, 'pool.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8') || '[]');
  } catch { return []; }
}

function loadApiKey() {
  try {
    const envPath = path.join(ROOT, 'proxy', '.env');
    const text = fs.readFileSync(envPath, 'utf-8') || '';
    const m = text.match(/KEY\s*=\s*(\S+)/);
    return m ? m[1].trim() : 'sk-test';
  } catch { return 'sk-test'; }
}

async function fetchProxyHealth() {
  try {
    const res = await fetch(`http://localhost:${PROXY_PORT}/v1/accounts`, {
      headers: { Authorization: `Bearer ${loadApiKey()}` },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const map = {};
    for (const a of data.accounts || []) {
      const em = (a.email || '').toLowerCase();
      map[em] = {
        healthy: a.healthy === true,
        quota_reset_at: a.quota_reset_at || null,
      };
    }
    return map;
  } catch { return {}; }
}

function readJwtPlan(email) {
  try {
    const label = emailToLabel(email);
    const authPath = path.join(ACCOUNTS_DIR, `${label}.json`);
    if (!fs.existsSync(authPath)) return null;
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const token = auth.tokens?.access_token;
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload['https://api.openai.com/auth']?.chatgpt_plan_type || null;
  } catch { return null; }
}

async function getApiPoolData() {
  const pool = loadPool();
  const proxyHealthy = await fetchProxyHealth();
  const CARD_LIFEDAYS = 25;
  const now = Date.now();
  const dayMs = 86400000;

  let active = 0, pending = 0, dropped = 0, expiring = 0, teamCount = 0, freeCount = 0;
  const expiringList = [];

  const enriched = pool.map((a) => {
    const label = emailToLabel(a.email);
    const hasToken = fs.existsSync(path.join(ACCOUNTS_DIR, `${label}.json`));
    const jwtPlan = readJwtPlan(a.email);

    // 用 JWT plan_type 作为状态的真实来源
    let effectiveStatus = a.status || '';
    if (jwtPlan) {
      if (['team', 'business', 'enterprise', 'edu', 'pro', 'plus', 'gopro'].includes(jwtPlan)) {
        effectiveStatus = 'active';
      } else if (jwtPlan === 'free') {
        // free 账号：只有「曾经是 team 现在变 free」才是掉车；无卡密不可能是已激活 → 代激活
        const wasTeam = ['team', 'business', 'enterprise', 'pro', 'plus', 'gopro', 'edu'].includes((a.plan || '').toLowerCase());
        effectiveStatus = (a.status === 'active' && wasTeam) ? '掉车' : 'pending_invite';
      }
    }

    // 从代理实时状态获取额度恢复时间（不用 healthy 判断掉车，避免误判）
    const em = (a.email || '').toLowerCase();
    const proxyInfo = proxyHealthy[em] || {};
    const quota_reset_at = proxyInfo.quota_reset_at || null;

    const planType = jwtPlan || a.plan || '';
    if (['team', 'business', 'enterprise', 'pro', 'plus', 'gopro', 'edu'].includes(planType)) teamCount++;
    else if (planType === 'free') freeCount++;

    const s = effectiveStatus;
    if (s === 'active') active++;
    else if (s === 'pending_invite') pending++;
    else dropped++;

    let days_remaining = null;
    const bindDate = a.card_bind_date;
    if (bindDate) {
      const bindMs = new Date(bindDate).getTime();
      const elapsed = Math.floor((now - bindMs) / dayMs);
      days_remaining = Math.max(0, CARD_LIFEDAYS - elapsed);
      if (days_remaining <= 7 && days_remaining >= 0) {
        expiring++;
        expiringList.push({ email: a.email, days_remaining });
      }
    }

    return {
      ...a,
      status: s,
      plan: jwtPlan || a.plan || '',
      days_remaining,
      has_token: hasToken,
      quota_reset_at,
    };
  });

  return {
    pool: enriched,
    summary: {
      total: pool.length,
      active,
      pending,
      dropped,
      expiring,
      team: teamCount,
      free: freeCount,
    },
    expiringList,
    apiKey: loadApiKey(),
    apiUrl: `http://localhost:${PROXY_PORT}/v1`,
  };
}

// ─── npm check ────────────────────────────────────────────────────────

function ensureDeps() {
  if (!fs.existsSync(path.join(AUTOMATION_DIR, 'node_modules'))) {
    log('📦 首次运行，安装依赖...');
    execFileSync('npm', ['install'], { cwd: AUTOMATION_DIR, stdio: 'inherit' });
    log('📦 安装浏览器...');
    execFileSync('npx', ['playwright', 'install', 'firefox'], { cwd: AUTOMATION_DIR, stdio: 'inherit' });
  }
}

// ─── Proxy ────────────────────────────────────────────────────────────

function startProxy() {
  if (proxyProcess) return;

  if (proxyRestartCount >= PROXY_RESTART_MAX) {
    log(`❌ 反代连续失败 ${PROXY_RESTART_MAX} 次，已停止自动重启。请检查：端口 ${PROXY_PORT} 是否被占用、proxy/.env 是否正确、python3 依赖是否完整。`);
    return;
  }

  freePort(PROXY_PORT);

  log('🚀 启动反代服务...');
  let stderrBuf = '';
  proxyProcess = spawn('python3', ['-m', 'codex2api'], {
    cwd: PROXY_DIR,
    env: { ...process.env, ACCOUNTS_DIR, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proxyProcess.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line.includes('Uvicorn running')) {
      proxyRestartCount = 0;
      log(`🟢 反代已启动 → http://localhost:${PROXY_PORT}`);
    }
  });

  proxyProcess.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
  });

  proxyProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      proxyRestartCount += 1;
      const hint = stderrBuf.includes('address already in use') || stderrBuf.includes('Errno 48')
        ? '（原因很可能是端口仍被占用，已尝试释放；若仍失败请终端执行: lsof -i :' + PROXY_PORT + '）'
        : '';
      const tail = stderrBuf.trim().split('\n').slice(-5).join(' ').slice(0, 400);
      if (tail) log(`⚠️ 反代错误输出: ${tail}`);
      log(`⚠️ 反代退出 (code ${code})${hint}，3秒后重试 (${proxyRestartCount}/${PROXY_RESTART_MAX})...`);
      proxyProcess = null;
      setTimeout(startProxy, 3000);
    } else {
      proxyProcess = null;
    }
  });
}

function restartProxy() {
  proxyRestartCount = 0;
  if (proxyProcess) {
    log('🔄 重启反代以加载新账户...');
    proxyProcess.kill();
    proxyProcess = null;
    setTimeout(startProxy, 2000);
  } else {
    startProxy();
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────

async function runPipeline(cardKey, activationUrl) {
  if (isProcessing) {
    return { ok: false, error: '上一个任务还在进行中' };
  }

  isProcessing = true;

  return new Promise((resolve) => {
    const pipelineScript = path.join(AUTOMATION_DIR, 'pipeline.js');
    const child = spawn('node', [pipelineScript, cardKey, activationUrl || DEFAULT_ACTIVATION_URL], {
      cwd: AUTOMATION_DIR,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
    });

    child.on('exit', (code) => {
      isProcessing = false;
      if (code === 0) {
        restartProxy();
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: '流水线执行失败，请查看终端日志' });
      }
    });
  });
}

async function runCardQuery(cardKey, activationUrl) {
  return new Promise((resolve) => {
    const child = spawn('node', [
      path.join(AUTOMATION_DIR, 'activate_account.js'),
      'query', cardKey, '', activationUrl || DEFAULT_ACTIVATION_URL,
    ], {
      cwd: AUTOMATION_DIR,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      let data = null;
      for (const line of (out || '').split('\n')) {
        const s = line.trim();
        if (s.startsWith('{')) {
          try { data = JSON.parse(s); } catch {}
          break;
        }
      }
      resolve(data || { error: '查询失败' });
    });
  });
}

async function runCheckQuota() {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(AUTOMATION_DIR, 'check_quota.js')], {
      cwd: AUTOMATION_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { process.stderr.write(d); });
    child.on('exit', (code) => {
      let data = { accounts: [], error: null };
      for (const line of (out || '').split('\n')) {
        const s = line.trim();
        if (s.startsWith('{')) {
          try {
            const j = JSON.parse(s);
            if (j.error) data.error = j.error;
            else if (j.accounts) data = j;
          } catch {}
          break;
        }
      }
      resolve(data);
    });
  });
}

let syncBindingRunning = false;

async function runSyncBinding() {
  if (syncBindingRunning) return { ok: true, msg: '同步已在进行' };
  const pool = loadPool();
  const toSync = pool.filter((a) => a.card_key && a.email);
  if (!toSync.length) return { ok: true, updated: 0 };

  syncBindingRunning = true;
  const poolPath = path.join(ACCOUNTS_DIR, 'pool.json');
  let updated = 0;
  try {
    let poolData = JSON.parse(fs.readFileSync(poolPath, 'utf-8') || '[]');
    const CARD_LIFEDAYS = 25;

    for (const acct of toSync) {
      const q = await runCardQuery(acct.card_key, DEFAULT_ACTIVATION_URL);
      if (!q) continue;
      const bindDate = q.card_bind_date || acct.card_bind_date;
      let days = q.days_remaining;
      if (days == null && bindDate) {
        const elapsed = Math.floor((Date.now() - new Date(bindDate).getTime()) / 86400000);
        days = Math.max(0, CARD_LIFEDAYS - elapsed);
      }
      if (bindDate && !acct.card_bind_date) {
        for (const r of poolData) {
          if (r.email === acct.email) {
            r.card_bind_date = bindDate;
            updated++;
            break;
          }
        }
      }
      if (days !== null && days <= 0) {
        for (const r of poolData) {
          if (r.email === acct.email) {
            delete r.card_key;
            delete r.card_bind_date;
            updated++;
            log(`  ⏰ ${acct.email} 卡密已到期，已解绑`);
            break;
          }
        }
      }
    }
    if (updated > 0) fs.writeFileSync(poolPath, JSON.stringify(poolData, null, 2), 'utf-8');
  } finally {
    syncBindingRunning = false;
  }
  return { ok: true, updated };
}

async function runWarrantyDropped() {
  if (isProcessing) {
    return { ok: false, error: '其他任务进行中' };
  }
  return new Promise((resolve) => {
    const child = spawn('python3', ['manage.py', 'warranty-dropped'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); });
    child.on('exit', (code) => {
      const msg = out.trim() || (code === 0 ? '质保完成' : '质保失败');
      resolve({ ok: code === 0, msg });
    });
  });
}

async function runCheckDrop() {
  if (isProcessing) {
    return { ok: false, error: '其他任务进行中' };
  }

  return new Promise((resolve) => {
    const child = spawn('python3', ['manage.py', 'check-drop'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true, msg: '检测完成' });
      } else {
        resolve({ ok: false, error: '检测失败，请确保反代已启动' });
      }
    });
  });
}

// ─── HTTP Server (Dashboard) ───────────────────────────────────────────

function parseCardKey(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  let cardKey = '';
  let url = DEFAULT_ACTIVATION_URL;

  for (const line of lines) {
    const keyMatch = line.match(/卡密[：:]\s*([A-Z0-9]+-[A-Z0-9]+)/i);
    if (keyMatch) { cardKey = keyMatch[1]; continue; }

    const urlMatch = line.match(/激活网址[：:]\s*(\S+)/);
    if (urlMatch) { url = urlMatch[1].replace(/^https?:\/\//, ''); continue; }

    if (!cardKey && CARD_KEY_PATTERN.test(line)) cardKey = line;
  }

  return cardKey ? { cardKey, url } : null;
}

function killPort(port) {
  try {
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        const n = parseInt(pid, 10);
        if (n && n !== process.pid) {
          try { process.kill(n, 'SIGKILL'); } catch {}
        }
      }
    }
  } catch {}
}

function startDashboard() {
  const dashboardPath = path.join(ROOT, 'dashboard.html');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${DASHBOARD_PORT}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(dashboardPath, 'utf-8'));
      return;
    }

    if (url.pathname === '/api/pool') {
      const data = await getApiPoolData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/fast-mode' && req.method === 'GET') {
      const envPath = path.join(ROOT, 'proxy', '.env');
      const text = fs.readFileSync(envPath, 'utf-8');
      const m = text.match(/FAST_MODE\s*=\s*(\S+)/);
      const on = m ? ['true', '1', 'on'].includes(m[1].toLowerCase()) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fast_mode: on }));
      return;
    }

    if (url.pathname === '/api/fast-mode' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let input = {};
      try { input = JSON.parse(body || '{}'); } catch {}
      const on = !!input.enabled;
      const envPath = path.join(ROOT, 'proxy', '.env');
      let text = fs.readFileSync(envPath, 'utf-8');
      if (text.match(/FAST_MODE\s*=/)) {
        text = text.replace(/FAST_MODE\s*=\s*\S+/, `FAST_MODE=${on}`);
      } else {
        text = text.trimEnd() + `\nFAST_MODE=${on}\n`;
      }
      fs.writeFileSync(envPath, text, 'utf-8');
      log(`⚡ Fast Mode: ${on ? 'ON（2×额度消耗，1.5×速度）' : 'OFF（标准速度）'}`);
      restartProxy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, fast_mode: on }));
      return;
    }

    if (url.pathname === '/api/run-pipeline' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let input = {};
      try { input = JSON.parse(body || '{}'); } catch {}
      const cardKey = input.cardKey || '';
      const activationUrl = input.activationUrl || DEFAULT_ACTIVATION_URL;
      const parsed = parseCardKey(cardKey);
      const key = parsed ? parsed.cardKey : cardKey;

      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '无效卡密' }));
        return;
      }

      const result = await runPipeline(key, parsed ? parsed.url : activationUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === '/api/check-drop' && req.method === 'POST') {
      const result = await runCheckDrop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === '/api/warranty-dropped' && req.method === 'POST') {
      const result = await runWarrantyDropped();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === '/api/card-query' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let input = {};
      try { input = JSON.parse(body || '{}'); } catch {}
      const cardKey = (input.cardKey || '').trim();
      const activationUrl = (input.activationUrl || DEFAULT_ACTIVATION_URL).trim();
      if (!cardKey || !cardKey.includes('-')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '无效卡密' }));
        return;
      }
      const result = await runCardQuery(cardKey, activationUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: result }));
      return;
    }

    if (url.pathname === '/api/sync-binding' && req.method === 'POST') {
      runSyncBinding().then(() => {}).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: '同步已启动' }));
      return;
    }

    if (url.pathname === '/api/check-quota' && req.method === 'POST') {
      const result = await runCheckQuota();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    res.writeHead(404);
    res.end('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`⚠️ 端口 ${DASHBOARD_PORT} 被占用，正在释放...`);
      killPort(DASHBOARD_PORT);
      setTimeout(() => {
        server.listen(DASHBOARD_PORT, '127.0.0.1');
      }, 1500);
    } else {
      log(`❌ Dashboard 服务器错误: ${err.message}`);
    }
  });

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    log(`📱 控制面板 → http://localhost:${DASHBOARD_PORT}`);
    try {
      spawn('open', [`http://localhost:${DASHBOARD_PORT}`], { stdio: 'ignore' });
    } catch {}
  });
}

// ─── Token Auto-Refresh ──────────────────────────────────────────────

const TOKEN_REFRESH_INTERVAL = 6 * 3600 * 1000; // 6小时检查一次
const TOKEN_REFRESH_THRESHOLD = 48 * 3600;       // 剩余48小时内自动续期

function getTokenExpiry(email) {
  const label = emailToLabel(email);
  const authPath = path.join(ACCOUNTS_DIR, `${label}.json`);
  try {
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const token = data.tokens?.access_token;
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp || null;
  } catch { return null; }
}

let tokenRefreshing = false;

async function refreshAccountToken(email, password) {
  return new Promise((resolve) => {
    const label = emailToLabel(email);
    log(`  🔄 续期 ${email} ...`);
    const child = spawn('node', [
      path.join(AUTOMATION_DIR, 'add_account.js'), email, password, label,
    ], {
      cwd: AUTOMATION_DIR,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      if (code === 0) {
        log(`  ✅ ${email} token 已续期`);
        resolve(true);
      } else {
        log(`  ❌ ${email} 续期失败`);
        resolve(false);
      }
    });
    setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 120000);
  });
}

async function checkAndRefreshTokens() {
  if (tokenRefreshing) return;
  tokenRefreshing = true;
  const pool = loadPool();
  const now = Math.floor(Date.now() / 1000);
  let refreshed = 0;

  try {
    for (const acct of pool) {
      if (!acct.email || !acct.password) continue;
      if (acct.status !== 'active') continue;

      const exp = getTokenExpiry(acct.email);
      if (!exp) continue;

      const remaining = exp - now;
      if (remaining < TOKEN_REFRESH_THRESHOLD) {
        const hours = Math.max(0, remaining / 3600).toFixed(1);
        log(`⏰ ${acct.email} token 将在 ${hours}h 后过期，自动续期...`);
        const ok = await refreshAccountToken(acct.email, acct.password);
        if (ok) refreshed++;
      }
    }

    if (refreshed > 0) {
      log(`🔄 已续期 ${refreshed} 个账号，重启反代加载新 token...`);
      restartProxy();
    }
  } finally {
    tokenRefreshing = false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║          Codex API Manager v1.0                   ║');
  console.log('║          双击启动，网页控制面板                    ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log();

  ensureDeps();

  const pool = loadPool();
  log(`📊 账户池: ${pool.length} 个`);

  startProxy();
  await sleep(3000);

  log(`🔑 API Key: ${API_KEY}`);
  log(`🌐 API: http://localhost:${PROXY_PORT}/v1`);
  console.log();

  startDashboard();

  log('👆 已在浏览器打开控制面板，所有操作在网页中点击完成');
  log('   按 Ctrl+C 退出');
  console.log();

  setTimeout(() => checkAndRefreshTokens().catch(() => {}), 10000);
  setInterval(() => checkAndRefreshTokens().catch(() => {}), TOKEN_REFRESH_INTERVAL);
}

process.on('SIGINT', () => {
  console.log();
  log('⏹ 正在退出...');
  if (proxyProcess) {
    proxyProcess.kill();
  }
  process.exit(0);
});

main().catch(e => {
  console.error(`❌ Fatal: ${e.message}`);
  process.exit(1);
});
