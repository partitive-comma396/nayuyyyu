/**
 * ChatGPT Account Creator - with US proxy support and anti-detection.
 * Based on wahdalo/chatgpt-account-creator.
 */

import { firefox } from 'playwright';

export class CaptchaDetectedError extends Error {
  constructor(message = 'CAPTCHA detected') {
    super(message);
    this.name = 'CaptchaDetectedError';
  }
}
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import * as cheerio from 'cheerio';
import { faker } from '@faker-js/faker';
import crypto from 'crypto';
import {
  getLaunchOptions,
  FIREFOX_STEALTH_SCRIPT,
  getRandomDelay,
  getBetweenAccountsDelaySec,
} from './anti-detect.js';

class ChatGPTAccountCreator {
 constructor() {
 this.accountsFile = 'accounts.txt';
 this.createdAccounts = [];
 this.configFile = 'config.json';
 this.config = this.loadConfig();
 this.currentProgress = null;
 }

 log(message, level = null) {
 const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
 let label;
 if (this.currentProgress) {
 label = this.currentProgress;
 } else if (level) {
 label = level;
 } else {
 label = "INFO";
 }
 const logMessage = `[${timestamp}] [${label}] ${message}`;
 console.log(logMessage);
 }

 loadConfig() {
 const defaultConfig = {
 max_workers: 3,
 headless: false,
 slow_mo: 1000,
 timeout: 30000,
 password: null
 };

 try {
 if (fs.existsSync(this.configFile)) {
 const configData = fs.readFileSync(this.configFile, 'utf-8');
 const config = JSON.parse(configData);
 Object.assign(defaultConfig, config);

 if (defaultConfig.password) {
 const password = defaultConfig.password;
 if (password.length < 12) {
 this.log(`⚠️ Warning: Password in config.json is less than 12 characters. ChatGPT requires at least 12 characters.`, "WARNING");
 }
 }

 return defaultConfig;
 } else {
 fs.writeFileSync(this.configFile, JSON.stringify(defaultConfig, null, 2), 'utf-8');
 this.log(`📝 Created default config file: ${this.configFile}`);
 return defaultConfig;
 }
 } catch (e) {
 this.log(`⚠️ Error loading config: ${e.message}, using defaults`, "WARNING");
 return defaultConfig;
 }
 }

 generatePassword() {
 const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
 const lower = 'abcdefghijklmnopqrstuvwxyz';
 const digits = '0123456789';
 const symbols = '!@#$%^&*';
 const all = upper + lower + digits + symbols;
 const pick = (s) => s[crypto.randomInt(s.length)];
 let pw = [pick(upper), pick(lower), pick(digits), pick(symbols)];
 for (let i = 0; i < 12; i++) pw.push(pick(all));
 for (let i = pw.length - 1; i > 0; i--) {
   const j = crypto.randomInt(i + 1);
   [pw[i], pw[j]] = [pw[j], pw[i]];
 }
 return pw.join('');
 }

 randstr(length) {
 const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
 let result = '';
 for (let i = 0; i < length; i++) {
 result += chars.charAt(Math.floor(Math.random() * chars.length));
 }
 return result;
 }

