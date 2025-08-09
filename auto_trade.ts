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
      // валидация: пробуем собрать Keypair
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

// --- Надёжный запуск trade_token.ts (фикс ENOENT) ---
function resolveTsNodeBin(): string {
  const local = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node');
  if (fs.existsSync(local)) return local;
  // fallback: глобальный командой через shell
  return process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node';
}

function runTradeScript(op: 'buy' | 'sell', tokenMint: string, amountSol: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tsNodeBin = resolveTsNodeBin();
    const args = [TRADE_SCRIPT, op, tokenMint, amountSol.toString()];
    console.log('▶️  run:', tsNodeBin, args.join(' '));

    const child = spawn(tsNodeBin, args, {
      stdio: 'inherit',
      shell: true, // важно для Windows (.cmd)
      env: process.env,
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

      // шаг 2: токен
      const tokenMint = tokens[Math.floor(Math.random() * tokens.length)];

      // ➕ шаг 0.5: выбираем кошелёк из wallets.txt
      const walletRaw = wallets[Math.floor(Math.random() * wallets.length)];
      const wallet = parseKeypairFromString(walletRaw);
      console.log(`\n=== ${new Date().toISOString()} | ${op.toUpperCase()} | ${tokenMint.slice(0, 8)}... | WALLET ${wallet.publicKey.toBase58().slice(0,8)}… ===`);

      // Подставляем выбранный приватный ключ в процесс-окружение,
      // чтобы trade_token.ts использовал нужный кошелёк
      process.env.PRIVATE_KEY = walletRaw;

      if (op === 'buy') {
        // шаг 3 (buy): баланс SOL выбранного кошелька, выбираем долю и покупаем
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
          await runTradeScript('buy', tokenMint, Number(amountSOL.toFixed(9)));
        }
      } else {
        // шаг 3 (sell): баланс токена → доля → котировка в SOL → продаём ExactOut
        const mintPk = new PublicKey(tokenMint);
        const raw = await getTokenBalanceRaw(connection, wallet.publicKey, mintPk);
        if (raw <= 0n) {
          console.log('💤 Skip: no token balance.');
        } else {
          const frac = randBetween(0.1, 0.4); // 10–40% баланса
          const sellRaw = BigInt(Math.max(1, Math.floor(Number(raw) * frac)));
          // Считаем сколько SOL за это получим
          let outLamports = await quoteTokenToSolLamports(tokenMint, sellRaw);
          // Возьмём 95% от котировки на ExactOut, чтобы точно хватило токенов
          outLamports = Math.max(100_000, Math.floor(outLamports * 0.95)); // минимум 0.0001 SOL
          const amountSOL = outLamports / 1e9;
          console.log(`💸 Selling ~${(Number(sellRaw)).toLocaleString()} raw units for ~${amountSOL.toFixed(6)} SOL…`);
          await runTradeScript('sell', tokenMint, Number(amountSOL.toFixed(9)));
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
