#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`relay: ${err?.message || err}`);
  process.exit(1);
});
