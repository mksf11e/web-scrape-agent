#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseArgs, revealPage } from './common.mjs';

function usage() {
  return `Full-page website screenshot capture

Required:
  --output DIR             Directory created by scrape.mjs

Options:
  --viewport WIDTHxHEIGHT  Default: 1440x900
  --color-scheme VALUE     light (default) or dark
  --motion MODE            finish (default), preserve, or reduce
  --wait-selector CSS      Wait for a visible page element
  --hide-selector CSS      Repeatable overlay/cookie selector to hide
  --capture-css CSS        Temporary screenshot-only CSS
  --timeout MS             Default: 45000
  --resume                 Skip existing screenshot.png files
  --overwrite              Replace existing screenshot.png files
`;
}

function parseViewport(value) {
  const match = String(value).match(/^(\d+)x(\d+)$/i);
  if (!match) throw new Error('--viewport must use WIDTHxHEIGHT, for example 1440x900');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 240 || height < 240) throw new Error('Viewport must be at least 240x240');
  return { width, height };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log(usage());
    return;
  }

  const output = args.one('output');
  if (!output) throw new Error(`--output is required\n\n${usage()}`);
  const outputDir = path.resolve(output);
  const indexPath = path.join(outputDir, '_pages.json');
  const pages = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const viewport = parseViewport(args.one('viewport', '1440x900'));
  const timeout = Number(args.one('timeout', 45_000));
  const motion = args.one('motion', 'finish');
  const colorScheme = args.one('color-scheme', 'light');
  const resume = args.has('resume');
  const overwrite = args.has('overwrite');
  if (!['finish', 'preserve', 'reduce'].includes(motion)) throw new Error('Invalid --motion mode');
  if (!['light', 'dark'].includes(colorScheme)) throw new Error('Invalid --color-scheme');

  const targets = pages.filter((page) => page.capture && page.folder);
  if (!resume && !overwrite) {
    for (const target of targets) {
      const screenshot = path.join(outputDir, target.folder, 'screenshot.png');
      if (await fs.access(screenshot).then(() => true).catch(() => false)) {
        throw new Error(`Screenshot already exists: ${screenshot}\nUse --resume or --overwrite after confirming the intended changes.`);
      }
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    colorScheme,
    reducedMotion: motion === 'reduce' ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
  });
  const report = [];

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const screenshotPath = path.join(outputDir, target.folder, 'screenshot.png');
      if (resume && await fs.access(screenshotPath).then(() => true).catch(() => false)) {
        report.push({ url: target.url, screenshot: screenshotPath, status: 'skipped-existing' });
        continue;
      }

      console.log(`[${index + 1}/${targets.length}] ${target.url}`);
      const page = await context.newPage();
      const failedRequests = [];
      page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'unknown' }));

      try {
        const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForLoadState('load', { timeout: Math.min(timeout, 10_000) }).catch(() => {});
        if (args.one('wait-selector')) {
          await page.locator(args.one('wait-selector')).first().waitFor({ state: 'visible', timeout });
        }

        const reveal = await revealPage(page);
        const hiddenCss = args.many('hide-selector').map((selector) => `${selector}{display:none!important;}`).join('\n');
        const style = [hiddenCss, args.one('capture-css', '')].filter(Boolean).join('\n');
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({
          path: screenshotPath,
          type: 'png',
          fullPage: true,
          animations: motion === 'finish' ? 'disabled' : 'allow',
          caret: 'hide',
          scale: 'css',
          style: style || undefined,
        });

        const stat = await fs.stat(screenshotPath);
        const dimensions = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
        }));
        report.push({
          url: target.url,
          screenshot: path.relative(outputDir, screenshotPath).split(path.sep).join('/'),
          status: 'captured',
          httpStatus: response?.status() ?? null,
          bytes: stat.size,
          dimensions,
          scrollStable: reveal.stable,
          images: reveal.assets,
          failedRequests,
          visualQa: 'pending',
        });
      } catch (error) {
        report.push({ url: target.url, status: 'failed', error: error.message, failedRequests, visualQa: 'not-run' });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const reportPath = path.join(outputDir, '_screenshot_report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const failed = report.filter((item) => item.status === 'failed').length;
  console.log(`Done: ${report.length - failed} screenshots, ${failed} failures. Visual QA remains pending until the PNG files are inspected.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
