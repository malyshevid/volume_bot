// auto_trade.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TRADE_SCRIPT = path.resolve(__dirname, 'trade_token.ts'); // наш предыдущий скрипт

// 🎯 целевой токен (20% приоритета)
const TARGET_MINT = 'LikeUK3Ws7JVmHpZNa15r8Ct1PyScHtFARNzwbttZ1k';

// RPC список (как в trade_token.ts)
const RPC_LIST = [
  process.env.HELIUS_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}`,
  process.env.QUICKNODE_RPC,
  process.env.ALCHEMY_RPC,
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-rpc.publicnode.com',
  'https://rpc.shyft.to/solana/mainnet?api_key=public',
].filter(Boolean) as string[];

function withTimeout<T>(p: Promise<T>, ms = 10000) {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

async function getConnection(): Promise<Connection> {
  for (const url of RPC_LIST) {
    try {
      const c = new Connection(url, { commitment: 'confirmed' });
      await withTimeout(c.getLatestBlockhash(), 7000);
      console.log('✅ RPC', url);
      return c;
    } catch (e: any) {
      console.warn('⚠️ RPC dead:', url, e?.message ?? e);
    }
  }
  throw new Error('No alive RPC');
}

// (оставляем как есть — теперь не используется напрямую)
function parseKeypairFromEnv(): Keypair {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing in .env');
  const secret = pk.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(pk))
    : bs58.decode(pk.trim());
  return Keypair.fromSecretKey(secret);
}

// ➕ Читаем список кошельков (каждая строка — приватник base58 или JSON-массив)
function readWallets(file = path.resolve(__dirname, 'wallets.txt')): string[] {
  if (!fs.existsSync(file)) throw new Error(`wallets.txt not found at ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const valid: string[] = [];
  for (const raw of lines) {
    try {
      const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
      Keypair.fromSecretKey(secret);
      valid.push(raw); // храним исходную строку, будем подставлять её в PRIVATE_KEY
    } catch {
      console.warn('⚠️ Skip invalid wallet entry in wallets.txt');
    }
  }
  if (valid.length === 0) throw new Error('wallets.txt has no valid private keys');
  return valid;
}

// ➕ Утилита: из строки (base58/JSON) получить Keypair (для запросов балансов)
function parseKeypairFromString(raw: string): Keypair {
  const secret = raw.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(raw))
    : bs58.decode(raw.trim());
  return Keypair.fromSecretKey(secret);
}

