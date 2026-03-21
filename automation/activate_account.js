#!/usr/bin/env node
/**
 * Activate a ChatGPT Team account via team.654301.xyz
 * Modes: redeem (首次兑换) | warranty (质保激活)
 * Usage: node activate_account.js redeem <card_key> <email> [activation_url]
 *        node activate_account.js warranty <card_key> [activation_url]
 *        node activate_account.js query <card_key> [activation_url]   # 激活查询，后台静默，返回 JSON
 */

import { firefox } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLaunchOptions, FIREFOX_STEALTH_SCRIPT } from './anti-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadConfig() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); } catch { return {}; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function queryActivation(cardKey, activationUrl = 'team.654301.xyz') {
  const baseUrl = activationUrl.replace(/^https?:\/\//, '');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activate_query_'));
  const config = loadConfig();
  const opts = getLaunchOptions(config);
  let context = null;

  try {
    context = await firefox.launchPersistentContext(tempDir, {
      ...opts,
      headless: true,
      slowMo: 100,
      timeout: 30000,
    });
    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(FIREFOX_STEALTH_SCRIPT);

    await page.goto(`https://${baseUrl}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);

    const tabClicked = await page.evaluate(() => {
      const tabs = document.querySelectorAll('.el-tabs__item');
      for (const tab of tabs) {
        if (tab.textContent?.trim() === '激活查询') {
          tab.click();
          return true;
        }
      }
      return false;
    });
    await sleep(2000);

    await page.evaluate((key) => {
      const inputs = document.querySelectorAll('input[placeholder="请输入卡密"]');
      for (const inp of inputs) {
        if (inp.offsetParent !== null) {
          const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inp, key);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, cardKey);
    await sleep(500);

    const btnClicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if ((btn.textContent?.trim() === '查询状态' || btn.textContent?.trim() === '查询') && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await sleep(3000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const modalText = await page.evaluate(() => {
      const modals = document.querySelectorAll('.el-message-box, .el-dialog, .el-message, [class*="modal"], [class*="toast"]');
      for (const m of modals) {
        if (m.offsetParent !== null) return m.textContent?.trim() || '';
      }
      return '';
    });
    const raw = modalText || bodyText;

    let bound_email = '';
    let status = '';
    const emailMatch = raw.match(/[邮箱|绑定][：:]\s*([^\s\n]+@[^\s\n]+)/);
    if (emailMatch) bound_email = emailMatch[1].trim();
    const statusMatch = raw.match(/[状态|激活][：:]\s*([^\n]+)/);
    if (statusMatch) status = statusMatch[1].trim();
    if (!bound_email && raw.includes('@')) {
      const e = raw.match(/([a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (e) bound_email = e[1];
    }
    if (raw.includes('已激活') || raw.includes('正常')) status = status || '已激活';
    if (raw.includes('已停用') || raw.includes('停用') || raw.includes('掉车')) status = '已停用';

    let card_bind_date = '';
    let days_remaining = null;
    const dateMatch = raw.match(/(?:绑定|激活)?(?:日期|时间)[：:]\s*(\d{4}[-/]\d{2}[-/]\d{2})/);
    if (dateMatch) card_bind_date = dateMatch[1].replace(/\//g, '-');
    const daysMatch = raw.match(/(?:剩余|还有)\s*(\d+)\s*天/);
    if (daysMatch) days_remaining = parseInt(daysMatch[1], 10);
    if (!days_remaining && card_bind_date) {
      const bindMs = new Date(card_bind_date).getTime();
      const elapsed = Math.floor((Date.now() - bindMs) / 86400000);
      days_remaining = Math.max(0, 25 - elapsed);
    }

    return { bound_email, status, card_bind_date: card_bind_date || null, days_remaining, raw_text: raw.substring(0, 500) };
  } finally {
    await context?.close().catch(() => {});
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function activate(mode, cardKey, email, activationUrl = 'team.654301.xyz') {
  const baseUrl = activationUrl.replace(/^https?:\/\//, '');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activate_'));
  const config = loadConfig();
  const opts = getLaunchOptions(config);
  let context = null;

  try {
    context = await firefox.launchPersistentContext(tempDir, {
      headless: process.env.ACTIVATE_HEADLESS === '1',
      slowMo: 300,
      timeout: 60000,
      ...opts,
    });
    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(FIREFOX_STEALTH_SCRIPT);

    console.log('🌐 Opening activation site...');
    await page.goto(`https://${baseUrl}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);

    if (mode === 'warranty') {
      // Click 质保激活 tab via DOM (el-tabs__item)
      console.log('🔧 Switching to 质保激活 tab...');
      const tabClicked = await page.evaluate(() => {
        const tabs = document.querySelectorAll('.el-tabs__item');
        for (const tab of tabs) {
          if (tab.textContent?.trim() === '质保激活') {
            tab.click();
            return true;
          }
        }
        return false;
      });
      console.log(`  Tab clicked: ${tabClicked}`);
      await sleep(2000);

      // Fill card key in the visible input
      console.log(`🔑 Card key: ${cardKey}`);
      await page.evaluate((key) => {
        const inputs = document.querySelectorAll('input[placeholder="请输入卡密"]');
        for (const inp of inputs) {
          if (inp.offsetParent !== null) {
            const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSet.call(inp, key);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, cardKey);
      await sleep(1000);

      // Click 提交激活
      console.log('📤 Submitting...');
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent?.trim() === '提交激活' && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      await sleep(3000);

    } else {
      // REDEEM mode — 首次兑换 (default tab, already visible)
      console.log(`🔑 Card key: ${cardKey}`);
      console.log(`📧 Email: ${email}`);

      // Fill email/card for both old and new activation pages.
      const fillResult = await page.evaluate(({ key, addr }) => {
        const visibleInputs = Array.from(document.querySelectorAll('input')).filter(
          (inp) => inp.offsetParent !== null
        );
        if (!visibleInputs.length) return { ok: false, reason: 'no_visible_input' };

        const setValue = (inp, value) => {
          const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSet) nativeSet.call(inp, value);
          else inp.value = value;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        };

        const cardInputs = [];
        const emailInputs = [];
        for (const inp of visibleInputs) {
          const p = (inp.getAttribute('placeholder') || '').toLowerCase();
          const n = (inp.getAttribute('name') || '').toLowerCase();
          const id = (inp.getAttribute('id') || '').toLowerCase();
          const hint = `${p} ${n} ${id}`;
          if (hint.includes('卡密') || hint.includes('激活') || hint.includes('兑换码')) cardInputs.push(inp);
          if (hint.includes('email') || hint.includes('邮箱') || hint.includes('mail')) emailInputs.push(inp);
        }

        if (emailInputs.length >= 2) {
          setValue(emailInputs[0], addr);
          setValue(emailInputs[1], addr);
        } else if (emailInputs.length === 1) {
          setValue(emailInputs[0], addr);
        } else if (visibleInputs.length >= 3) {
          // New page commonly has [email, confirm_email, card]
          setValue(visibleInputs[0], addr);
          setValue(visibleInputs[1], addr);
        }

        if (cardInputs.length >= 1) {
          setValue(cardInputs[0], key);
        } else if (visibleInputs.length >= 3) {
          setValue(visibleInputs[2], key);
        } else if (visibleInputs.length === 2 && emailInputs.length === 0) {
          // codextm 等：仅两个输入框（邮箱 + 兑换码），无 placeholder 时
          setValue(visibleInputs[0], addr);
          setValue(visibleInputs[1], key);
        } else {
          setValue(visibleInputs[visibleInputs.length - 1], key);
        }

        return { ok: true, total: visibleInputs.length };
      }, { key: cardKey, addr: email });
      console.log(`  Fill result: ${JSON.stringify(fillResult)}`);
      await sleep(500);

      // Click submit on both old/new pages
      console.log('📤 Submitting...');
      const submitClicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const t = btn.textContent?.trim() || '';
          if (
            btn.offsetParent !== null &&
            (t === '提交兑换' || t === '提交激活' || t === '确认激活' || t === '立即激活' || t === '激活' || t === '验证并兑换' || t.includes('验证并兑换'))
          ) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      console.log(`  Submit clicked: ${submitClicked}`);
      await sleep(3000);
    }

    // Handle dialogs for up to 15 seconds
    for (let i = 0; i < 5; i++) {
      const dialogResult = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent?.trim() || '';
          if (btn.offsetParent !== null) {
            if (text === '我知道了') { btn.click(); return 'ok_clicked'; }
            if (text === '不更换，直接激活') { btn.click(); return 'keep_email'; }
            if (text === '仍然使用原邮箱') { btn.click(); return 'use_original'; }
          }
        }
        return null;
      });

      if (dialogResult) {
        console.log(`📋 Dialog: ${dialogResult}`);
        if (dialogResult === 'ok_clicked') break;
        await sleep(2000);
        continue;
      }
      await sleep(2000);
    }

    // Capture page text for result
    await sleep(1000);
    const resultText = await page.evaluate(() => {
      const modals = document.querySelectorAll('.el-message-box, .el-dialog, .el-message, [class*="modal"], [class*="toast"]');
      for (const m of modals) {
        if (m.offsetParent !== null) return m.textContent?.trim().substring(0, 300) || '';
      }
      return '';
    });

    const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const combined = `${resultText}\n${bodySnippet}`;
    const hasFail = /失败|无效|已过期|不存在|错误|error/i.test(combined);
    const hasSuccess = /成功|已激活|激活完成|完成激活|提交成功|兑换成功|邀请已发送|已提交|加入.*Team|Team.*加入/i.test(combined);
    const success = hasSuccess && !hasFail;

    console.log(`\n${success ? '✅' : '❌'} Result: ${resultText || bodySnippet.substring(0, 200)}`);
    return { success, message: resultText || bodySnippet.substring(0, 200) };

  } finally {
    await context?.close().catch(() => {});
    try { await sleep(500); if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const mode = process.argv[2];
  const cardKey = process.argv[3];
  const email = process.argv[4] || '';
  const activationUrl = process.argv[5] || 'team.654301.xyz';
  if (!mode || !cardKey || (mode === 'redeem' && !email)) {
    console.log('Usage:\n  node activate_account.js redeem <card_key> <email> [activation_url]\n  node activate_account.js warranty <card_key> [activation_url]\n  node activate_account.js query <card_key> [activation_url]');
    process.exit(1);
  }
  if (mode === 'query') {
    const result = await queryActivation(cardKey, activationUrl);
    process.stdout.write('\n' + JSON.stringify(result) + '\n');
    return;
  }
  const result = await activate(mode, cardKey, email, activationUrl);
  process.stdout.write('\n' + JSON.stringify(result) + '\n');
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
