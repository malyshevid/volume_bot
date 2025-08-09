// trade_token.ts
import 'dotenv/config';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 50; // 0.50%

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
  console.log('🌐 Selecting RPC from list:', RPC_LIST.map(u => (u ?? '').split('?')[0]));
  for (const url of RPC_LIST) {
    try {
      const c = new Connection(url, { commitment: 'confirmed' });
      await withTimeout(c.getLatestBlockhash(), 7000);
      console.log('✅ RPC selected:', url);
      return c;
    } catch (e: any) {
      console.warn('⚠️ RPC dead:', url, '| reason:', e?.message ?? e);
    }
  }
  throw new Error('No alive RPC');
}

function parseKeypairFromEnv(): Keypair {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing in .env');
  console.log('🔐 Parsing PRIVATE_KEY from .env (base58 or JSON array)…');
  const secret = pk.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(pk))
    : bs58.decode(pk.trim());
  const kp = Keypair.fromSecretKey(secret);
  console.log('👛 Wallet:', kp.publicKey.toBase58());
  return kp;
}

// --- Прокси-агент ТОЛЬКО для Jupiter (HTTPS через CONNECT) ---
function getJupiterProxyAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!proxy) return { agent: undefined as any, masked: '(no proxy)' };
  const agent = new HttpsProxyAgent(proxy);
  const masked = proxy.replace(/\/\/[^@]+@/, '//***@');
  console.log('🌐 Jupiter via HTTPS proxy:', masked);
  return { agent, masked };
}