 async generateRandomEmail() {
 const res = await fetch('https://generator.email/', {
   method: 'get',
   headers: {
     accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3',
     'accept-encoding': 'gzip, deflate, br'
   }
 });
 const text = await res.text();
 const $ = cheerio.load(text);
 const domains = [];
 $('.e7m.tt-suggestions').find('div > p').each(function (index, element) {
   domains.push($(element).text());
 });

 if (domains.length === 0) {
   throw new Error('No domains found from generator.email');
 }

 const domain = domains[Math.floor(Math.random() * domains.length)];
 const firstName = faker.person.firstName().replace(/["']/g, '');
 const lastName = faker.person.lastName().replace(/["']/g, '');
 const randomStr = this.randstr(5);
 const email = `${firstName}${lastName}${randomStr}@${domain}`.toLowerCase();

 this.log(`📧 Generated email: ${email}`);
 return { email, firstName, lastName };
 }

 generateRandomName(firstName, lastName) {
 if (firstName && lastName) {
 return `${firstName} ${lastName}`;
 }
 const fn = faker.person.firstName().replace(/["']/g, '');
 const ln = faker.person.lastName().replace(/["']/g, '');
 return `${fn} ${ln}`;
 }

 generateRandomBirthday() {
 const today = new Date();
 const minYear = today.getFullYear() - 65;
 const maxYear = today.getFullYear() - 18;

 const year = Math.floor(Math.random() * (maxYear - minYear + 1)) + minYear;
 const month = Math.floor(Math.random() * 12) + 1;

 let maxDay;
 if ([1, 3, 5, 7, 8, 10, 12].includes(month)) {
 maxDay = 31;
 } else if ([4, 6, 9, 11].includes(month)) {
 maxDay = 30;
 } else {
 if (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) {
 maxDay = 29;
 } else {
 maxDay = 28;
 }
 }

 const day = Math.floor(Math.random() * maxDay) + 1;

 return { year, month, day };
 }

 saveAccount(email, password) {
 try {
 this.createdAccounts.push({ email, password });
 fs.appendFileSync(this.accountsFile, `${email}|${password}\n`, 'utf-8');
 this.log(`💾 Saved account to ${this.accountsFile}: ${email}`);
 } catch (e) {
 this.log(`❌ Error saving account: ${e.message}`, "ERROR");
 }
 }

 async getVerificationCode(email, maxRetries = 5, delay = 2) {
 const [username, domain] = email.split('@');

 for (let attempt = 0; attempt < maxRetries; attempt++) {
 try {
 const response = await fetch('https://generator.email/', {
 method: 'GET',
 headers: {
 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
 'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
 'cookie': `surl=${domain}/${username}`,
 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
 },
 redirect: 'follow'
 });

 const text = await response.text();
 const $ = cheerio.load(text);

 const otpText = $("#email-table > div.e7m.list-group-item.list-group-item-info > div.e7m.subj_div_45g45gg").text().trim();

 if (otpText && otpText.length > 0) {
 const codeMatch = otpText.match(/\d{6}/);
 if (codeMatch) {
 const code = codeMatch[0];
 this.log(`✅ Retrieved verification code: ${code}`);
 return code;
 } else if (/^\d+$/.test(otpText)) {
 this.log(`✅ Retrieved verification code: ${otpText}`);
 return otpText;
 }
 }

 if (attempt < maxRetries - 1) {
 this.log(`⏳ Code not found, waiting ${delay}s before retry ${attempt + 1}/${maxRetries}...`);
 await this.sleep(delay * 1000);
 }

 } catch (e) {
 this.log(`⚠️ Error fetching verification code (attempt ${attempt + 1}): ${e.message}`, "WARNING");
 if (attempt < maxRetries - 1) {
 await this.sleep(delay * 1000);
 }
 }
 }

 this.log(`❌ Failed to get verification code after ${maxRetries} attempts`, "ERROR");
 return null;
 }

 sleep(ms) {
 return new Promise(resolve => setTimeout(resolve, ms));
 }

 randomFloat(min, max) {
 return Math.random() * (max - min) + min;
 }

 async createAccount(accountNumber, totalAccounts, proxyOverride = null) {
  this.currentProgress = `${accountNumber}/${totalAccounts}`;

  let emailData;
 try {
   emailData = await this.generateRandomEmail();
 } catch (e) {
   this.log(`❌ Failed to generate email: ${e.message}`, "ERROR");
   return false;
 }
 const { email, firstName, lastName } = emailData;

 const password = this.config.password || this.generatePassword();

 if (password.length < 12) {
 this.log(`⚠️ Warning: Password is only ${password.length} characters. ChatGPT requires at least 12 characters.`, "WARNING");
 }

 const name = this.generateRandomName(firstName, lastName);
 const birthday = this.generateRandomBirthday();

 const uniqueId = uuidv4().substring(0, 8);
 const timestamp = Date.now();
 const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `chatgpt_browser_${accountNumber}_${timestamp}_${uniqueId}_`));

 let context = null;

  const configForLaunch = proxyOverride != null ? { ...this.config, proxy: proxyOverride } : this.config;
  const slowMo = proxyOverride != null ? Math.floor(600 + Math.random() * 200) : (this.config.slow_mo || 1000);

  try {
  const launchOpts = getLaunchOptions(configForLaunch);
  context = await firefox.launchPersistentContext(tempDir, {
    headless: this.config.headless !== false,
    slowMo,
    timeout: this.config.timeout || 45000,
    ...launchOpts,
  });

 const pages = context.pages();
 const page = pages.length > 0 ? pages[0] : await context.newPage();
 await page.addInitScript(FIREFOX_STEALTH_SCRIPT);

 // Step 1: Navigate to ChatGPT
 try {
 await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
 await this.sleep(2000);
 } catch (e) {
 this.log(`❌ Error navigating to ChatGPT: ${e.message}`, "ERROR");
 return false;
 }

 // Click Sign up button using semantic selector
 this.log("🔘 Processing 'Sign up'");
 try {
 const signupButton = page.getByRole('button', { name: /sign up/i }).first();
 await signupButton.waitFor({ state: 'visible', timeout: 30000 });
 await this.sleep(3000);
 await signupButton.click({ timeout: 10000 });
 await this.sleep(this.randomFloat(1000, 2000));

 // Check for CAPTCHA
 const hasCaptcha = await page.locator('iframe[src*="captcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], [class*="captcha"]').count();
 if (hasCaptcha > 0) {
   this.log('⚠️ CAPTCHA detected on signup page.', 'WARNING');
   await this.sleep(30000);
   const stillCaptcha = await page.locator('iframe[src*="captcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], [class*="captcha"]').count();
   if (stillCaptcha > 0) {
     throw new CaptchaDetectedError('CAPTCHA still present after 30s wait');
   }
 }

 try {
 const emailInputCheck = page.getByRole('textbox', { name: /email/i });
 await emailInputCheck.waitFor({ state: 'visible', timeout: 5000 });
 } catch {
 this.log("⚠️ Dialog might not have appeared, continuing anyway...", "WARNING");
 }

 } catch (e) {
 this.log(`❌ Error processing signup: ${e.message}`, "ERROR");
 return false;
 }

 // Fill email
 try {
 const emailInput = page.getByRole('textbox', { name: /email/i });
 await emailInput.waitFor({ state: 'visible', timeout: 15000 });

 await emailInput.fill(email);
 await emailInput.blur();

 await this.sleep(this.randomFloat(2000, 3000));

 const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
 await continueButton.waitFor({ state: 'visible', timeout: 10000 });

 const isEnabled = await continueButton.isEnabled();
 if (!isEnabled) {
 this.log("⏳ Continue button not enabled yet, waiting for validation...");
 await this.sleep(2000);
 }

 await this.sleep(this.randomFloat(500, 1000));

 } catch (e) {
 this.log(`❌ Error filling email: ${e.message}`, "ERROR");
 return false;
 }

 // Click Continue
 try {
 const continueButton = page.getByRole('button', { name: 'Continue', exact: true });

 await Promise.all([
 page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { }),
 continueButton.click({ timeout: 10000 })
 ]);

 await this.sleep(1000);

 const currentUrl = page.url();

 if (currentUrl.toLowerCase().includes('password') || currentUrl.toLowerCase().includes('auth.openai.com')) {
 this.log(`✅ Setting up password`);
 } else if (currentUrl.toLowerCase().includes('error')) {
 return false;
 }

 } catch (e) {
 const currentUrl = page.url();
 if (currentUrl.toLowerCase().includes('error')) {
 return false;
 } else {
 await this.sleep(2000);
 const newUrl = page.url();
 if (newUrl.toLowerCase().includes('error')) {
 return false;
 } else if (!newUrl.toLowerCase().includes('password')) {
 return false;
 }
 }
 }

 // Fill password
 try {
 const passwordInput = page.getByRole('textbox', { name: /password/i });
 await passwordInput.waitFor({ state: 'visible', timeout: 15000 });

 await passwordInput.fill(password);
 await this.sleep(this.randomFloat(1000, 2000));
 } catch (e) {
 this.log(`❌ Error filling password: ${e.message}`, "ERROR");
 return false;
 }

 // Click Continue after password
 try {
 let continueButton = page.getByRole('button', { name: 'Continue' });
 await continueButton.waitFor({ state: 'visible', timeout: 15000 });

 const isEnabled = await continueButton.isEnabled();
 if (!isEnabled) {
 this.log("⏳ Button not enabled yet, waiting...");
 await this.sleep(2000);
 }

 const box = await continueButton.boundingBox();
 if (box) {
 await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
 await this.sleep(this.randomFloat(300, 700));
 }

 try {
 await Promise.all([
 page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { }),
 continueButton.click({ timeout: 10000 })
 ]);
 await this.sleep(this.randomFloat(2000, 3000));
 } catch {
 await continueButton.click({ timeout: 10000 });
 await this.sleep(this.randomFloat(2000, 3000));
 }
 } catch (e) {
 this.log(`❌ Error clicking Continue: ${e.message}`, "ERROR");
 return false;
 }

 // Wait for verification code
 this.log("⏳ Waiting for verification code...");
 await this.sleep(8000);

 const verificationCode = await this.getVerificationCode(email);

 if (!verificationCode) {
 this.log(`❌ Failed to get verification code for ${email}`, "ERROR");
 return false;
 }

 // Enter verification code
 try {
 const codeInput = page.getByRole('textbox', { name: /code/i });
 await codeInput.fill(verificationCode);
 await this.sleep(500);
 } catch (e) {
 this.log(`❌ Error entering code: ${e.message}`, "ERROR");
 return false;
 }

 // Click Continue after code
 try {
 const continueButton = page.getByRole('button', { name: 'Continue' });
 await continueButton.click({ timeout: 10000 });
 await this.sleep(3000);
 } catch (e) {
 this.log(`❌ Error after code: ${e.message}`, "ERROR");
 return false;
 }

 // Fill name
 try {
 const nameInput = page.getByRole('textbox', { name: /name/i });
 await nameInput.fill(name);
 await this.sleep(500);
 } catch (e) {
 this.log(`❌ Error filling name: ${e.message}`, "ERROR");
 return false;
 }

 // Handle birthday
 const monthNum = birthday.month;
 const dayNum = birthday.day;
 const yearNum = birthday.year;

 this.log(`🎂 Setting birthday: ${monthNum}/${dayNum}/${yearNum}`);

 try {
 await this.sleep(1000);

 const monthStr = String(monthNum).padStart(2, '0');
 const dayStr = String(dayNum).padStart(2, '0');
 const yearStr = String(yearNum);
 const birthdayString = `${monthStr}${dayStr}${yearStr}`;

 const monthSpin = page.locator('[role="spinbutton"]').first();

 if (await monthSpin.isVisible({ timeout: 5000 })) {
 await monthSpin.click();
 await this.sleep(300);
 await page.keyboard.type(birthdayString, { delay: 100 });
 await this.sleep(500);
 } else {
 throw new Error('Birthday field not found');
 }
 } catch (birthdayError) {
 this.log(`❌ Error setting birthday: ${birthdayError.message}`, "ERROR");
 return false;
 }

 // Click final button to complete signup (may be "Continue", "Agree", "I agree", etc.)
 try {
 await this.sleep(1000);
 const candidates = [
   page.getByRole('button', { name: 'Continue' }),
   page.getByRole('button', { name: /agree/i }),
   page.getByRole('button', { name: /create/i }),
   page.getByRole('button', { name: /submit/i }),
   page.getByRole('button', { name: /sign up/i }),
 ];

 let clicked = false;
 for (const btn of candidates) {
   try {
     if (await btn.isVisible({ timeout: 2000 })) {
       const isEnabled = await btn.isEnabled();
       if (!isEnabled) await this.sleep(2000);
       this.log(`🔘 Clicking: ${await btn.textContent()}`);
       await Promise.all([
         page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
         btn.click({ timeout: 10000 }),
       ]);
       clicked = true;
       break;
     }
   } catch { /* try next */ }
 }

 if (!clicked) {
   this.log('⚠️ No final button found, trying any visible button...', 'WARNING');
   const allBtns = await page.getByRole('button').all();
   for (const btn of allBtns) {
     const text = (await btn.textContent() || '').trim().toLowerCase();
     if (text && !text.includes('back') && !text.includes('cancel')) {
       this.log(`🔘 Fallback clicking: ${text}`);
       await btn.click({ timeout: 5000 }).catch(() => {});
       clicked = true;
       break;
     }
   }
 }

 await this.sleep(3000);
 } catch (e) {
 this.log(`❌ Error on final step: ${e.message}`, "ERROR");
 return false;
 }

 // Handle post-signup pages (about-you, onboarding, etc.)
 for (let step = 0; step < 5; step++) {
 const currentUrl = page.url();
 this.log(`📍 Post-signup URL: ${currentUrl}`);

 if (currentUrl.includes('chatgpt.com') && !currentUrl.includes('auth.openai.com')) {
   this.log(`✅ Account created successfully!`);
   this.saveAccount(email, password);
   return true;
 }

 // "About you" page — select option then click finish
 if (currentUrl.includes('about-you') || currentUrl.includes('onboarding')) {
   this.log('📋 Handling about-you page...');
   try {
     // Select a radio/option if present (e.g. "What do you use ChatGPT for?")
     const radios = await page.getByRole('radio').all();
     if (radios.length > 0) {
       const idx = Math.floor(Math.random() * radios.length);
       await radios[idx].click().catch(() => {});
       this.log(`🔘 Selected option ${idx + 1}/${radios.length}`);
       await this.sleep(500);
     }
     // Try combobox/select
     const selects = await page.locator('select').all();
     for (const sel of selects) {
       const opts = await sel.locator('option').all();
       if (opts.length > 1) {
         await sel.selectOption({ index: 1 }).catch(() => {});
         this.log('🔘 Selected dropdown option');
         await this.sleep(500);
       }
     }
     // Click buttons that look like options (common pattern)
     const optBtns = await page.locator('[data-testid], [role="option"]').all();
     if (optBtns.length > 0 && radios.length === 0) {
       const idx = Math.floor(Math.random() * Math.min(optBtns.length, 4));
       await optBtns[idx].click().catch(() => {});
       this.log(`🔘 Clicked option element`);
       await this.sleep(500);
     }

     await this.sleep(1000);

     // Now click the submit/finish button
     const finishBtns = [
       page.getByRole('button', { name: /finish/i }),
       page.getByRole('button', { name: /continue/i }),
       page.getByRole('button', { name: /skip/i }),
       page.getByRole('button', { name: /next/i }),
       page.getByRole('button', { name: /done/i }),
       page.getByRole('button', { name: /submit/i }),
     ];
     for (const btn of finishBtns) {
       try {
         if (await btn.isVisible({ timeout: 1500 })) {
           const enabled = await btn.isEnabled();
           if (enabled) {
             this.log(`🔘 Clicking: ${await btn.textContent()}`);
             await Promise.all([
               page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
               btn.click({ timeout: 5000 }),
             ]);
             break;
           }
         }
       } catch { /* try next */ }
     }
     await this.sleep(3000);
   } catch (e) {
     this.log(`⚠️ About-you step error: ${e.message}`, 'WARNING');
     await this.sleep(2000);
   }
   continue;
 }

 // Auth page still — wait and retry
 if (currentUrl.includes('auth.openai.com')) {
   await this.sleep(3000);
   continue;
 }

 // Unknown page
 await this.sleep(2000);
 }

 // Final check
 try {
 const finalUrl = page.url();
 if (finalUrl.includes('chatgpt.com')) {
   this.log(`✅ Account created successfully!`);
   this.saveAccount(email, password);
   return true;
 }
 // Even if we didn't land on chatgpt.com, the account IS created if we got past verification
 this.log(`⚠️ Final URL: ${finalUrl}. Account likely created, saving.`, 'WARNING');
 this.saveAccount(email, password);
 return true;
 } catch (e) {
 this.log(`❌ Error verifying: ${e.message}`, "ERROR");
 return false;
 }

 } catch (e) {
  if (e instanceof CaptchaDetectedError) throw e;
  this.log(`❌ Unexpected error: ${e.message}`, "ERROR");
  return false;
 } finally {
 try {
 await context?.close().catch(() => {});
 } catch { /* ignore */ }
 try {
 await this.sleep(500);
 if (fs.existsSync(tempDir)) {
 fs.rmSync(tempDir, { recursive: true, force: true });
 }
 } catch { /* ignore cleanup errors */ }
 }
 }

 async createAccounts(numAccounts) {
 console.log(`🚀 Starting account creation for ${numAccounts} accounts...`);

 let successful = 0;
 let failed = 0;

 for (let accountNum = 1; accountNum <= numAccounts; accountNum++) {
 this.currentProgress = `${accountNum}/${numAccounts}`;

 try {
 const success = await this.createAccount(accountNum, numAccounts);

 if (success) {
 successful++;
 this.log(`✅ Account completed successfully\n`);
 } else {
 failed++;
 this.log(`❌ Account failed\n`);
 }

 if (accountNum < numAccounts) {
 const delaySec = getBetweenAccountsDelaySec(this.config.anti_detect);
 this.log(`⏳ Anti-detect: waiting ${delaySec}s before next account...`);
 await this.sleep(delaySec * 1000);
 }

 } catch (e) {
 this.log(`💥 Error: ${e.message}\n`);
 failed++;
 }
 }

 this.currentProgress = null;

 this.printSummary(successful, failed);
 if (process.env.OUTPUT_JSON === '1') {
 console.log(JSON.stringify({ accounts: this.createdAccounts }));
 }
 return this.createdAccounts;
 }

 printSummary(successful, failed) {
 console.log("\n" + "=".repeat(60));
 console.log("📊 ACCOUNT CREATION SUMMARY");
 console.log("=".repeat(60));
 console.log(`✅ Successful: ${successful}`);
 console.log(`❌ Failed: ${failed}`);
 console.log(`📝 Total accounts saved: ${this.createdAccounts.length}`);
 console.log(`💾 Accounts saved to: ${this.accountsFile}`);

 if (this.createdAccounts.length > 0) {
 console.log("\n✅ CREATED ACCOUNTS:");
 this.createdAccounts.forEach((account, i) => {
 console.log(` ${i + 1}. ${account.email}`);
 });
 }

 console.log("=".repeat(60));
 }
}

async function main() {
 const registerCount = process.env.REGISTER_COUNT ? parseInt(process.env.REGISTER_COUNT, 10) : null;
 const outputJson = process.env.OUTPUT_JSON === '1';

 console.log("🤖 ChatGPT Account Creator (anti-detect + proxy)");
 console.log("=".repeat(60));
 const creator = new ChatGPTAccountCreator();
 console.log(`⚙️ Configuration loaded`);
 if (creator.config.proxy) console.log(` 🌐 Proxy: ${creator.config.proxy}`);
 console.log();

 if (registerCount !== null && !isNaN(registerCount) && registerCount > 0) {
   console.log(`🚀 Creating ${registerCount} account(s) (REGISTER_COUNT env)...\n`);
   await creator.createAccounts(registerCount);
   if (outputJson) process.stdout.write(JSON.stringify({ accounts: creator.createdAccounts }) + '\n');
   return;
 }

 const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
 try {
   const answer = await new Promise((resolve) => {
     rl.question("\n📝 How many accounts do you want to create? ", resolve);
   });
   const numAccounts = parseInt(answer, 10);
   if (isNaN(numAccounts) || numAccounts <= 0) {
     console.log("❌ Please enter a positive number!");
     rl.close();
     return;
   }
   console.log(`\n🚀 Starting creation of ${numAccounts} account(s)...\n`);
   await creator.createAccounts(numAccounts);
 } catch (e) {
   if (e && e.message === 'readline was closed') {
     console.log("\n\n🛑 Script interrupted (Ctrl+C). Progress saved to accounts.txt");
   } else if (e) console.log(`\n❌ Error: ${e.message}`);
 } finally {
   rl.close();
 }
}

export { ChatGPTAccountCreator };

process.on('SIGINT', () => {
 console.log("\n\n🛑 Interrupted. Progress saved to accounts.txt");
 process.exit(0);
});

// Guard: only run main() when executed directly, not when imported
const isDirectRun = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1].endsWith('chatgpt_account_creator.js')
);
if (isDirectRun) {
  main().catch(console.error);
}
