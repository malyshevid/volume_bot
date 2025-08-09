// trade_token.ts
import 'dotenv/config';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

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

async function fetchJson<T = any>(url: string, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal } as any);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} for ${url} ${txt ? '- ' + txt.slice(0, 200) + '…' : ''}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(id);
  }
}

async function postJson<T = any>(url: string, body: any, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal as any,
    } as any);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} for ${url}: ${txt.slice(0, 400)}${txt.length > 400 ? '…' : ''}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(id);
  }
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
  amountSol: number,
  slippageBps = SLIPPAGE_BPS
) {
  console.log('================ JUPITER TRADE ================');
  console.log('🎛  Params:', { op, tokenMint, amountSol, slippageBps });
  const lamports = Math.floor(amountSol * 1e9);
  if (lamports <= 0) throw new Error('Amount in SOL is too small');

  // buy: ExactIn (тратим X SOL), sell: ExactOut (получаем ровно X SOL)
  const isBuy = op === 'buy';
  const inputMint = isBuy ? WSOL_MINT : tokenMint;
  const outputMint = isBuy ? tokenMint : WSOL_MINT;
  const swapMode = isBuy ? 'ExactIn' : 'ExactOut';
  const amountParam = lamports; // для ExactIn — это input; для ExactOut — это output
  console.log('🔁 Swap Direction:', `${isBuy ? 'SOL→TOKEN' : 'TOKEN→SOL'}`);
  console.log('🔧 Mints:', { inputMint, outputMint, swapMode, amountParam });

  const quoteUrl =
    `https://quote-api.jup.ag/v6/quote` +
    `?inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amountParam}` +
    `&slippageBps=${slippageBps}` +
    `&onlyDirectRoutes=false` +
    `&swapMode=${swapMode}`;

  console.log('📦 Fetching Jupiter quote…');
  const quote = await fetchJson<any>(quoteUrl);
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
    wrapAndUnwrapSol: true, // обёртка/развёртка SOL
    computeUnitPriceMicroLamports: 5000, // чуть повышаем приоритет
  });
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

(async () => {
  try {
    console.log('🔰 trade_token.ts started with args:', process.argv.slice(2));
    const [, , rawOp, tokenMint, amountStr] = process.argv;

    if (!rawOp || !tokenMint || !amountStr) {
      console.log('Usage: ts-node trade_token.ts <buy|sell> <tokenMint> <amountSOL>');
      console.log('Example: ts-node trade_token.ts buy 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr 0.001');
      process.exit(1);
    }

    const op = rawOp.toLowerCase() as 'buy' | 'sell';
    if (op !== 'buy' && op !== 'sell') throw new Error('Operation must be buy or sell');

    const amountSol = Number(amountStr);
    if (!isFinite(amountSol) || amountSol <= 0) throw new Error('Amount must be a positive number');

    console.log('⚙️  Initializing connection & wallet…');
    const connection = await getConnection();
    const wallet = parseKeypairFromEnv();

    const bal = await connection.getBalance(wallet.publicKey);
    console.log('💼 Wallet SOL balance:', (bal / 1e9).toFixed(9), 'SOL');

    if (op === 'buy') {
      const need = Math.floor(amountSol * 1e9) + 200_000; // +запас на комиссии
      console.log('🧮 Need lamports (with buffer):', need, '| Have:', bal);
      if (bal < need) throw new Error(`Not enough SOL. Have ${(bal/1e9).toFixed(6)} SOL, need ≥ ${(need/1e9).toFixed(6)} SOL`);
    } else {
      const minFees = 200_000;
      console.log('🧮 Fee buffer for sell (lamports):', minFees, '| Have:', bal);
      if (bal < minFees) throw new Error(`Not enough SOL for fees. Have ${(bal/1e9).toFixed(6)} SOL`);
    }

    console.log(`🚀 ${op === 'buy' ? 'Buying' : 'Selling'} token ${tokenMint.slice(0,8)}… amount: ${amountSol} SOL`);
    await jupiterTrade(connection, wallet, op, tokenMint, amountSol);
  } catch (e: any) {
    console.error('❌ Error:', e?.message ?? e);
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  }
})();
