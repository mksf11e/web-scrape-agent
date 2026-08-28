#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { parseArgs, normalizeUrl, createScope, pageFolder, revealPage, sourceWrapped, soft404 } from './common.mjs';

const { gfm } = turndownPluginGfm;

function usage() {
  return `Website text scraper

Required:
  --start-url URL          Page/domain to start from
  --output DIR             Output directory

Common options:
  --scope MODE             same-origin (default) or path-prefix
  --path-prefix PATH       Explicit path prefix for path-prefix scope
  --max-pages N            Default: 500
  --max-depth N            Default: 3
  --query POLICY           drop-tracking (default), preserve, or drop-all
  --sitemap VALUE          auto (default), off, or a sitemap URL
  --content MODE           auto (default), main, body, or selector
  --selector CSS           Required when --content selector
  --include-chrome         Keep header/footer/nav text
  --remove-selector CSS    Repeatable selector to remove
  --url-style STYLE        visible (default), frontmatter, both, or none
  --error-pages POLICY     report (default), capture, or skip
  --include REGEX          Repeatable URL include rule
  --exclude REGEX          Repeatable URL exclude rule
  --timeout MS             Default: 45000
  --resume                 Skip existing content.md files
  --overwrite              Permit replacing existing output
`;
}

function numberArg(args, name, fallback) {
  const value = Number(args.one(name, fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
}

function decodeXml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
}

async function fetchText(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    return response.ok ? await response.text() : '';
  } finally {
    clearTimeout(timer);
  }
}

async function sitemapSeeds(startUrl, sitemapOption, inScope, queryPolicy, timeout, maxPages) {
  if (sitemapOption === 'off') return [];
  const pending = [];
  if (sitemapOption && sitemapOption !== 'auto') {
    pending.push(sitemapOption);
  } else {
    const origin = new URL(startUrl).origin;
    try {
      const robots = await fetchText(new URL('/robots.txt', origin).href, timeout);
      for (const line of robots.split(/\r?\n/)) {
        const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
        if (match) pending.push(match[1]);
      }
    } catch {}
    pending.push(new URL('/sitemap.xml', origin).href);
  }

  const seenMaps = new Set();
  const pages = new Set();
  while (pending.length && seenMaps.size < 50 && pages.size < maxPages) {
    const sitemapUrl = pending.shift();
    if (seenMaps.has(sitemapUrl)) continue;
    seenMaps.add(sitemapUrl);
    try {
      const xml = await fetchText(sitemapUrl, timeout);
      const locations = [...xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)].map((match) => decodeXml(match[1]));
      const isIndex = /<sitemapindex\b/i.test(xml);
      for (const location of locations) {
        if (isIndex) pending.push(location);
        else {
          const normalized = normalizeUrl(location, startUrl, queryPolicy);
          if (normalized && inScope(normalized)) pages.add(normalized);
        }
      }
    } catch {}
  }
  return [...pages];
}

function uniqueFolder(url, registry) {
  const preferred = pageFolder(url);
  const previous = registry.get(preferred.toLowerCase());
  if (!previous || previous === url) {
    registry.set(preferred.toLowerCase(), url);
    return preferred;
  }
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
  const unique = `${preferred}--${hash}`;
  registry.set(unique.toLowerCase(), url);
  return unique;
}

async function extractHtml(page, mode, selector, includeChrome, removeSelectors, sourceHtml) {
  return page.evaluate(({ mode, selector, includeChrome, removeSelectors, sourceHtml }) => {
    const collect = (doc) => {
      let source;
      if (mode === 'selector') source = doc.querySelector(selector);
      else if (mode === 'body') source = doc.body;
      else if (mode === 'main') source = doc.querySelector('main, [role="main"]') || doc.body;
      else source = doc.querySelector('main, article, [role="main"]') || doc.body;
      if (!source) return null;

      const root = source.cloneNode(true);
      const removals = ['script', 'style', 'template', 'noscript', '[hidden]', '[aria-hidden="true"]', ...removeSelectors];
      if (!includeChrome) removals.push('header', 'footer', 'nav', '[role="navigation"]');
      for (const item of removals) {
        try { root.querySelectorAll(item).forEach((element) => element.remove()); } catch {}
      }
      root.querySelectorAll('[href]').forEach((element) => {
        try { element.setAttribute('href', new URL(element.getAttribute('href'), location.href).href); } catch {}
      });
      root.querySelectorAll('[src]').forEach((element) => {
        try { element.setAttribute('src', new URL(element.getAttribute('src'), location.href).href); } catch {}
      });
      return { html: root.outerHTML, text: root.textContent || '' };
    };

    const rendered = collect(document);
    if (!rendered) throw new Error(`Content selector not found: ${selector}`);
    if (!sourceHtml) return rendered;
    const sourceDocument = new DOMParser().parseFromString(sourceHtml, 'text/html');
    const original = collect(sourceDocument);
    if (!original) return rendered;

    // Prefer source HTML when it contains essentially the same content. This preserves
    // punctuation and semantic markup that client scripts may remove. SPA shells fall
    // back to the richer rendered DOM automatically.
    return original.text.trim().length >= rendered.text.trim().length * 0.85 ? original : rendered;
  }, { mode, selector, includeChrome, removeSelectors, sourceHtml });
}

