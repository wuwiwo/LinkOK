'use strict';

/**
 * LAN address selection for the QR payload (PROTOCOL.md §6.1).
 *
 * The QR must contain an address the Phone can dial. `127.0.0.1` or a
 * Hyper-V/WSL/VirtualBox adapter address is useless there, so the Hub picks the
 * first non-internal IPv4 address, preferring real private LAN ranges and
 * skipping link-local (169.254/16) and APIPA noise.
 */

const os = require('node:os');

/** Adapter name fragments that are virtual even though they may carry a LAN-looking IP. */
const VIRTUAL_ADAPTER_HINTS = [
  'vethernet',
  'virtualbox',
  'vmware',
  'hyper-v',
  'docker',
  'wsl',
  'loopback',
  'bluetooth',
  'npcap',
  'tap-',
  'tap ',
];

/**
 * @param {string} address
 * @returns {boolean}
 */
function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isLinkLocal(address) {
  return address.startsWith('169.254.');
}

/**
 * @typedef {object} LanCandidate
 * @property {string} address
 * @property {string} iface
 * @property {number} score
 */

/**
 * All usable IPv4 candidates, best first.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {LanCandidate[]}
 */
function lanCandidates(interfaces = os.networkInterfaces()) {
  /** @type {LanCandidate[]} */
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;
    const lowered = name.toLowerCase();
    const virtual = VIRTUAL_ADAPTER_HINTS.some((hint) => lowered.includes(hint));
    for (const info of addresses) {
      // Node <18 exposes family as a string, newer as a number; accept both.
      const family = String(info.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (info.internal) continue;
      if (isLinkLocal(info.address)) continue;
      let score = 0;
      if (isPrivateIpv4(info.address)) score += 100;
      if (!virtual) score += 50;
      // Wi-Fi adapters are the ones a Phone on the same network can reach.
      if (/(wi-?fi|wlan|wireless)/.test(lowered)) score += 25;
      candidates.push({ address: info.address, iface: name, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.iface.localeCompare(b.iface));
  return candidates;
}

/**
 * The address to advertise in the QR payload. Falls back to 127.0.0.1 so the
 * Hub can always produce a payload (the settings page shows a warning instead
 * of the QR being blank).
 * @returns {string}
 */
function primaryLanAddress() {
  const candidates = lanCandidates();
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

module.exports = { primaryLanAddress, lanCandidates, isPrivateIpv4, isLinkLocal, VIRTUAL_ADAPTER_HINTS };
