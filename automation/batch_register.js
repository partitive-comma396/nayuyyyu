#!/usr/bin/env node
/**
 * 批量注册 Free 账号 + 自动提取 Token + 加入 pool.json
 * 支持代理轮换、CAPTCHA 换代理重试、断点续传
 *
 * Usage: node batch_register.js 14 [--resume] [--no-proxy]
 *   --no-proxy: 跳过代理池，直连注册（间隔 3–5 分钟）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { ChatGPTAccountCreator, CaptchaDetectedError } from './chatgpt_account_creator.js';
import { ProxyPool, defaultProxyPool } from './proxy-pool.js';
import { getBatchBetweenAccountsDelaySec } from './anti-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = path.resolve(__dirname, '..', 'accounts');
const POOL_PATH = path.join(ACCOUNTS_DIR, 'pool.json');
const PROGRESS_PATH = path.join(__dirname, 'batch_progress.json');

function loadConfig() {
  try {
    const p = path.join(__dirname, 'config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

function loadPool() {
  try {
    if (fs.existsSync(POOL_PATH)) return JSON.parse(fs.readFileSync(POOL_PATH, 'utf-8'));
  } catch {}
  return [];
}

function savePool(pool) {
  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2), 'utf-8');
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
  } catch {}
  return { completed: [], target: 0 };
}

function saveProgress(completed, target) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ completed, target, updatedAt: Date.now() }, null, 2), 'utf-8');
}

function emailToLabel(email) {
  if (!email || !email.includes('@')) return (email || '').replace(/\s/g, '_');
  return email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
}

function extractToken(email, password) {
  const label = emailToLabel(email);
  const env = { ...process.env, BATCH_HEADLESS: '1', NODE_NO_WARNINGS: '1' };
  const result = spawnSync('node', [path.join(__dirname, 'add_account.js'), email, password, label], {
    cwd: __dirname,
    stdio: 'inherit',
    timeout: 180000,
    env,
  });
  const authPath = path.join(ACCOUNTS_DIR, `${label}.json`);
  return { ok: result.status === 0 && fs.existsSync(authPath), authPath };
}

function addToPool(email, password) {
  const pool = loadPool();
  const exists = pool.some((a) => (a.email || '').toLowerCase() === email.toLowerCase());
  if (!exists) {
    pool.push({
      email,
      password,
      status: 'active',
      plan: 'free',
      quota_5h: null,
      quota_weekly: null,
      note: '批量注册 Free 账号',
    });
    savePool(pool);
  } else {
    for (const a of pool) {
      if ((a.email || '').toLowerCase() === email.toLowerCase()) {
        a.status = 'active';
        a.plan = 'free';
        break;
      }
    }
    savePool(pool);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const targetNum = parseInt(args[0], 10);
  const resume = args.includes('--resume');
  const noProxy = args.includes('--no-proxy');

  if (isNaN(targetNum) || targetNum < 1 || targetNum > 50) {
    console.log('Usage: node batch_register.js <count> [--resume] [--no-proxy]');
    console.log('  --no-proxy: 直连注册，间隔 3–5 分钟');
    process.exit(1);
  }

  const config = loadConfig();
  const antiCfg = config.anti_detect || {};
  const creator = new ChatGPTAccountCreator();

  let progress = loadProgress();
  if (!resume || progress.target !== targetNum) {
    progress = { completed: [], target: targetNum };
  }

  const completed = new Set(progress.completed);
  const remaining = targetNum - completed.size;

  if (remaining <= 0) {
    console.log(`\n✅ 已完成 ${targetNum} 个账号注册，无需继续。`);
    process.exit(0);
  }

  console.log('\n🚀 批量注册 Free 账号');
  console.log('═══════════════════════════════════════');
  console.log(`  目标: ${targetNum} 个 | 已完成: ${completed.size} | 待注册: ${remaining}`);
  console.log('═══════════════════════════════════════\n');

  let proxyCount = 0;
  if (!noProxy) {
    await defaultProxyPool.init();
    proxyCount = defaultProxyPool.availableCount;
    if (proxyCount > 0) {
      console.log(`🌐 代理池: ${proxyCount} 个可用\n`);
    } else {
      console.log('⚠️ 无可用代理，将直连注册（间隔 3–5 分钟）\n');
    }
  } else {
    console.log('🔌 --no-proxy：直连注册，间隔 3–5 分钟\n');
  }

  let done = completed.size;
  const delaySec = proxyCount > 0
    ? getBatchBetweenAccountsDelaySec(antiCfg)
    : Math.floor(180 + Math.random() * 120);

  for (let i = 0; i < targetNum; i++) {
    const accountNum = i + 1;
    if (completed.has(accountNum)) {
      console.log(`[${accountNum}/${targetNum}] 已跳过（断点续传）`);
      continue;
    }

    let proxy = noProxy ? null : defaultProxyPool.getNextProxy();
    let lastError = null;
    let registered = false;
    let email = null;
    let password = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0 && proxy) {
          defaultProxyPool.markBad(proxy);
          proxy = defaultProxyPool.getNextProxy();
        }
        const proxyStr = proxy || null;
        console.log(`[${accountNum}/${targetNum}] 注册中... ${proxyStr ? `代理: ${proxyStr.slice(0, 30)}...` : '直连'}`);

        const before = creator.createdAccounts.length;
        const success = await creator.createAccount(accountNum, targetNum, proxyStr);
        if (success) {
          const last = creator.createdAccounts[creator.createdAccounts.length - 1];
          email = last?.email;
          password = last?.password;
          registered = !!email;
          break;
        }
      } catch (e) {
        lastError = e;
        if (e instanceof CaptchaDetectedError) {
          console.log(`   ⚠️ CAPTCHA 检测到，换代理重试 (${attempt + 1}/3)`);
          if (proxy) defaultProxyPool.markBad(proxy);
        } else {
          console.log(`   ❌ ${e.message}`);
          break;
        }
      }
    }

    if (!registered || !email || !password) {
      console.log(`[${accountNum}/${targetNum}] ❌ 注册失败`);
      continue;
    }

    console.log(`[${accountNum}/${targetNum}] ✅ 注册成功: ${email}`);
    console.log(`   提取 Token...`);

    const { ok } = extractToken(email, password);
    if (ok) {
      addToPool(email, password);
      completed.add(accountNum);
      saveProgress([...completed], targetNum);
      done++;
      console.log(`[${accountNum}/${targetNum}] ✅ Token 已保存，已加入 pool\n`);
    } else {
      console.log(`[${accountNum}/${targetNum}] ⚠️ Token 提取失败，账号已写入 accounts.txt，请稍后手动: node add_account.js ${email} <密码>\n`);
    }

    if (accountNum < targetNum) {
      console.log(`   ⏳ 等待 ${delaySec}s 后继续...`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`📊 完成: ${done}/${targetNum} 个 Free 账号`);
  console.log(`💾 重启反代以加载新账号`);
  console.log('═══════════════════════════════════════\n');
}

main().catch((e) => {
  console.error(`\n❌ 致命错误: ${e.message}`);
  process.exit(1);
});
