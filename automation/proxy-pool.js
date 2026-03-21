#!/usr/bin/env node
/**
 * 免费代理池：抓取、验证、轮换。
 * 数据源：ProxyScrape API、iplocate/free-proxy-list
 * 当代理耗尽时回退到直连。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'proxy-cache.json');
const TEST_TIMEOUT_MS = 6000;
const FETCH_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), opts.timeout ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    return res;
  } finally {
    clearTimeout(tid);
  }
}

function parseProxyLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  const m = s.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
  if (m) return `http://${m[1]}:${m[2]}`;
  const m2 = s.match(/^(\S+):(\d+)$/);
  if (m2) return `http://${m2[1]}:${m2[2]}`;
  return null;
}

export class ProxyPool {
  constructor(opts = {}) {
    this.proxies = [];
    this.badProxies = new Set();
    this._index = 0;
    this._initialized = false;
    this.opts = opts;
  }

  get availableCount() {
    return this.proxies.filter((p) => !this.badProxies.has(p)).length;
  }

  async _fetchFromProxyScrape() {
    const url =
      'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all';
    try {
      const res = await fetchWithTimeout(url);
      const text = await res.text();
      const lines = text.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
      return [...new Set(lines)];
    } catch (e) {
      console.error('[ProxyPool] ProxyScrape fetch failed:', e.message);
      return [];
    }
  }

  async _fetchFromGitHub() {
    const urls = [
      'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
      'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    ];
    const all = [];
    for (const url of urls) {
      try {
        const res = await fetchWithTimeout(url);
        const text = await res.text();
        const lines = text.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
        all.push(...lines);
      } catch (e) {
        // ignore
      }
    }
    return [...new Set(all)];
  }

  async _validateProxy(proxyUrl) {
    const net = (await import('net')).default;
    const m = proxyUrl.match(/^https?:\/\/([^:]+):(\d+)/);
    if (!m) return false;
    const [, host, portStr] = m;
    const port = parseInt(portStr, 10);
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(TEST_TIMEOUT_MS);
      sock.on('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => {
        sock.destroy();
        resolve(false);
      });
      sock.connect(port, host);
    });
  }

  async _validateProxiesConcurrent(proxyList, concurrency = 8) {
    const results = [];
    const list = proxyList.filter((p) => p && !this.badProxies.has(p));
    for (let i = 0; i < list.length; i += concurrency) {
      const chunk = list.slice(i, i + concurrency);
      const okList = await Promise.all(
        chunk.map((p) => this._validateProxy(p).then((ok) => (ok ? p : null)).catch(() => null))
      );
      results.push(...okList.filter(Boolean));
    }
    return results;
  }

  _loadCache() {
    try {
      if (fs.existsSync(CACHE_PATH)) {
        const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        if (Array.isArray(data.proxies) && data.proxies.length > 0) {
          const maxAge = (this.opts.cacheMaxAgeHours ?? 2) * 3600 * 1000;
          if (Date.now() - (data.fetchedAt || 0) < maxAge) {
            return data.proxies;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  _saveCache(proxies) {
    try {
      fs.writeFileSync(
        CACHE_PATH,
        JSON.stringify({ proxies, fetchedAt: Date.now() }, null, 2),
        'utf-8'
      );
    } catch (e) {}
  }

  async init() {
    if (this._initialized) return;
    const cached = this._loadCache();
    if (cached && cached.length >= 5) {
      this.proxies = cached;
      this._initialized = true;
      console.error(`[ProxyPool] Loaded ${cached.length} cached proxies`);
      return;
    }
    console.error('[ProxyPool] Fetching proxies...');
    const [scrape, github] = await Promise.all([
      this._fetchFromProxyScrape(),
      this._fetchFromGitHub(),
    ]);
    const combined = [...new Set([...scrape, ...github])];
    if (combined.length === 0) {
      console.error('[ProxyPool] No proxies fetched, will use direct connection');
      this._initialized = true;
      return;
    }
    const shuffled = combined.sort(() => Math.random() - 0.5).slice(0, 80);
    const valid = await this._validateProxiesConcurrent(shuffled, 8);
    this.proxies = valid;
    if (valid.length > 0) this._saveCache(valid);
    console.error(`[ProxyPool] Validated ${valid.length}/${shuffled.length} proxies`);
    this._initialized = true;
  }

  getNextProxy() {
    const ok = this.proxies.filter((p) => !this.badProxies.has(p));
    if (ok.length === 0) return null;
    const idx = this._index % ok.length;
    this._index += 1;
    return ok[idx];
  }

  markBad(proxy) {
    this.badProxies.add(proxy);
  }

  async getNextOrInit() {
    await this.init();
    return this.getNextProxy();
  }
}

export const defaultProxyPool = new ProxyPool();
