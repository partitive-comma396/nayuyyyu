#!/usr/bin/env node
/**
 * 剩余额度检测 — 使用 Playwright 登录 ChatGPT 后访问
 * https://chatgpt.com/codex/settings/usage 页面，解析 5h/1周 额度百分比。
 *
 * 结果写回 pool.json 并输出 JSON 到 stdout 供 app.js 使用。
 *
 * Usage: node check_quota.js
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
const POOL_PATH = path.join(ACCOUNTS_DIR, 'pool.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const USAGE_URL = 'https://chatgpt.com/codex/settings/usage';

function loadPool() { try { return JSON.parse(fs.readFileSync(POOL_PATH, 'utf-8') || '[]'); } catch { return []; } }
function savePool(pool) { fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2), 'utf-8'); }
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function emailToLabel(e) {
  if (!e || !e.includes('@')) return (e || '').replace(/\s/g, '_');
  return e.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 从页面文本中提取额度百分比。
 * 页面格式示例: "5 hour limit ... 100% left ... Weekly limit ... 87% left"
 */
function parseQuotaFromText(text) {
  const result = { quota_5h: null, quota_weekly: null };

  // "5 hour usage limit\n\n99%\nremaining" 或 "5 hour ... 99% left/remaining"
  const fiveHourMatch = text.match(/5\s*hour[^]*?(\d+(?:\.\d+)?)\s*%/i);
  if (fiveHourMatch) result.quota_5h = parseFloat(fiveHourMatch[1]);

  // "Weekly usage limit\n\n87%\nremaining"
  const weeklyMatch = text.match(/weekly\s*usage[^]*?(\d+(?:\.\d+)?)\s*%/i);
  if (weeklyMatch) result.quota_weekly = parseFloat(weeklyMatch[1]);

  // 中文格式 "5小时额度：XX%"
  if (result.quota_5h === null) {
    const cn5h = text.match(/5\s*(?:小时|h)[^]*?(\d+(?:\.\d+)?)\s*%/i);
    if (cn5h) result.quota_5h = parseFloat(cn5h[1]);
  }
  if (result.quota_weekly === null) {
    const cnW = text.match(/(?:周|week)[^]*?(\d+(?:\.\d+)?)\s*%/i);
    if (cnW) result.quota_weekly = parseFloat(cnW[1]);
  }

  return result;
}

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

      // 只看最新几封，避免命中历史旧验证码导致循环。
      const newestCodes = subjects
        .slice(0, 3)
        .map((subj) => {
          const m = subj.match(/\b(\d{6})\b/);
          return m ? m[1] : null;
        })
        .filter(Boolean);

      let foundUsedCode = false;
      for (const code of newestCodes) {
        if (used.has(code)) {
          foundUsedCode = true;
          continue;
        }
        console.error(`[${email}] 验证码: ${code}`);
        return code;
      }

      if (foundUsedCode) {
        console.error(`[${email}] 收到的验证码已用过，等待新邮件...`);
      }
      if (attempt < maxRetries - 1) {
        console.error(`[${email}] 等待验证码 ${attempt + 1}/${maxRetries}...`);
        await sleep(3000);
      }
    } catch (e) { await sleep(2000); }
  }
  return null;
}

async function submitVerificationCode(page, code, email) {
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
    const stillOnVerification = page.url().includes('email-verification');
    if (!stillOnVerification) {
      console.error(`[${email}] 验证码提交成功(${strategyName})`);
      return true;
    }
    return false;
  };

  // 策略1：分段输入框逐位填写
  const okSegmented = await attemptSubmit('segmented', async () => {
    const segmented = page.locator(
      'input[maxlength="1"]:visible, input[inputmode="numeric"]:visible, input[type="tel"]:visible, input[type="number"]:visible'
    );
    const segCount = await segmented.count();
    if (segCount < 6) throw new Error('no segmented inputs');
    for (let i = 0; i < 6; i++) {
      const cell = segmented.nth(i);
      await cell.click({ timeout: 1500 });
      await cell.fill(otp[i], { timeout: 1500 });
    }
  });
  if (okSegmented) return true;

  // 策略2：单输入框填完整 OTP
  const okMerged = await attemptSubmit('merged', async () => {
    const mergedCandidates = [
      'input[name*="code" i]:visible',
      'input[id*="code" i]:visible',
      'input[autocomplete="one-time-code"]:visible',
      'input[maxlength="6"]:visible',
      'input[type="text"]:visible',
    ];
    let filled = false;
    for (const sel of mergedCandidates) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 1500 });
        await loc.fill(otp, { timeout: 2000 });
        filled = true;
        break;
      }
    }
    if (!filled) throw new Error('no merged input');
  });
  if (okMerged) return true;

  // 策略3：键盘输入（某些页面 input 被框架封装）
  const okKeyboard = await attemptSubmit('keyboard', async () => {
    await page.mouse.click(420, 260);
    await sleep(150);
    await page.keyboard.type(otp, { delay: 90 });
  });
  if (okKeyboard) return true;

  console.error(`[${email}] 验证码提交失败，仍停留在验证页`);
  return false;
}

