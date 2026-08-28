#!/usr/bin/env node

// Compatibility entry point. The maintained implementation is screenshot.mjs.
import('./screenshot.mjs').catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