async function fetchJson<T = any>(url: string, timeoutMs = 15000, agent?: any, retries = 2): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, agent } as any);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} for ${url} ${txt ? '- ' + txt.slice(0, 200) + '…' : ''}`);
      }
      return res.json() as Promise<T>;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 700 + Math.random() * 600));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(id);
    }
  }
  throw lastErr;
}

async function postJson<T = any>(url: string, body: any, timeoutMs = 20000, agent?: any, retries = 2): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal as any,
        agent,
      } as any);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} for ${url}: ${txt.slice(0, 400)}${txt.length > 400 ? '…' : ''}`);
      }
      return res.json() as Promise<T>;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 700 + Math.random() * 600));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(id);
    }
  }
  throw lastErr;
}

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  { timeoutMs = 75_000, onTick }: { timeoutMs?: number; onTick?: () => Promise<void> | void } = {}
): Promise<void> {
  console.log('⏳ Waiting for confirmation (up to', Math.round(timeoutMs / 1000), 's)…');
  const start = Date.now();
  let lastLog = 0;
  let lastRebroadcast = 0;

  while (Date.now() - start < timeoutMs) {
    const st = await connection.getSignatureStatuses([signature]);
    const s = st.value[0];
    if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      console.log('✅ Confirmed with status:', s.confirmationStatus);
      return;
    }

    const t = Date.now() - start;
    if (t - lastLog >= 5000) {
      console.log(`… still waiting (${Math.round(t / 1000)}s)`);
      lastLog = t;
    }
    if (onTick && t - lastRebroadcast >= 5000) {
      try {
        await onTick();
      } catch (e: any) {
        console.warn('↻ Re-broadcast error (ignored):', e?.message ?? e);
      }
      lastRebroadcast = t;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Confirmation timeout');
}

async function jupiterTrade(
  connection: Connection,
  wallet: Keypair,
  op: 'buy' | 'sell',
  tokenMint: string,
  amountArg: string,                  // ⬅️ теперь строка: buy -> SOL, sell -> RAW токена
  slippageBps = SLIPPAGE_BPS
) {
  console.log('================ JUPITER TRADE ================');

  const isBuy = (op === 'buy');
  if (isBuy) {
    const amountSol = Number(amountArg);
    console.log('🎛  Params:', { op, tokenMint, amountSol, slippageBps });
    const lamports = Math.floor(amountSol * 1e9);
    if (lamports <= 0) throw new Error('Amount in SOL is too small');

    const inputMint = WSOL_MINT;
    const outputMint = tokenMint;
    const swapMode = 'ExactIn';
    const amountParam = lamports;
    console.log('🔁 Swap Direction: SOL→TOKEN');
    console.log('🔧 Mints:', { inputMint, outputMint, swapMode, amountParam });

    const { agent: jupAgent } = getJupiterProxyAgent();

    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote` +
      `?inputMint=${inputMint}` +
      `&outputMint=${outputMint}` +
      `&amount=${amountParam}` +
      `&slippageBps=${slippageBps}` +
      `&onlyDirectRoutes=false` +
      `&swapMode=${swapMode}`;

    console.log('📦 Fetching Jupiter quote…');
    const quote = await fetchJson<any>(quoteUrl, 20000, jupAgent, 2);
    const quoteResponse = quote.data ? (quote.data[0] ?? quote.data) : quote;
    if (!quoteResponse) throw new Error('Invalid quote from Jupiter');
    const miniQuote = {
      outAmount: quoteResponse.outAmount,
      otherAmountThreshold: quoteResponse.otherAmountThreshold,
      priceImpactPct: quoteResponse.priceImpactPct,
      inAmount: quoteResponse.inAmount,
      routePlanLen: Array.isArray(quoteResponse.routePlan) ? quoteResponse.routePlan.length : undefined,
      marketInfosLen: Array.isArray(quoteResponse.marketInfos) ? quoteResponse.marketInfos.length : undefined,
    };
    console.log('🧮 Quote summary:', miniQuote);

    console.log('🧾 Requesting Jupiter swap transaction…');
    const swap = await postJson<any>('https://quote-api.jup.ag/v6/swap', {
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 5000,
    }, 25000, jupAgent, 2);
    if (!swap?.swapTransaction) throw new Error('No swapTransaction in Jupiter response');
    console.log('📦 swapTransaction length (base64):', (swap.swapTransaction as string).length);

    console.log('✍️  Deserializing & signing transaction…');
    const buf = Buffer.from(swap.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
    const serialized = tx.serialize();
    console.log('📏 TX size (bytes):', serialized.length);

    console.log('🚀 Sending transaction to network…');
    const sig = await connection.sendRawTransaction(serialized, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
    console.log('🔎 Sent. Signature:', sig);
    console.log('🔗 Explorer:', 'https://solscan.io/tx/' + sig);

    await waitForConfirmation(connection, sig, {
      timeoutMs: 75_000,
      onTick: async () => {
        console.log('↻ Re-broadcasting same TX…');
        await connection.sendRawTransaction(serialized, {
          skipPreflight: true,
          maxRetries: 0,
        });
      },
    });

    console.log(`✅ ${op.toUpperCase()} SUCCESS:`, sig);
    console.log('===============================================');
    return sig;
  } else {
    // SELL via ExactIn: amountArg — это raw-кол-во токена (u64)
    const tokenRaw = BigInt(amountArg);
    console.log('🎛  Params:', { op, tokenMint, tokenRaw: tokenRaw.toString(), slippageBps });
    if (tokenRaw <= 0n) throw new Error('Token amount (raw) must be > 0');

    const inputMint = tokenMint;
    const outputMint = WSOL_MINT;
    const swapMode: 'ExactIn' = 'ExactIn';
    const amountParam = tokenRaw.toString(); // в URL — десятичная строка
    console.log('🔁 Swap Direction: TOKEN→SOL (ExactIn)');
    console.log('🔧 Mints:', { inputMint, outputMint, swapMode, amountParam });

    const { agent: jupAgent } = getJupiterProxyAgent();

    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote` +
      `?inputMint=${inputMint}` +
      `&outputMint=${outputMint}` +
      `&amount=${amountParam}` +
      `&slippageBps=${slippageBps}` +
      `&onlyDirectRoutes=false` +
      `&swapMode=${swapMode}`;

    console.log('📦 Fetching Jupiter quote…');
    const quote = await fetchJson<any>(quoteUrl, 20000, jupAgent, 2);
    const quoteResponse = quote.data ? (quote.data[0] ?? quote.data) : quote;
    if (!quoteResponse) throw new Error('Invalid quote from Jupiter');
    const miniQuote = {
      outAmount: quoteResponse.outAmount,
      otherAmountThreshold: quoteResponse.otherAmountThreshold,
      priceImpactPct: quoteResponse.priceImpactPct,
      inAmount: quoteResponse.inAmount,
      routePlanLen: Array.isArray(quoteResponse.routePlan) ? quoteResponse.routePlan.length : undefined,
      marketInfosLen: Array.isArray(quoteResponse.marketInfos) ? quoteResponse.marketInfos.length : undefined,
    };
    console.log('🧮 Quote summary:', miniQuote);

    console.log('🧾 Requesting Jupiter swap transaction…');
    const swap = await postJson<any>('https://quote-api.jup.ag/v6/swap', {
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 5000,
    }, 25000, jupAgent, 2);
    if (!swap?.swapTransaction) throw new Error('No swapTransaction in Jupiter response');
    console.log('📦 swapTransaction length (base64):', (swap.swapTransaction as string).length);

    console.log('✍️  Deserializing & signing transaction…');
    const buf = Buffer.from(swap.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
    const serialized = tx.serialize();
    console.log('📏 TX size (bytes):', serialized.length);

    console.log('🚀 Sending transaction to network…');
    const sig = await connection.sendRawTransaction(serialized, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
    console.log('🔎 Sent. Signature:', sig);
    console.log('🔗 Explorer:', 'https://solscan.io/tx/' + sig);

    await waitForConfirmation(connection, sig, {
      timeoutMs: 75_000,
      onTick: async () => {
        console.log('↻ Re-broadcasting same TX…');
        await connection.sendRawTransaction(serialized, {
          skipPreflight: true,
          maxRetries: 0,
        });
      },
    });

    console.log(`✅ ${op.toUpperCase()} SUCCESS:`, sig);
    console.log('===============================================');
    return sig;
  }
}

(async () => {
  try {
    console.log('🔰 trade_token.ts started with args:', process.argv.slice(2));
    const [, , rawOp, tokenMint, amountStr] = process.argv;

    if (!rawOp || !tokenMint || !amountStr) {
      console.log('Usage:');
      console.log('  BUY : ts-node trade_token.ts buy  <tokenMint> <amountSOL>');
      console.log('  SELL: ts-node trade_token.ts sell <tokenMint> <amountRAW>   # ExactIn by token amount (u64)');
      console.log('Examples:');
      console.log('  ts-node trade_token.ts buy  7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr 0.001');
      console.log('  ts-node trade_token.ts sell DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 500000000');
      process.exit(1);
    }

    const op = rawOp.toLowerCase() as 'buy' | 'sell';
    if (op !== 'buy' && op !== 'sell') throw new Error('Operation must be buy or sell');

    // Валидация аргумента по типу операции (без изменения остальной логики ниже)
    if (op === 'buy') {
      const n = Number(amountStr);
      if (!isFinite(n) || n <= 0) throw new Error('Amount (SOL) must be a positive number');
    } else {
      try {
        const bi = BigInt(amountStr);
        if (bi <= 0n) throw new Error('Amount (RAW) must be > 0');
      } catch {
        throw new Error('Amount (RAW) must be a valid integer string');
      }
    }

    console.log('⚙️  Initializing connection & wallet…');
    const connection = await getConnection();
    const wallet = parseKeypairFromEnv();

    const bal = await connection.getBalance(wallet.publicKey);
    console.log('💼 Wallet SOL balance:', (bal / 1e9).toFixed(9), 'SOL');

    if (op === 'buy') {
      const amountSol = Number(amountStr);
      const need = Math.floor(amountSol * 1e9) + 200_000; // +запас на комиссии
      console.log('🧮 Need lamports (with buffer):', need, '| Have:', bal);
      if (bal < need) throw new Error(`Not enough SOL. Have ${(bal/1e9).toFixed(6)} SOL, need ≥ ${(need/1e9).toFixed(6)} SOL`);
      console.log(`🚀 Buying token ${tokenMint.slice(0,8)}… amount: ${amountSol} SOL`);
    } else {
      const minFees = 200_000;
      console.log('🧮 Fee buffer for sell (lamports):', minFees, '| Have:', bal);
      if (bal < minFees) throw new Error(`Not enough SOL for fees. Have ${(bal/1e9).toFixed(6)} SOL`);
      console.log(`🚀 Selling token ${tokenMint.slice(0,8)}… amountRAW: ${amountStr}`);
    }

    await jupiterTrade(connection, wallet, op, tokenMint, amountStr);
  } catch (e: any) {
    console.error('❌ Error:', e?.message ?? e);
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  }
})();