async function loginAndGetQuota(email, password, config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota_'));
  const launchOpts = getLaunchOptions(config);

  let context = null;
  try {
    context = await firefox.launchPersistentContext(tempDir, {
      headless: true,
      slowMo: 200,
      timeout: 60000,
      ...launchOpts,
    });

    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(FIREFOX_STEALTH_SCRIPT);

    // 拦截 Bearer token 的请求（复用 add_account.js 的认证方式）
    const capturedTokens = [];
    page.on('request', (req) => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) capturedTokens.push(auth.slice(7));
    });

    // Step 1: 登录 ChatGPT
    console.error(`[${email}] 登录 ChatGPT...`);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(2000);

    // 关闭弹窗/cookie
    await page.evaluate(() => {
      document.querySelectorAll('[class*="cookie"], [class*="consent"], [class*="banner"], [class*="overlay"]').forEach(el => {
        if (el.offsetParent !== null) el.remove();
      });
      document.querySelectorAll('button').forEach(btn => {
        const t = btn.textContent?.toLowerCase() || '';
        if (t.includes('accept') || t.includes('reject')) btn.click();
      });
    });
    await sleep(500);

    // 检测是否已登录（检查页面是否有 "Log in" 按钮）
    const hasLoginButton = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (/log\s*in/i.test(btn.textContent?.trim() || '')) return true;
      }
      return false;
    });
    const isLoggedIn = !hasLoginButton && page.url().includes('chatgpt.com');
    console.error(`[${email}] 登录状态: ${isLoggedIn ? '已登录' : '未登录'}`);

    if (!isLoggedIn) {
      // 点击 Log in
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          if (/log\s*in/i.test(btn.textContent?.trim() || '')) { btn.click(); return; }
        }
      });
      await sleep(2000);

      // 输入邮箱
      try {
        const emailInput = page.getByRole('textbox', { name: /email/i });
        await emailInput.waitFor({ state: 'visible', timeout: 10000 });
        await emailInput.fill(email);
        await sleep(300);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await sleep(3000);
      } catch (e) {
        console.error(`[${email}] 邮箱输入失败: ${e.message}`);
      }

      // 登录循环（处理验证码、密码页、工作空间选择等）
      const usedOtps = [];
      let otpAttempts = 0;
      let loginSucceeded = false;
      for (let step = 0; step < 15; step++) {
        const url = page.url();

        if (url.includes('chatgpt.com') && !url.includes('auth.openai.com')) {
          const stillHasLoginBtn = await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
              if (/log\s*in/i.test(btn.textContent?.trim() || '')) return true;
            }
            return false;
          }).catch(() => true);

          if (!stillHasLoginBtn) {
            loginSucceeded = true;
            console.error(`[${email}] 登录成功`);
            break;
          }
        }

        // Email 验证码
        if (url.includes('email-verification')) {
          if (otpAttempts >= 6) {
            console.error(`[${email}] 验证码尝试次数过多，终止本账号检测`);
            return null;
          }
          console.error(`[${email}] 需要邮箱验证码...`);
          await sleep(5000);
          const code = await getVerificationCode(email, 10, usedOtps);
          if (!code) {
            console.error(`[${email}] 无法获取验证码，跳过`);
            return null;
          }
          usedOtps.push(code);
          otpAttempts += 1;
          const ok = await submitVerificationCode(page, code, email);
          if (!ok) {
            await sleep(1500);
          }
          await sleep(5000);
          continue;
        }

        // 密码页
        if (url.includes('password') || url.includes('log-in/password')) {
          console.error(`[${email}] 输入密码...`);
          await sleep(1000);
          const filled = await page.evaluate((pw) => {
            const inp = document.querySelector('input[type="password"]');
            if (!inp) return false;
            const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSet.call(inp, pw);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, password);
          if (filled) {
            await sleep(300);
            await page.keyboard.press('Enter');
            await sleep(4000);
          }
          continue;
        }

        // 工作空间选择（点第一个非 Personal 的选项）
        if (url.includes('/workspace')) {
          console.error(`[${email}] 选择工作空间...`);
          await sleep(2000);
          const clicked = await page.evaluate(() => {
            // 找所有 SPAN 文字（工作空间名字都在 SPAN 里）
            const spans = [...document.querySelectorAll('span')].filter(s => s.offsetParent !== null);
            for (const span of spans) {
              const t = span.textContent?.trim() || '';
              // 跳过标题、Personal、和过短的文字
              if (!t || t.length < 3) continue;
              if (/personal|choose|workspace|terms|privacy/i.test(t)) continue;
              if (t === span.closest('body')?.querySelector('h1,h2')?.textContent) continue;
              // 这是一个工作空间名字，点击它的可点击父元素
              const clickable = span.closest('div[role="button"], button, a, [tabindex], div[class]');
              if (clickable) { clickable.click(); return t; }
              span.click(); return t;
            }
            return null;
          });
          console.error(`[${email}] 点击工作空间: ${clicked || '未找到'}`);
          await sleep(4000);
          continue;
        }

        await sleep(2000);
      }

      if (!loginSucceeded) {
        console.error(`[${email}] 登录流程未完成，跳过额度解析`);
        return null;
      }
    }

    // Step 2: 导航到额度页面
    console.error(`[${email}] 访问额度页面...`);
    await page.goto(USAGE_URL, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
    await sleep(5000);

    // 读取页面内容
    let bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    console.error(`[${email}] 页面内容 (前200字): ${bodyText.replace(/\n/g, ' ').slice(0, 200)}`);

    if (!bodyText || bodyText.length < 10) {
      console.error(`[${email}] 页面为空，可能需要重新登录`);
      return null;
    }

    const looksLoggedOut = /log in to get answers|sign up|登录|未登录/i.test(bodyText)
      && !/5\s*hour|weekly|usage limit|remaining|left|额度|周/i.test(bodyText);
    if (looksLoggedOut) {
      console.error(`[${email}] 看起来仍在未登录页，重试一次进入额度页...`);
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(2000);
      await page.goto(USAGE_URL, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
      await sleep(4000);
      bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      console.error(`[${email}] 重试后页面 (前200字): ${bodyText.replace(/\n/g, ' ').slice(0, 200)}`);
    }

    const quotaData = parseQuotaFromText(bodyText);
    if (quotaData.quota_5h !== null || quotaData.quota_weekly !== null) {
      console.error(`[${email}] 额度: 5h=${quotaData.quota_5h}% 周=${quotaData.quota_weekly}%`);
    } else {
      console.error(`[${email}] 未能解析额度百分比`);
    }

    return quotaData;

  } catch (e) {
    console.error(`[${email}] 错误: ${e.message}`);
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  const pool = loadPool();
  const config = loadConfig();
  const results = [];

  // 只检测已激活（team/business plan）且有密码的账号
  const activeAccounts = pool.filter(a => {
    if (!a.email || !a.password) return false;
    if (a.status === 'active') return true;
    const label = emailToLabel(a.email);
    const authFile = path.join(ACCOUNTS_DIR, `${label}.json`);
    if (!fs.existsSync(authFile)) return false;
    try {
      const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      const token = auth.tokens?.access_token;
      if (!token) return false;
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      const plan = payload['https://api.openai.com/auth']?.chatgpt_plan_type;
      return ['team', 'business', 'enterprise', 'pro', 'plus', 'gopro', 'edu'].includes(plan);
    } catch { return false; }
  });

  if (!activeAccounts.length) {
    process.stdout.write(JSON.stringify({ accounts: [], error: '无已激活账号可检测额度' }) + '\n');
    return;
  }

  console.error(`\n📊 检测 ${activeAccounts.length} 个已激活账号的额度...\n`);

  for (const acct of activeAccounts) {
    console.error(`\n────── ${acct.email} ──────`);
    const data = await loginAndGetQuota(acct.email, acct.password, config);
    results.push({
      email: acct.email,
      quota_5h: data?.quota_5h ?? null,
      quota_weekly: data?.quota_weekly ?? null,
    });
    // 账号之间等几秒避免速率限制
    if (activeAccounts.indexOf(acct) < activeAccounts.length - 1) {
      await sleep(3000);
    }
  }

  // 写回 pool.json
  const poolData = loadPool();
  let changed = false;
  for (const r of results) {
    const entry = poolData.find(a => a.email === r.email);
    if (entry) {
      if (r.quota_5h !== null) { entry.quota_5h = r.quota_5h; changed = true; }
      if (r.quota_weekly !== null) { entry.quota_weekly = r.quota_weekly; changed = true; }
    }
  }
  if (changed) savePool(poolData);

  process.stdout.write(JSON.stringify({ accounts: results, source: 'browser', ok: true }) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
  process.exit(1);
});
