#!/usr/bin/env node
/** Usage: node scripts/lib/print-host-field.mjs lan alice ssh */
import { loadLocalConfig } from './local-config.mjs';

const [topology, role, field = 'ssh'] = process.argv.slice(2);
if (!topology || !role) {
  console.error('usage: print-host-field.mjs <lan|wan> <alice|bob> [field]');
  process.exit(2);
}

const { hosts } = await loadLocalConfig();
const value = hosts?.[topology]?.[role]?.[field];
if (value == null || value === '') {
  console.error(`missing machines.${topology}.${role}.${field}`);
  process.exit(1);
}
process.stdout.write(String(value));
