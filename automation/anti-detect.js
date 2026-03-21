/**
 * Anti-detection / anti-ban module for browser automation.
 * - Random viewport & device fingerprint
 * - Human-like delays
 * - Stealth script for Firefox (webdriver, plugins, Canvas, WebGL, etc.)
 * - Proxy support for US IP
 */

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1200 },
  { width: 1536, height: 960 },
  { width: 1280, height: 800 },
];

const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Anchorage',
];

const LOCALES = [
  { locale: 'en-US', weight: 90 },
  { locale: 'en-GB', weight: 5 },
  { locale: 'en-CA', weight: 5 },
];

const DEVICE_SCALE_FACTORS = [1, 1.25, 1.5, 2];

const HARDWARE_CONCURRENCY_OPTIONS = [4, 6, 8, 12, 16];
const DEVICE_MEMORY_OPTIONS = [4, 8, 16];

function pickByWeight(items) {
  const total = items.reduce((s, i) => s + (i.weight || 1), 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight || 1;
    if (r <= 0) return item;
  }
  return items[0];
}

export function getRandomViewport() {
  const i = Math.floor(Math.random() * VIEWPORTS.length);
  return { ...VIEWPORTS[i] };
}

export function getRandomTimeZone() {
  return US_TIMEZONES[Math.floor(Math.random() * US_TIMEZONES.length)];
}

export function getRandomLocale() {
  const item = pickByWeight(LOCALES);
  return item.locale;
}

export function getRandomDeviceScaleFactor() {
  return DEVICE_SCALE_FACTORS[Math.floor(Math.random() * DEVICE_SCALE_FACTORS.length)];
}

export function getRandomHardwareConcurrency() {
  return HARDWARE_CONCURRENCY_OPTIONS[Math.floor(Math.random() * HARDWARE_CONCURRENCY_OPTIONS.length)];
}

export function getRandomDeviceMemory() {
  return DEVICE_MEMORY_OPTIONS[Math.floor(Math.random() * DEVICE_MEMORY_OPTIONS.length)];
}

export function getRandomDelay(minMs, maxMs) {
  const min = minMs ?? 800;
  const max = maxMs ?? 2500;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getBetweenAccountsDelaySec(antiDetectConfig) {
  const cfg = antiDetectConfig || {};
  const min = cfg.between_accounts_min_s ?? 15;
  const max = cfg.between_accounts_max_s ?? 35;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getBatchBetweenAccountsDelaySec(antiDetectConfig) {
  const cfg = antiDetectConfig || {};
  const min = cfg.batch_between_accounts_min_s ?? 45;
  const max = cfg.batch_between_accounts_max_s ?? 120;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const FIREFOX_STEALTH_SCRIPT = `
(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'plugins', {
    get: () => ({ length: 3, item: () => null, namedItem: () => null, refresh: () => {} }),
    configurable: true
  });
  var _langs = ['en-US', 'en'];
  Object.defineProperty(navigator, 'languages', { get: () => _langs, configurable: true });
  var _hw = [4,6,8,12,16][Math.floor(Math.random()*5)];
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => _hw, configurable: true });
  var _mem = [4,8,16][Math.floor(Math.random()*3)];
  Object.defineProperty(navigator, 'deviceMemory', { get: () => _mem, configurable: true });
  var origQ = window.navigator.permissions?.query;
  if (origQ) {
    window.navigator.permissions.query = function(p) {
      return p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQ(p);
    };
  }
  var origGetParameter = WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter;
  if (origGetParameter) {
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return origGetParameter.apply(this, arguments);
    };
  }
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  delete navigator.__marionette;
  delete navigator.__fxdriver;
  delete navigator._driver;
  delete navigator._selenium;
  delete navigator.__driver_evaluate;
  delete navigator.__webdriver_evaluate;
  delete navigator.__selenium_evaluate;
  delete navigator.__fxdriver_evaluate;
  delete navigator.__driver_unwrapped;
  delete navigator.__webdriver_unwrapped;
  delete navigator.__selenium_unwrapped;
  delete navigator.__fxdriver_unwrapped;
})();
`;

export function getLaunchOptions(config) {
  const proxy = config?.proxy;
  const anti = config?.anti_detect || {};
  const viewport = anti.random_viewport !== false ? getRandomViewport() : { width: 1366, height: 768 };
  const timezoneId = anti.random_timezone !== false ? getRandomTimeZone() : 'America/New_York';
  const locale = anti.random_locale !== false ? getRandomLocale() : 'en-US';
  const deviceScaleFactor = anti.random_device_scale !== false ? getRandomDeviceScaleFactor() : 1;
  return {
    viewport,
    proxy: proxy ? { server: proxy } : undefined,
    locale,
    timezoneId,
    deviceScaleFactor,
    hasTouch: false,
    isMobile: false,
    ignoreHTTPSErrors: true,
    bypassCSP: false,
    extraHTTPHeaders: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': locale === 'en-GB' ? 'en-GB,en;q=0.5' : 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
    firefoxUserPrefs: {
      'dom.webdriver.enabled': false,
      'useAutomationExtension': false,
      'marionette.enabled': false,
      'privacy.resistFingerprinting': false,
      'geo.enabled': false,
    },
  };
}