function readTokens(file = path.resolve(__dirname, 'tokens.txt')): string[] {
  if (!fs.existsSync(file)) throw new Error(`tokens.txt not found at ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const valid = lines.filter(addr => {
    try { new PublicKey(addr); return true; } catch { return false; }
  });
  if (valid.length === 0) throw new Error('tokens.txt has no valid mint addresses');
  return valid;
}

function randBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

async function fetchJson<T = any>(url: string, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(id);
  }
}

// Jupiter котировка для продажи token→SOL по точному количеству токена (ExactIn)
async function quoteTokenToSolLamports(tokenMint: string, tokenAmountRaw: bigint): Promise<number> {
  const url =
    `https://quote-api.jup.ag/v6/quote` +
    `?inputMint=${tokenMint}` +
    `&outputMint=${WSOL_MINT}` +
    `&amount=${tokenAmountRaw.toString()}` +
    `&swapMode=ExactIn` +
    `&onlyDirectRoutes=false`;
  const q: any = await fetchJson(url, 10000);
  const qResp = q.data ? (q.data[0] ?? q.data) : q;
  const outAmt = Number(qResp?.outAmount ?? 0);
  if (!Number.isFinite(outAmt) || outAmt <= 0) throw new Error('No Jupiter quote outAmount');
  return outAmt; // лампорты SOL
}

// Суммарный баланс токена в raw-единицах (u64) по всем ATA
async function getTokenBalanceRaw(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const resp = await connection.getTokenAccountsByOwner(owner, { mint, programId: TOKEN_PROGRAM_ID });
  let total = 0n;
  for (const acc of resp.value) {
    const data = acc.account.data;
    const info = AccountLayout.decode(data);
    total += BigInt(info.amount.toString());
  }
  return total;
}

// === SOAX proxy config (rotating session: новый IP на каждый запрос) ===
// (Оставляем имена переменных как были, чтобы не трогать остальной код)
const BRD_HOST = 'proxy.soax.com';
const BRD_PORT = 5000;
const BRD_USER_BASE = 'package-309846';
const BRD_PASS = '5AYenIcT9SWBsZco';

// строим прокси-URL (для SOAX rotating — без session в логине)
function buildProxyUrl(pubkey: string) {
  const session = `rot-${Date.now().toString(36)}`; // чисто для лога
  const username = BRD_USER_BASE; // у SOAX rotating сессия не нужна в логине
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(BRD_PASS)}@${BRD_HOST}:${BRD_PORT}`;
  return { proxyUrl, session };
}

// --- Надёжный запуск trade_token.ts (фикс ENOENT) ---
function resolveTsNodeBin(): string {
  const local = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node');
  if (fs.existsSync(local)) return local;
  return process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node';
}

// ⬇️ amount — строка (для SELL передаём raw-кол-во токена)
function runTradeScript(op: 'buy' | 'sell', tokenMint: string, amount: string, envExtras: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tsNodeBin = resolveTsNodeBin();
    const args = [TRADE_SCRIPT, op, tokenMint, amount];
    console.log('▶️  run:', tsNodeBin, args.join(' '));

    const child = spawn(tsNodeBin, args, {
      stdio: 'inherit',
      shell: true, // важно для Windows (.cmd)
      env: { ...process.env, ...envExtras },
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`trade_token exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function mainLoop() {
  const connection = await getConnection();
  const tokens = readTokens();
  const wallets = readWallets();

  while (true) {
    try {
      // шаг 1: действие
      const op: 'buy' | 'sell' = Math.random() < 0.5 ? 'buy' : 'sell';

      // шаг 2 (обновлено): выбор токена для BUY с 20% шансом на TARGET_MINT
      const useTargetForBuy = Math.random() < 0.2;
      const tokenMintForBuy = useTargetForBuy
        ? TARGET_MINT
        : tokens[Math.floor(Math.random() * tokens.length)];

      // шаг 0.5: выбираем кошелёк из wallets.txt
      const walletRaw = wallets[Math.floor(Math.random() * wallets.length)];
      const wallet = parseKeypairFromString(walletRaw);
      const pub = wallet.publicKey.toBase58();
      console.log(`\n=== ${new Date().toISOString()} | ${op.toUpperCase()} | ${tokenMintForBuy.slice(0, 8)}... | WALLET ${pub.slice(0,8)}… ===`);

      // Настраиваем прокси (SOAX rotating)
      const { proxyUrl, session } = buildProxyUrl(pub);
      console.log(`🛰️ Proxy enabled: ${BRD_HOST}:${BRD_PORT} | session=${session}`);

      // Переменные окружения для дочернего процесса трейда
      const childEnv = {
        PRIVATE_KEY: walletRaw,
        HTTPS_PROXY: proxyUrl,
      };

      if (op === 'buy') {
        // баланс SOL -> доля -> покупка (токен по логике 20%/80%)
        const balLamports = await connection.getBalance(wallet.publicKey);
        const feeBuffer = 300_000; // ~0.0003 SOL на комиссии
        const available = Math.max(0, balLamports - feeBuffer);
        if (available < 500_000) { // < 0.0005 SOL
          console.log('💤 Skip: low SOL balance.');
        } else {
          const frac = randBetween(0.05, 0.2); // 5–20% от доступного
          const spendLamports = Math.max(500_000, Math.floor(available * frac)); // ≥ 0.0005 SOL
          const amountSOL = spendLamports / 1e9;
          console.log(`💰 Buying for ~${amountSOL.toFixed(6)} SOL (balance ${(balLamports/1e9).toFixed(6)} SOL)…`);
          await runTradeScript('buy', tokenMintForBuy, amountSOL.toFixed(9), childEnv);
        }
      } else {
        // === ПРОДАЖА: приоритет 20% на TARGET_MINT, но если его нет на кошельке — продаём любой имеющийся ===
        const list = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
        const byMint = new Map<string, bigint>();
        for (const acc of list.value) {
          const info = AccountLayout.decode(acc.account.data);
          const amount = BigInt(info.amount.toString());
          if (amount > 0n) {
            const mintStr = new PublicKey(info.mint).toBase58();
            if (mintStr === WSOL_MINT) continue; // пропускаем WSOL
            byMint.set(mintStr, (byMint.get(mintStr) ?? 0n) + amount);
          }
        }

        const candidates = Array.from(byMint.entries()); // [mint, totalAmount]
        if (candidates.length === 0) {
          console.log('💤 Skip: no token balance.');
        } else {
          let sellMint: string;
          let totalRaw: bigint;

          if (Math.random() < 0.2 && byMint.has(TARGET_MINT)) {
            // 20% шанс и целевой токен есть на кошельке — продаём его
            sellMint = TARGET_MINT;
            totalRaw = byMint.get(TARGET_MINT)!;
          } else {
            // иначе — случайный из имеющихся
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            sellMint = pick[0];
            totalRaw = pick[1];
          }

          const frac = randBetween(0.1, 0.4); // 10–40% баланса
          const sellRaw = BigInt(Math.max(1, Math.floor(Number(totalRaw) * frac)));

          // (опционально) для лога посчитаем примерный выход в SOL по ExactIn
          let approxOutLamports = 0;
          try {
            approxOutLamports = await quoteTokenToSolLamports(sellMint, sellRaw);
          } catch {}
          const approxOutSol = approxOutLamports / 1e9;

          console.log(`💸 Selling ~${(Number(sellRaw)).toLocaleString()} raw units of ${sellMint.slice(0,8)}… (ExactIn). ~${approxOutSol.toFixed(6)} SOL expected by quote…`);

          // Передаём в trade_token ИМЕННО raw-количество токена (строкой!)
          await runTradeScript('sell', sellMint, sellRaw.toString(), childEnv);
        }
      }
    } catch (e: any) {
      console.error('❌ Loop error:', e?.message ?? e);
    }

    // шаг 4: пауза — случайная от 15 до 45 секунд
    const pauseSec = Math.floor(randBetween(15, 45));
    console.log(`⏸️  Pause ${pauseSec}s before next trade…`);
    await new Promise(r => setTimeout(r, pauseSec * 1000));
  }
}

mainLoop().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
