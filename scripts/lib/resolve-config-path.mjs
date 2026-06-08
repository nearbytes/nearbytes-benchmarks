#!/usr/bin/env node
import { resolveConfigSyncPath } from './local-config.mjs';

process.stdout.write(await resolveConfigSyncPath());
