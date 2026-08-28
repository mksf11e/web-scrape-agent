import crypto from 'node:crypto';
import path from 'node:path';

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', '_ga', '_gl']);
const ASSET_EXTENSIONS = new Set(['.css', '.js', '.json', '.xml', '.rss', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.mp3', '.mp4', '.webm', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

export function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      booleans.add(name);
      continue;
    }
    if (!values.has(name)) values.set(name, []);
    values.get(name).push(next);
    index += 1;
  }
  return {
    has: (name) => booleans.has(name) || values.has(name),
    one: (name, fallback = undefined) => values.get(name)?.at(-1) ?? fallback,
    many: (name) => values.get(name) || [],
  };
}

export function normalizeUrl(input, baseUrl, queryPolicy = 'drop-tracking') {
  let url;
  try {
    url = new URL(input, baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.hash = '';
  if (queryPolicy === 'drop-all') url.search = '';
  if (queryPolicy === 'drop-tracking') {
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
  }
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

export function isAssetUrl(urlString) {
  try {
    return ASSET_EXTENSIONS.has(path.posix.extname(new URL(urlString).pathname).toLowerCase());
  } catch {
    return true;
  }
}

export function createScope(startUrl, mode, pathPrefix, includes, excludes, queryPolicy) {
  const start = new URL(startUrl);
  const includePatterns = includes.map((value) => new RegExp(value));
  const excludePatterns = excludes.map((value) => new RegExp(value));
  const prefix = pathPrefix || (start.pathname === '/' ? '/' : start.pathname.replace(/[^/]*$/, ''));

  return (candidate) => {
    const normalized = normalizeUrl(candidate, startUrl, queryPolicy);
    if (!normalized || isAssetUrl(normalized)) return false;
    const url = new URL(normalized);
    const baseMatch = mode === 'path-prefix'
      ? url.origin === start.origin && url.pathname.startsWith(prefix)
      : url.origin === start.origin;
    if (!baseMatch) return false;
    if (excludePatterns.some((pattern) => pattern.test(normalized))) return false;
    if (includePatterns.length && !includePatterns.some((pattern) => pattern.test(normalized))) return false;
    return true;
  };
}

function safeSegment(value) {
  let segment;
  try { segment = decodeURIComponent(value); } catch { segment = value; }
  segment = segment.normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '')
    .slice(0, 80);
  return segment || 'index';
}

export function pageFolder(urlString) {
  const url = new URL(urlString);
  const segments = url.pathname.split('/').filter(Boolean).map(safeSegment);
  let folder = segments.length ? segments.join('__') : 'index';
  if (url.search) {
    const hash = crypto.createHash('sha256').update(url.href).digest('hex').slice(0, 10);
    folder += `--${hash}`;
  }
  return folder;
}

export async function revealPage(page, options = {}) {
  const stepRatio = options.stepRatio || 0.75;
  const settleMs = options.settleMs ?? 150;
  const maxSteps = options.maxSteps || 1000;
  const maxPasses = options.maxPasses || 3;
  let previousHeight = 0;
  let stablePasses = 0;
  let steps = 0;

  for (let pass = 0; pass < maxPasses && stablePasses < 2; pass += 1) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const viewport = await page.evaluate(() => window.innerHeight);
    let y = 0;
    while (steps < maxSteps) {
      const height = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));
      const maxScroll = Math.max(0, height - viewport);
      const target = Math.min(y, maxScroll);
      await page.evaluate((top) => window.scrollTo(0, top), target);
      steps += 1;
      if (settleMs) await page.waitForTimeout(settleMs);
      if (target >= maxScroll) break;
      y += Math.max(1, Math.floor(viewport * stepRatio));
    }
    const height = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));
    if (height === previousHeight) stablePasses += 1;
    else stablePasses = 0;
    previousHeight = height;
  }

  const assets = await page.evaluate(async () => {
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 5000))]);
    const images = await Promise.all([...document.images].map(async (image) => {
      if (!image.complete) {
        await Promise.race([
          new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
          }),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
      if (image.complete && image.naturalWidth && image.decode) await image.decode().catch(() => {});
      return { src: image.currentSrc || image.src, loaded: image.complete && image.naturalWidth > 0 };
    }));
    return { total: images.length, loaded: images.filter((image) => image.loaded).length, broken: images.filter((image) => !image.loaded) };
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  return { height: previousHeight, stable: stablePasses > 0, steps, assets };
}

export function sourceWrapped(markdown, url, style) {
  const body = markdown.trim();
  if (style === 'none') return `${body}\n`;
  const visible = `Source: ${url}`;
  const frontmatter = `---\nurl: ${url}\n---`;
  if (style === 'frontmatter') return `${frontmatter}\n\n${body}\n`;
  if (style === 'both') return `${frontmatter}\n\n${visible}\n\n${body}\n`;
  return `${visible}\n\n${body}\n`;
}

export function soft404(title, text) {
  const sample = `${title}\n${text.slice(0, 1500)}`;
  return /\b404\b.{0,80}(not found|page)|page not found|this page could not be found|找不到(?:此|該)?頁面|頁面不存在|此頁不存在/is.test(sample);
}
