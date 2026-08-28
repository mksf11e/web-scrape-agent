#!/usr/bin/env node

// Compatibility entry point. The maintained implementation is scrape.mjs.
import('./scrape.mjs').catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
