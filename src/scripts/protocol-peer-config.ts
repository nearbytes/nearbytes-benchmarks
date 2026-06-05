import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createCryptoOperations, createSecret, bytesToHex } from 'nearbytes-crypto';
import { writeConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import { BENCH_CREDENTIALS } from '../benchmark-credentials.js';

export type ProtocolRole = 'alice' | 'bob';

export async function profilePublicKeyHex(secret: string): Promise<string> {
  const crypto = createCryptoOperations();
  const kp = await crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey);
}

export function protocolPeerDirs(role: ProtocolRole): {
  configPath: string;
  dataDir: string;
  workDir: string;
} {
  const base =
    process.env['NEARBYTES_PEER_BASE'] ??
    path.join(os.tmpdir(), 'nearbytes-protocol-peer');
  const workDir = path.join(base, role);
  return {
    workDir,
    configPath: path.join(workDir, 'config.json'),
    dataDir: path.join(workDir, 'data'),
  };
}

export async function setupProtocolConfig(role: ProtocolRole): Promise<{
  config: NearbytesConfig;
  configPath: string;
}> {
  const { configPath, dataDir, workDir } = protocolPeerDirs(role);
  const alicePk = await profilePublicKeyHex(BENCH_CREDENTIALS.profileAlice);
  const bobPk = await profilePublicKeyHex(BENCH_CREDENTIALS.profileBob);
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const profileSecret =
    role === 'alice' ? BENCH_CREDENTIALS.profileAlice : BENCH_CREDENTIALS.profileBob;
  const friends = role === 'alice' ? [bobPk] : [alicePk];
  const config: NearbytesConfig = {
    dataDir,
    volumes: [{ label: 'bench', secret: BENCH_CREDENTIALS.volume }],
    friends,
    profiles: [{ name: role, secret: profileSecret }],
    activeProfile: role,
  };
  process.env['NEARBYTES_CONFIG'] = configPath;
  process.env['NEARBYTES_STORAGE_DIR'] = dataDir;
  await writeConfig(config, configPath);
  return { config, configPath };
}
