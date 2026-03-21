#!/usr/bin/env node
/**
 * Login to ChatGPT with email/password → extract auth tokens → write auth.json
 * Handles: email verification OTP, password, workspace selection, about-you
 */

import { firefox } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { getLaunchOptions, FIREFOX_STEALTH_SCRIPT } from './anti-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = path.resolve(__dirname, '..', 'accounts');
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getVerificationCode(email, maxRetries = 10, usedCodes = []) {
  const [username, domain] = email.split('@');
  const used = new Set(Array.isArray(usedCodes) ? usedCodes : []);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch('https://generator.email/', {
        headers: { accept: 'text/html', cookie: `surl=${domain}/${username}`, 'user-agent': 'Mozilla/5.0' },
      });
      const html = await resp.text();
      const $ = cheerio.load(html);
      const subjects = [];
      $('#email-table .e7m.list-group-item').each((_, el) => {
        const subj = $(el).find('.subj_div_45g45gg').text().trim();
        if (subj) subjects.push(subj);
      });
      const newestCodes = subjects
        .slice(0, 3)
        .map((subj) => {
          const m = subj.match(/\b(\d{6})\b/);
          return m ? m[1] : null;
        })
        .filter(Boolean);

      let foundUsed = false;
      for (const code of newestCodes) {
        if (used.has(code)) {
          foundUsed = true;
          continue;
        }
        console.log(`✅ Code: ${code}`);
        return code;
      }
      if (foundUsed) {
        console.log('⏳ 收件箱仍是已用过的验证码，等待新邮件...');
      }
      if (attempt < maxRetries - 1) {
        console.log(`⏳ No code yet, retry ${attempt + 1}/${maxRetries}...`);
        await sleep(3000);
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}`);
      await sleep(2000);
    }
  }
  return null;
}

/** 与 check_quota.js 一致：多策略填入 OTP 并确认已离开 email-verification */
async function submitVerificationCode(page, code) {
  const otp = String(code || '').trim();
  if (!/^\d{6}$/.test(otp)) return false;

  const clickSubmitButtons = async () => {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      for (const btn of btns) {
        const t = (btn.textContent || '').trim().toLowerCase();
        if (
          t === 'continue' ||
          t.includes('verify') ||
          t.includes('submit') ||
          t.includes('next') ||
          t.includes('继续') ||
          t.includes('验证') ||
          t.includes('确认')
        ) {
          btn.click();
          return;
        }
      }
    }).catch(() => {});
  };

  const attemptSubmit = async (strategyName, fn) => {
    await fn().catch(() => {});
    await sleep(600);
    await clickSubmitButtons();
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(2500);
    if (!page.url().includes('email-verification')) {
      console.log(`✅ 验证码已提交 (${strategyName})`);
      return true;
    }
    return false;
  };

  const okSeg = await attemptSubmit('segmented', async () => {
    const segmented = page.locator(
      'input[maxlength="1"]:visible, input[inputmode="numeric"]:visible, input[type="tel"]:visible, input[type="number"]:visible'
    );
    const n = await segmented.count();
    if (n < 6) throw new Error('no segmented');
    for (let i = 0; i < 6; i++) {
      await segmented.nth(i).click({ timeout: 1500 }).catch(() => {});
      await segmented.nth(i).fill(otp[i], { timeout: 1500 }).catch(() => {});
    }
  });
  if (okSeg) return true;

  const okMerged = await attemptSubmit('merged', async () => {
    const sels = [
      'input[name*="code" i]:visible',
      'input[id*="code" i]:visible',
      'input[autocomplete="one-time-code"]:visible',
      'input[maxlength="6"]:visible',
      'input[type="text"]:visible',
    ];
    let filled = false;
    for (const sel of sels) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 1500 }).catch(() => {});
        await loc.fill(otp, { timeout: 2000 }).catch(() => {});
        filled = true;
        break;
      }
    }
    if (!filled) throw new Error('no merged');
  });
  if (okMerged) return true;

  const okKb = await attemptSubmit('keyboard', async () => {
    await page.mouse.click(420, 260).catch(() => {});
    await sleep(150);
    await page.keyboard.type(otp, { delay: 90 }).catch(() => {});
  });
  if (okKb) return true;

  console.log('⚠️ 验证码提交失败，仍停留在验证页');
  return false;
}

async function loginAndExtractTokens(email, password, config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt_login_'));
  const launchOpts = getLaunchOptions(config);
  let context = null;

  try {
    const headless = process.env.BATCH_HEADLESS === '1';
    context = await firefox.launchPersistentContext(tempDir, {
      headless, slowMo: 400, timeout: 60000, ...launchOpts,
    });
    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(FIREFOX_STEALTH_SCRIPT);

    // Intercept Bearer tokens from ALL requests
    const capturedTokens = [];
    page.on('request', (req) => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) capturedTokens.push(auth.slice(7));
    });

    // Step 1: Navigate + Login
    console.log('🌐 Opening ChatGPT...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Dismiss any overlays/cookie banners first
    await page.evaluate(() => {
      document.querySelectorAll('[class*="cookie"], [class*="consent"], [class*="banner"], [class*="overlay"]').forEach(el => {
        if (el.offsetParent !== null) el.remove();
      });
      // Also click "Accept" or "Reject" cookie buttons
      document.querySelectorAll('button').forEach(btn => {
        const t = btn.textContent?.toLowerCase() || '';
        if (t.includes('accept') || t.includes('reject') || t.includes('manage')) btn.click();
      });
    });
    await sleep(1000);

    // Click Log in via JS to bypass overlay interception
    console.log('🔑 Clicking Log in...');
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (/log\s*in/i.test(btn.textContent?.trim() || '')) {
          btn.click();
          return;
        }
      }
    });
    await sleep(2000);

    console.log(`📧 Email: ${email}`);
    const emailInput = page.getByRole('textbox', { name: /email/i });
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(email);
    await sleep(500);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await sleep(4000);

    const usedOtps = [];
    let otpAttempts = 0;

    // Step 2: Handle whatever page comes next (loop until we reach chatgpt.com)
    for (let step = 0; step < 15; step++) {
      const url = page.url();
      console.log(`📍 [${step}] ${url}`);

      // SUCCESS — reached ChatGPT
      if (url.includes('chatgpt.com') && !url.includes('auth.openai.com')) {
        console.log('✅ Logged into ChatGPT!');
        break;
      }

      // EMAIL VERIFICATION — 与额度检测相同：去重 + 多策略提交，避免只读码不输入
      if (url.includes('email-verification')) {
        if (otpAttempts >= 8) {
          console.error('❌ 邮箱验证码尝试次数过多');
          return null;
        }
        console.log('📬 Email verification...');
        await sleep(4000);
        const code = await getVerificationCode(email, 12, usedOtps);
        if (!code) {
          console.error('❌ No code');
          return null;
        }
        usedOtps.push(code);
        otpAttempts += 1;

        const ok = await submitVerificationCode(page, code);
        if (!ok) {
          console.log('⚠️ 本次验证码未生效，稍后重试同一页...');
          await sleep(3500);
        }
        await sleep(4000);
        continue;
      }

      // PASSWORD PAGE
      if (url.includes('password') || url.includes('log-in/password')) {
        console.log('🔐 Password...');
        await sleep(2000);
        // Find password input via JS
        const filled = await page.evaluate((pw) => {
          const inp = document.querySelector('input[type="password"]');
          if (inp) {
            const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSet.call(inp, pw);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        }, password);
        if (filled) {
          await sleep(500);
          await page.keyboard.press('Enter');
          await sleep(5000);
        } else {
          // Keyboard fallback
          await page.keyboard.press('Tab');
          await sleep(200);
          await page.keyboard.type(password, { delay: 50 });
          await sleep(500);
          await page.keyboard.press('Enter');
          await sleep(5000);
        }
        continue;
      }

      // WORKSPACE PAGE — click Team workspace (NOT Personal) for gpt-5.4 access
      if (url.includes('/workspace')) {
        console.log('🏢 Workspace → selecting Team workspace (for gpt-5.4)...');
        await sleep(3000);

        // Debug: dump visible text
        const visTexts = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll('*').forEach(el => {
            if (el.children.length === 0 && el.offsetParent !== null) {
              const t = el.textContent?.trim();
              if (t && t.length > 1 && t.length < 50 && !t.includes('\n')) items.push(t);
            }
          });
          return [...new Set(items)];
        });
        console.log(`  Visible items: ${visTexts.join(' | ')}`);

        // Strategy: click the FIRST clickable workspace that is NOT Personal account
        const clicked = await page.evaluate(() => {
          // Find all leaf elements with short text that could be workspace names
          const clickable = document.querySelectorAll('div, button, a, span');
          for (const el of clickable) {
            if (el.offsetParent === null) continue;
            const text = el.textContent?.trim() || '';
            const directText = el.childNodes.length <= 2 ? text : '';
            // Skip if it's Personal account or too long or too short
            if (!directText || directText.length > 30 || directText.length < 3) continue;
            if (directText.includes('Personal') || directText.includes('Privacy')
                || directText.includes('Terms') || directText.includes('Choose')
                || directText === 'Workspace') continue;
            // This is likely the team workspace ID (like "vpkj286731")
            el.click();
            return `clicked: "${directText}"`;
          }
          return null;
        });
        console.log(`  Result: ${clicked || 'not found'}`);

        if (!clicked) {
          // Fallback: try navigating directly
          await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }
        await sleep(4000);
        continue;
      }

      // ABOUT-YOU / ONBOARDING
      if (url.includes('about-you') || url.includes('onboarding')) {
        console.log('📋 About-you page...');
        await sleep(2000);
        // Click any visible option/radio via JS
        await page.evaluate(() => {
          const radios = document.querySelectorAll('input[type="radio"], [role="radio"]');
          if (radios.length > 0) radios[0].click();
          const options = document.querySelectorAll('[role="option"], [data-testid]');
          if (options.length > 0 && radios.length === 0) options[0].click();
        });
        await sleep(1000);
        // Press Enter or click submit
        await page.keyboard.press('Enter');
        await sleep(4000);
        // If still on same page, try clicking any visible button
        if (page.url().includes('about-you')) {
          await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
              const t = b.textContent?.toLowerCase() || '';
              if (t.includes('finish') || t.includes('continue') || t.includes('skip') || t.includes('next')) {
                b.click();
                return;
              }
            }
            if (btns.length > 0) btns[btns.length - 1].click();
          });
          await sleep(3000);
        }
        continue;
      }

      // UNKNOWN — wait and retry
      await sleep(4000);
    }

    // Step 3: Extract tokens
    const finalUrl = page.url();
    console.log(`📍 Final: ${finalUrl}`);
    if (!finalUrl.includes('chatgpt.com')) {
      console.error(`❌ Not on ChatGPT: ${finalUrl}`);
      return null;
    }

    console.log('🔍 Extracting tokens...');
    await sleep(3000);

    let accessToken = '';
    let accountId = '';

    // Already-captured Bearer tokens from network
    if (capturedTokens.length > 0) {
      accessToken = capturedTokens[capturedTokens.length - 1];
      console.log('  ✅ From network interception');
    }

    // Session endpoint
    if (!accessToken) {
      const session = await page.evaluate(async () => {
        try { const r = await fetch('/api/auth/session', { credentials: 'include' }); return r.ok ? await r.json() : null; } catch { return null; }
      });
      if (session?.accessToken) { accessToken = session.accessToken; console.log('  ✅ From session endpoint'); }
    }

    // Trigger API call and capture
    if (!accessToken) {
      await page.evaluate(() => fetch('/backend-api/me', { credentials: 'include' }).catch(() => {}));
      await sleep(3000);
      if (capturedTokens.length > 0) { accessToken = capturedTokens[capturedTokens.length - 1]; console.log('  ✅ From triggered API call'); }
    }

    // Reload and capture
    if (!accessToken) {
      console.log('  Reloading to capture tokens...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(5000);
      if (capturedTokens.length > 0) { accessToken = capturedTokens[capturedTokens.length - 1]; console.log('  ✅ From reload'); }
    }

    // Cookies
    if (!accessToken) {
      const cookies = await context.cookies();
      const sc = cookies.find(c => c.name.includes('session-token') || c.name.includes('access'));
      if (sc) { accessToken = sc.value; console.log(`  ✅ From cookie: ${sc.name}`); }
    }

    // Account info
    const me = await page.evaluate(async () => {
      try { const r = await fetch('/backend-api/me', { credentials: 'include' }); return r.ok ? await r.json() : null; } catch { return null; }
    });
    if (me) accountId = me.id || '';

    if (!accessToken) { console.error('❌ No access token found'); return null; }
    console.log(`✅ Token: ${accessToken.substring(0, 30)}...`);
    if (accountId) console.log(`✅ Account: ${accountId}`);

    return {
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { access_token: accessToken, refresh_token: '', id_token: '', account_id: accountId, token_type: 'Bearer' },
      email, created_at: new Date().toISOString(),
    };

  } finally {
    await context?.close().catch(() => {});
    try { await sleep(500); if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const label = process.argv[4] || (email && email.includes('@') ? email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_') : 'unknown');
  if (!email || !password) { console.log('Usage: node add_account.js <email> <password> [label]'); process.exit(1); }
  if (!email.includes('@') || /^[A-Z0-9]+-[A-Z0-9]{6,}$/.test(email.trim())) {
    console.error('❌ 第一个参数必须是邮箱，不能是卡密。卡密请通过 pipeline 执行。');
    process.exit(1);
  }

  console.log('🚀 ChatGPT Account Token Extractor');
  console.log('='.repeat(50));
  console.log(`📧 Email: ${email}`);
  console.log(`🏷  Label: ${label}\n`);

  const config = loadConfig();
  const authData = await loginAndExtractTokens(email, password, config);
  if (!authData) { console.error('❌ Failed'); process.exit(1); }

  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const outputPath = path.join(ACCOUNTS_DIR, `${label}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(authData, null, 2), 'utf-8');
  fs.chmodSync(outputPath, 0o600);

  // Update pool.json status
  const poolPath = path.join(ACCOUNTS_DIR, 'pool.json');
  try {
    if (fs.existsSync(poolPath)) {
      const pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
      for (const rec of pool) {
        if (rec.email === email) rec.status = 'active';
      }
      fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), 'utf-8');
    }
  } catch {}

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Saved: ${outputPath}`);
  console.log('   Restart proxy to load the new account.');
}

main().catch((e) => { console.error(`❌ Fatal: ${e.message}`); process.exit(1); });