function toMarkdown(html) {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  service.use(gfm);
  return service.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log(usage());
    return;
  }

  const startUrl = normalizeUrl(args.one('start-url'), undefined, args.one('query', 'drop-tracking'));
  const output = args.one('output');
  if (!startUrl || !output) throw new Error(`--start-url and --output are required\n\n${usage()}`);

  const outputDir = path.resolve(output);
  const maxPages = numberArg(args, 'max-pages', 500);
  const maxDepth = numberArg(args, 'max-depth', 3);
  const timeout = numberArg(args, 'timeout', 45_000);
  const queryPolicy = args.one('query', 'drop-tracking');
  const scopeMode = args.one('scope', 'same-origin');
  const contentMode = args.one('content', 'auto');
  const selector = args.one('selector');
  const urlStyle = args.one('url-style', 'visible');
  const errorPolicy = args.one('error-pages', 'report');
  const resume = args.has('resume');
  const overwrite = args.has('overwrite');

  if (!['drop-tracking', 'preserve', 'drop-all'].includes(queryPolicy)) throw new Error('Invalid --query policy');
  if (!['same-origin', 'path-prefix'].includes(scopeMode)) throw new Error('Invalid --scope mode');
  if (!['auto', 'main', 'body', 'selector'].includes(contentMode)) throw new Error('Invalid --content mode');
  if (contentMode === 'selector' && !selector) throw new Error('--content selector requires --selector CSS');
  if (!['visible', 'frontmatter', 'both', 'none'].includes(urlStyle)) throw new Error('Invalid --url-style');
  if (!['report', 'capture', 'skip'].includes(errorPolicy)) throw new Error('Invalid --error-pages policy');

  const existing = await fs.readdir(outputDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (existing.length && !resume && !overwrite) {
    throw new Error(`Output directory is not empty: ${outputDir}\nUse --resume or --overwrite after confirming the intended changes.`);
  }
  await fs.mkdir(outputDir, { recursive: true });

  const inScope = createScope(startUrl, scopeMode, args.one('path-prefix'), args.many('include'), args.many('exclude'), queryPolicy);
  const queue = [{ url: startUrl, depth: 0, discoveredBy: 'start' }];
  const enqueued = new Set([startUrl]);
  for (const url of await sitemapSeeds(startUrl, args.one('sitemap', 'auto'), inScope, queryPolicy, timeout, maxPages)) {
    if (!enqueued.has(url)) {
      enqueued.add(url);
      queue.push({ url, depth: 0, discoveredBy: 'sitemap' });
    }
  }

  const previousIndex = resume
    ? JSON.parse(await fs.readFile(path.join(outputDir, '_pages.json'), 'utf8').catch(() => '[]'))
    : [];
  const previousByUrl = new Map(previousIndex.map((page) => [page.url, page]));
  const folderRegistry = new Map(previousIndex.filter((page) => page.folder).map((page) => [page.folder.toLowerCase(), page.url]));
  const visited = new Set();
  const pages = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  try {
    while (queue.length && pages.length < maxPages) {
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      console.log(`[${pages.length + 1}/${maxPages}] ${item.url}`);

      const page = await context.newPage();
      try {
        const response = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForLoadState('load', { timeout: Math.min(timeout, 10_000) }).catch(() => {});
        const reveal = await revealPage(page);
        const finalUrl = normalizeUrl(page.url(), startUrl, queryPolicy) || item.url;
        const title = await page.title();
        const sourceHtml = response ? await response.text().catch(() => null) : null;
        const extracted = await extractHtml(page, contentMode, selector, args.has('include-chrome'), args.many('remove-selector'), sourceHtml);
        const markdown = toMarkdown(extracted.html);
        const status = response?.status() ?? null;
        const is404 = status === 404 || soft404(title, extracted.text);
        const isError = (status !== null && status >= 400) || is404;

        const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
        if (item.depth < maxDepth) {
          for (const href of links) {
            const normalized = normalizeUrl(href, finalUrl, queryPolicy);
            if (normalized && inScope(normalized) && !enqueued.has(normalized) && enqueued.size < maxPages) {
              enqueued.add(normalized);
              queue.push({ url: normalized, depth: item.depth + 1, discoveredBy: 'link' });
            }
          }
        }

        if (isError && errorPolicy === 'skip') continue;
        const previous = previousByUrl.get(finalUrl);
        const folder = previous?.folder || uniqueFolder(finalUrl, folderRegistry);
        const shouldWrite = !isError || errorPolicy === 'capture';
        const contentPath = path.join(outputDir, folder, 'content.md');
        if (shouldWrite && !(resume && await fs.access(contentPath).then(() => true).catch(() => false))) {
          await fs.mkdir(path.dirname(contentPath), { recursive: true });
          await fs.writeFile(contentPath, sourceWrapped(markdown, finalUrl, urlStyle), overwrite ? undefined : { flag: 'wx' });
        }

        pages.push({
          url: finalUrl,
          requestedUrl: item.url,
          title,
          status,
          is404,
          error: isError,
          folder: shouldWrite ? folder : null,
          capture: shouldWrite,
          depth: item.depth,
          discoveredBy: item.discoveredBy,
          textLength: extracted.text.trim().length,
          pageHeight: reveal.height,
          images: reveal.assets,
        });
      } catch (error) {
        pages.push({ url: item.url, requestedUrl: item.url, status: null, error: true, capture: false, depth: item.depth, discoveredBy: item.discoveredBy, message: error.message });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const indexPath = path.join(outputDir, '_pages.json');
  await fs.writeFile(indexPath, `${JSON.stringify(pages, null, 2)}\n`);
  const textIndex = pages.map((page) => `${page.status ?? 'ERR'}\t${page.url}\t${page.folder || '-'}\t${page.capture ? 'CAPTURE' : 'REPORT'}`).join('\n');
  await fs.writeFile(path.join(outputDir, '_pages_index.txt'), `${textIndex}\n`);

  const errors = pages.filter((page) => page.error).length;
  console.log(`Done: ${pages.length} pages, ${errors} error/404 pages. Index: ${indexPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
