#!/usr/bin/env node
/**
 * 卡密流水线：先激活查询 → 根据结果分支
 * - 未激活：注册新号 → 兑换激活 → 提取 Token
 * - 已激活且绑定邮箱在池中：质保激活 → 提取 Token
 *
 * Usage: node pipeline.js <card_key> [activation_url]
 * Output: last line is JSON with {email, password, label, auth_file, api_key}
 */

import { ChatGPTAccountCreator } from './chatgpt_account_creator.js';
import { execFileSync } from 'child_process';
import { firefox } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getLaunchOptions, FIREFOX_STEALTH_SCRIPT } from './anti-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = path.resolve(__dirname, '..', 'accounts');
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isValidEmail(s) {
  return typeof s === 'string' && s.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function runActivationQuery(cardKey, activationUrl) {
  try {
    const out = execFileSync('node', [
      path.join(__dirname, 'activate_account.js'),
      'query', cardKey, '', activationUrl,
    ], {
      cwd: __dirname,
      encoding: 'utf-8',
      timeout: 45000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    for (const line of (out || '').split('\n')) {
      const s = line.trim();
      if (s.startsWith('{')) {
        const q = JSON.parse(s);
        if (q.bound_email && !isValidEmail(q.bound_email)) q.bound_email = '';
        return q;
      }
    }
  } catch (e) {}
  return null;
}

function runWarranty(cardKey, activationUrl) {
  try {
    execFileSync('node', [
      path.join(__dirname, 'activate_account.js'),
      'warranty', cardKey, '', activationUrl,
    ], {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 60000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return 0;
  } catch (e) {
    return 1;
  }
}

// ─── Step 1: Register one account ────────────────────────────────────
async function registerOne() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  STEP 1/3 — 注册新 ChatGPT 账号');
  console.log('═══════════════════════════════════════════════════');
  const creator = new ChatGPTAccountCreator();
  const ok = await creator.createAccount(1, 1);
  if (!ok || creator.createdAccounts.length === 0) {
    throw new Error('注册失败');
  }
  const { email, password } = creator.createdAccounts[0];
  console.log(`✅ 注册成功: ${email}\n`);
  return { email, password };
}

// ─── Step 2: Activate card key with email ────────────────────────────
async function activateCard(cardKey, email, activationUrl) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  STEP 2/3 — 激活卡密');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  卡密: ${cardKey}`);
  console.log(`  邮箱: ${email}`);
  console.log(`  网址: ${activationUrl}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activate_'));
  const config = loadConfig();
  const opts = getLaunchOptions(config);
  let context = null;

  try {
    context = await firefox.launchPersistentContext(tempDir, {
      headless: false, slowMo: 300, timeout: 60000, ...opts,
    });
    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(FIREFOX_STEALTH_SCRIPT);

    console.log('🌐 打开激活网站...');
    await page.goto(`https://${activationUrl}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);

    // Fill card key
    await page.evaluate((key) => {
      const inputs = document.querySelectorAll('input[placeholder="请输入卡密"]');
      for (const inp of inputs) {
        if (inp.offsetParent !== null) {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(inp, key);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, cardKey);
    await sleep(500);

    // Fill email
    await page.evaluate((addr) => {
      const inp = document.querySelector('input[placeholder="请输入邮箱"]');
      if (inp) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inp, addr);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, email);
    await sleep(500);

    // Submit
    console.log('📤 提交兑换...');
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent?.trim() === '提交兑换' && btn.offsetParent !== null) {
          btn.click();
          return;
        }
      }
    });
    await sleep(3000);

    // Handle dialogs
    for (let i = 0; i < 8; i++) {
      const dialogResult = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent?.trim() || '';
          if (btn.offsetParent !== null) {
            if (text === '我知道了') { btn.click(); return 'ok'; }
            if (text === '不更换，直接激活') { btn.click(); return 'keep'; }
            if (text === '仍然使用原邮箱') { btn.click(); return 'keep_email'; }
          }
        }
        return null;
      });
      if (dialogResult) {
        console.log(`  📋 Dialog: ${dialogResult}`);
        if (dialogResult === 'ok') break;
        await sleep(2000);
        continue;
      }
      await sleep(2000);
    }

    const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const usedElsewhere = bodySnippet.includes('已被使用') || bodySnippet.includes('已使用');
    const failed = bodySnippet.includes('失败') || bodySnippet.includes('无效') || bodySnippet.includes('已过期');
    if (usedElsewhere) {
      return { success: false, usedElsewhere: true };
    }
    if (failed) {
      throw new Error(`激活失败: ${bodySnippet.substring(0, 200)}`);
    }
    return { success: true };

  } finally {
    await context?.close().catch(() => {});
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Step 3: Login + extract token (reuse add_account.js logic) ──────
async function extractToken(email, password, cardKey = '') {
  if (!isValidEmail(email)) {
    throw new Error(`无效邮箱格式，切勿将卡密当邮箱: ${String(email).substring(0, 30)}`);
  }
  console.log('═══════════════════════════════════════════════════');
  console.log('  STEP 3/3 — 登录提取 Token');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  📧 邮箱: ${email}`);

  // Dynamic import to reuse the existing extraction logic
  const { default: _mod } = await import('./add_account.js').catch(() => ({ default: null }));

  // We can't easily reuse add_account.js as a function since it calls main() on import.
  // Instead, run it as a subprocess.
  const { execFileSync } = await import('child_process');
  const label = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');

  try {
    execFileSync('node', [
      path.join(__dirname, 'add_account.js'),
      email, password, label,
    ], {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 180000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
  } catch (e) {
    // add_account.js might fail but still have written the file
  }

  const authFile = path.join(ACCOUNTS_DIR, `${label}.json`);
  if (!fs.existsSync(authFile)) {
    throw new Error(`Token 提取失败: ${authFile} 不存在`);
  }

  // Update pool.json (card_key 由 main 在调用后写入，此处只写基础字段)
  const poolPath = path.join(ACCOUNTS_DIR, 'pool.json');
  try {
    let pool = [];
    if (fs.existsSync(poolPath)) {
      pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    }
    const bindDate = cardKey ? new Date().toISOString().slice(0, 10) : null;
    const exists = pool.some(r => r.email === email);
    if (!exists) {
      pool.push({
        email, password, status: 'active',
        quota_5h: null, quota_weekly: null, note: '',
        ...(cardKey ? { card_key: cardKey, card_bind_date: bindDate } : {}),
      });
    } else {
      for (const r of pool) {
        if (r.email === email) {
          r.status = 'active';
          if (cardKey) {
            r.card_key = cardKey;
            r.card_bind_date = bindDate;
          }
        }
      }
    }
    fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), 'utf-8');
  } catch {}

  console.log(`✅ Token 已保存: ${authFile}\n`);
  return { label, authFile };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const cardKey = process.argv[2];
  const activationUrl = process.argv[3] || 'team.654301.xyz';

  if (!cardKey || !cardKey.includes('-')) {
    console.log('Usage: node pipeline.js <card_key> [activation_url]');
    console.log('  例: node pipeline.js ZB-MMHBNA7TKWYU team.654301.xyz');
    process.exit(1);
  }

  console.log('\n🚀 Codex API 全自动流水线');
  console.log('═══════════════════════════════════════════════════\n');

  // Step 0: 先激活查询，确定卡密状态（绝不能把卡密当邮箱用）
  console.log('🔍 Step 0 — 激活查询');
  console.log(`   卡密: ${cardKey}`);
  const queryResult = runActivationQuery(cardKey, activationUrl);
  const boundEmail = queryResult?.bound_email && isValidEmail(queryResult.bound_email) ? queryResult.bound_email.trim() : '';
  const statusActivated = (queryResult?.status || '').includes('已激活');
  const statusStopped = (queryResult?.status || '').includes('已停用');

  let emailToUse = '';
  let passwordToUse = '';

  if (boundEmail && (statusActivated || statusStopped)) {
    // 卡密已激活，绑定到 bound_email。检查池中是否有该账号
    const poolPath = path.join(ACCOUNTS_DIR, 'pool.json');
    let pool = [];
    if (fs.existsSync(poolPath)) {
      pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    }
    const acct = pool.find(r => (r.email || '').toLowerCase() === boundEmail.toLowerCase());
    if (acct && acct.password) {
      console.log(`✅ 卡密已激活，绑定邮箱 ${boundEmail} 在池中 → 执行质保激活 + 提取 Token\n`);
      emailToUse = boundEmail;
      passwordToUse = acct.password;

      // 质保激活
      console.log('🔧 质保激活...');
      const warrantyRc = runWarranty(cardKey, activationUrl);
      if (warrantyRc !== 0) {
        console.log('⚠️ 质保提交完成（或平台已激活），继续提取 Token');
      }
      await sleep(5000);
    } else {
      throw new Error(`该卡密已绑定 ${boundEmail}，该邮箱不在账户池中。请先在控制面板添加该账户，或运行: python manage.py pool add ${boundEmail} <密码> ${cardKey}`);
    }
  } else {
    // 未激活：优先用池中空闲号，否则注册新号 → 兑换激活 → 提取 Token
    const poolPath = path.join(ACCOUNTS_DIR, 'pool.json');
    let pool = [];
    if (fs.existsSync(poolPath)) {
      pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    }
    const idleAccounts = pool.filter(
      (r) => r.status === 'pending_invite' && r.email && r.password
    );

    if (idleAccounts.length > 0) {
      const acct = idleAccounts[0];
      emailToUse = acct.email;
      passwordToUse = acct.password;
      console.log(`📋 卡密未激活，池中有 ${idleAccounts.length} 个空闲号 → 使用 ${emailToUse} 兑换\n`);
    } else {
      console.log('📋 卡密未激活，池中无空闲号 → 注册新号并兑换\n');
      const { email, password } = await registerOne();
      emailToUse = email;
      passwordToUse = password;
    }

    console.log('⏳ 等待 5 秒后激活...\n');
    await sleep(5000);

    const activateResult = await activateCard(cardKey, email, activationUrl);

    if (!activateResult.success && activateResult.usedElsewhere) {
      // 兑换时显示已被使用：再查一次，可能刚被他人使用
      console.log('\n⚠️ 兑换时显示已被使用，重新激活查询...\n');
      const q2 = runActivationQuery(cardKey, activationUrl);
      const be2 = q2?.bound_email && isValidEmail(q2.bound_email) ? q2.bound_email.trim() : '';
      if (be2) {
        const poolPath = path.join(ACCOUNTS_DIR, 'pool.json');
        let pool = [];
        if (fs.existsSync(poolPath)) pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
        const acct = pool.find(r => (r.email || '').toLowerCase() === be2.toLowerCase());
        if (acct && acct.password) {
          console.log(`✅ 已找到绑定邮箱 ${be2}，将直接提取 Token\n`);
          emailToUse = be2;
          passwordToUse = acct.password;
          const warrantyRc = runWarranty(cardKey, activationUrl);
          if (warrantyRc !== 0) console.log('⚠️ 质保已提交');
          await sleep(5000);
        } else {
          throw new Error(`该卡密已绑定 ${be2}，该邮箱不在池中。请先添加: python manage.py pool add ${be2} <密码> ${cardKey}`);
        }
      } else {
        throw new Error('卡密已被使用，但激活查询无法获取绑定邮箱，请手动到激活站查询');
      }
    } else if (activateResult.success) {
      console.log('⏳ 等待 10 秒让邀请生效...\n');
      await sleep(10000);
    } else {
      throw new Error('激活失败');
    }
  }

  if (!emailToUse || !passwordToUse || !emailToUse.includes('@')) {
    throw new Error('内部错误：邮箱格式异常，请勿将卡密填入邮箱');
  }

  // Step 3: Login + Extract（写入 pool 时带上卡密，便于掉车后质保）
  const { label, authFile } = await extractToken(emailToUse, passwordToUse, cardKey);

  // Done
  let apiKey = 'sk-test';
  try {
    const envText = fs.readFileSync(path.resolve(__dirname, '..', 'proxy', '.env'), 'utf-8');
    const m = envText.match(/KEY\s*=\s*(\S+)/);
    if (m) apiKey = m[1].trim();
  } catch {}
  const proxyUrl = 'http://localhost:9000/v1';

  console.log('═══════════════════════════════════════════════════');
  console.log('  ✅ 全部完成！');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  📧 账号: ${emailToUse}`);
  console.log(`  🔐 Token: ${authFile}`);
  console.log(`  🔑 API Key: ${apiKey}`);
  console.log(`  🌐 API 地址: ${proxyUrl}`);
  console.log();
  console.log('  使用方式:');
  console.log(`    curl ${proxyUrl}/chat/completions \\`);
  console.log(`      -H "Authorization: Bearer ${apiKey}" \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}]}'`);
  console.log('═══════════════════════════════════════════════════');

  // Machine-readable output on last line
  const result = { email: emailToUse, password: passwordToUse, label, auth_file: authFile, api_key: apiKey, proxy: proxyUrl };
  process.stdout.write('\n' + JSON.stringify(result) + '\n');
}

main().catch(e => {
  console.error(`\n❌ 流水线失败: ${e.message}`);
  process.exit(1);
});
