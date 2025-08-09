// check_proxy_ip.ts
//
// Проверка корректности подключения к прокси и смены IP.
// Использует HTTPS_PROXY/https_proxy из окружения (или аргументом).
//
// Exit codes:
// 0 — IP получен и ОТЛИЧАЕТСЯ от прошлого
// 1 — IP получен, но совпадает с прошлым
// 2 — не удалось получить IP ни с одного сервиса
//
// Использование из auto_trade:
//   spawn(tsNodeBin, ['check_proxy_ip.ts'], { env: { ...process.env, HTTPS_PROXY: proxyUrl }, stdio: 'inherit', shell: true })
//
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const LAST_IP_FILE = process.env.PROXY_LAST_IP_FILE || path.resolve(__dirname, 'last_ip.txt');

// --- утилиты ---
function nowISO() { return new Date().toISOString(); }
function maskProxy(p: string) { return p.replace(/\/\/([^:@]+)(?::[^@]*)?@/, '//***@'); }

function isIPv4(ip: string) {
  const m = ip.trim().match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (!m) return false;
  return ip.split('.').every(n => +n >= 0 && +n <= 255);
}
function isIPv6(ip: string) {
  // упрощённая проверка IPv6 (без строгой валидации)
  return /^[0-9a-fA-F:]+$/.test(ip.trim()) && ip.includes(':');
}
function normalizeIP(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, '');
  if (isIPv4(t) || isIPv6(t)) return t;
  return null;
}

async function fetchText(url: string, agent: any, timeoutMs = 8000): Promise<{ ok: boolean; status?: number; body?: string; err?: string; }> {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { agent, signal: ac.signal } as any);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    return { ok: false, err: e?.message ?? String(e) };
  } finally {
    clearTimeout(id);
  }
}

async function main() {
  const argProxy = process.argv[2]; // опционально: прямая передача прокси URL аргументом
  const proxyUrl = argProxy || process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!proxyUrl) {
    console.error(`[${nowISO()}] ERROR: HTTPS_PROXY not set`);
    process.exit(2);
  }

  const agent = new HttpsProxyAgent(proxyUrl);
  console.log(`[${nowISO()}] Using proxy: ${maskProxy(proxyUrl)}`);

  // цели (HTTP — чтобы избежать TLS-проблем)
  const targets: Array<{name: string; url: string; parse?: (txt: string) => string | null}> = [
    { name: 'ipify',     url: 'http://api.ipify.org?format=text' },
    { name: 'ifconfig',  url: 'http://ifconfig.me/ip' },
    { name: 'ip-api',    url: 'http://ip-api.com/line/?fields=query' },
    { name: 'icanhazip', url: 'http://icanhazip.com' },
    { name: 'httpbin',   url: 'http://httpbin.org/ip', parse: (txt: string) => {
        try {
          const j = JSON.parse(txt);
          const first = String(j.origin || '').split(',')[0].trim();
          return normalizeIP(first);
        } catch { return null; }
      } },
  ];

  const results: Array<{ name: string; ip?: string; status?: number; ok: boolean; err?: string; }> = [];

  for (const t of targets) {
    const r = await fetchText(t.url, agent, 9000);
    if (r.ok) {
      const raw = (r.body ?? '').trim();
      const parsed = t.parse ? t.parse(raw) : normalizeIP(raw);
      results.push({ name: t.name, ok: !!parsed, ip: parsed ?? undefined, status: r.status, err: parsed ? undefined : 'cannot-parse-ip' });
    } else {
      results.push({ name: t.name, ok: false, err: r.err ?? `HTTP ${r.status}` });
    }
  }

  // лог по каждому
  for (const r of results) {
    if (r.ok) {
      console.log(`  ${r.name.padEnd(10)} -> ${r.ip} (HTTP ${r.status})`);
    } else {
      console.log(`  ${r.name.padEnd(10)} -> ERROR: ${r.err}`);
    }
  }

  const ips = results.filter(r => r.ok && r.ip).map(r => r.ip!) as string[];
  if (ips.length === 0) {
    console.error(`[${nowISO()}] No IP from detectors — proxy not usable.`);
    process.exit(2);
  }

  // консенсус по IP (наиболее часто встречающийся)
  const counts = new Map<string, number>();
  for (const ip of ips) counts.set(ip, (counts.get(ip) ?? 0) + 1);
  let consensus = ips[0];
  let best = 0;
  for (const [ip, cnt] of counts.entries()) {
    if (cnt > best) { best = cnt; consensus = ip; }
  }

  // читаем прошлый IP
  let prev = '';
  try {
    if (fs.existsSync(LAST_IP_FILE)) {
      prev = fs.readFileSync(LAST_IP_FILE, 'utf8').trim();
    }
  } catch {}

  const changed = prev && consensus !== prev;

  console.log(`\nSummary: current=${consensus} (consensus from ${best}/${ips.length}), previous=${prev || '(none)'}, changed=${prev ? (changed ? 'YES' : 'NO') : 'N/A'}`);

  // записываем текущий IP
  try {
    fs.writeFileSync(LAST_IP_FILE, consensus + '\n', 'utf8');
  } catch (e: any) {
    console.warn(`Could not write ${LAST_IP_FILE}:`, e?.message ?? e);
  }

  // коды выхода: 0 — изменился, 1 — тот же, 2 — не получили IP
  process.exit(prev ? (changed ? 0 : 1) : 0);
}

main().catch(e => {
  console.error(`[${nowISO()}] Fatal:`, e?.message ?? e);
  process.exit(2);
});
