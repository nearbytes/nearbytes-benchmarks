/**
 * Host map loader — reads machines from config/local.json (see scripts/lib/local-config.mjs).
 */
import { loadLocalConfig, LOCAL_CONFIG_PATH } from '../../lib/local-config.mjs';

export const HOSTS_PATH = LOCAL_CONFIG_PATH;

export async function loadHosts() {
  const { hosts, _configPath } = await loadLocalConfig();
  if (!hosts?.local) {
    throw new Error(
      `machines.local required in ${_configPath}. Copy config/local.example.json to config/local.json.`,
    );
  }
  return hosts;
}

export function requireLan(hosts) {
  if (!hosts.lan?.alice || !hosts.lan?.bob) {
    throw new Error('machines.lan.{alice,bob} required for LAN category');
  }
  return hosts.lan;
}

export function requireWan(hosts) {
  if (!hosts.wan?.alice || !hosts.wan?.bob) {
    throw new Error('machines.wan.{alice,bob} required for WAN category');
  }
  return hosts.wan;
}
