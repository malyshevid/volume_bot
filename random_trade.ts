import dotenv from 'dotenv';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  Liquidity,
  Token,
  jsonInfo2PoolKeys,
} from '@raydium-io/raydium-sdk';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { getTokenAccounts } from './liquidity';

async function retry<T>(fn: () => Promise<T>, tries = 3, delayMs = 800): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function randomPortion(amount: bigint): bigint {
  const n = Number(amount);
  const frac = Math.random();
  const portion = Math.floor(n * frac);
  return BigInt(Math.max(1, portion));
}

dotenv.config();

(async () => {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing');
  const secret = pk.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(pk))
    : bs58.decode(pk.trim());
  const wallet = Keypair.fromSecretKey(secret);

  // ---------------- RPC (исправлено) ----------------
  const RPC_LIST = [
    process.env.HELIUS_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}`,
    process.env.QUICKNODE_RPC,
    process.env.ALCHEMY_RPC,
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-rpc.publicnode.com',
    'https://rpc.shyft.to/solana/mainnet?api_key=public',
  ].filter(Boolean) as string[];

  function withTimeout<T>(p: Promise<T>, ms = 7000) {
    return Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  }

  let connection: Connection | undefined;
  for (const url of RPC_LIST) {
    try {
      const c = new Connection(url, { commitment: 'confirmed' });
      await withTimeout(c.getLatestBlockhash(), 7000);
      connection = c;
      console.log('✅ RPC', url);
      break;
    } catch (e: any) {
      console.warn('⚠️ RPC dead:', url, e?.message ?? e);
    }
  }
  if (!connection) throw new Error('No alive RPC');

  // ---------------- Минты (исправлено) ----------------
  const TOKENS = [
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // пример
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'CreiuhfwdWCN5mJbMJtA9bBpYQrQF2tCBuZwSPWfpump',
  ];

  // ---------------- Получение пулов ----------------
  const RAY_V3 = 'https://api-v3.raydium.io';
  const RAY_V2_BASE = 'https://api.raydium.io/v2/sdk/liquidity';
  const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
  const poolMap = new Map<string, any>();
  const wsolMintStr = Token.WSOL.mint.toBase58();

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

  // v3: попытка найти пул по паре mint ↔ WSOL
  async function tryV3Resolve(mint: string): Promise<any | undefined> {
    const tryUrls = [
      `${RAY_V3}/pools/info/mint?mints=${mint},${wsolMintStr}`,
      `${RAY_V3}/pools/info/mint?mint1=${mint}&mint2=${wsolMintStr}`,
      `${RAY_V3}/pools/info/mint?mint1=${wsolMintStr}&mint2=${mint}`,
    ];
    for (const u of tryUrls) {
      try {
        const infoResp: any = await fetchJson(u);
        const pools: any[] = Array.isArray(infoResp?.data)
          ? infoResp.data
          : (infoResp?.pools || infoResp || []);
        if (!pools?.length) continue;
        const target = pools.find((p: any) => {
          const base = p.baseMint || p.base?.mint;
          const quote = p.quoteMint || p.quote?.mint;
          return (base === mint && quote === wsolMintStr) || (quote === mint && base === wsolMintStr);
        }) || pools[0];
        if (!target) continue;

        const poolId = target.id || target.poolId || target.ammId;
        if (!poolId) continue;

        const keysResp: any = await fetchJson(`${RAY_V3}/pools/key/ids?ids=${poolId}`);
        const kd = Array.isArray(keysResp?.data) ? keysResp.data[0] : (keysResp?.data || keysResp)[0] || keysResp;

        const jsonLike = {
          id: poolId,
          baseMint: (target.baseMint || target.base?.mint),
          quoteMint: (target.quoteMint || target.quote?.mint),
          lpMint: target.lpMint || kd?.lpMint,
          openOrders: kd?.openOrders,
          targetOrders: kd?.targetOrders,
          marketId: kd?.marketId,
          marketProgramId: kd?.marketProgramId,
          authority: kd?.authority,
          ammId: kd?.ammId || poolId,
          ammOpenOrders: kd?.ammOpenOrders,
          ammTargetOrders: kd?.ammTargetOrders,
          poolCoinTokenAccount: kd?.poolCoinTokenAccount,
          poolPcTokenAccount: kd?.poolPcTokenAccount,
          serumProgramId: kd?.serumProgramId || kd?.marketProgramId,
          programId: kd?.programId || kd?.ammProgramId,
        };

        return jsonInfo2PoolKeys(jsonLike as any);
      } catch {
        // next
      }
    }
    return undefined;
  }

  // v2: небольшой JSON-список ammV4/clmm как фоллбэк
  async function tryV2Resolve(mint: string): Promise<any | undefined> {
    const urls = [
      `${RAY_V2_BASE}/ammV4.json`,
      `${RAY_V2_BASE}/clmm.json`,
    ];
    for (const u of urls) {
      try {
        const data: any = await fetchJson(u);
        const list = Array.isArray(data?.data) ? data.data : data;
        if (!Array.isArray(list)) continue;

        const info = list.find((p: any) =>
          (p.baseMint === mint && p.quoteMint === wsolMintStr) ||
          (p.quoteMint === mint && p.baseMint === wsolMintStr)
        );
        if (info) return jsonInfo2PoolKeys(info);
      } catch {
        // next
      }
    }
    return undefined;
  }

  // Jupiter: берём прямой маршрут и вытаскиваем Raydium poolId → ключи Raydium
  async function tryJupiterResolve(mint: string): Promise<any | undefined> {
    try {
      const url = `${JUP_QUOTE}?inputMint=${mint}&outputMint=${wsolMintStr}&onlyDirectRoutes=true&swapMode=ExactIn`;
      const j: any = await fetchJson(url, 10000);

      const quotes: any[] = Array.isArray(j?.data) ? j.data : [];
      for (const q of quotes) {
        const mis: any[] = Array.isArray(q?.marketInfos) ? q.marketInfos : [];
        for (const mi of mis) {
          const amm = (mi?.amm || mi?.label || '').toString().toLowerCase();
          if (!amm.includes('raydium')) continue;

          const poolId = mi?.id || mi?.poolAddress || mi?.address || mi?.ammId;
          if (!poolId) continue;

          try {
            const keysResp: any = await fetchJson(`${RAY_V3}/pools/key/ids?ids=${poolId}`);
            const kd = Array.isArray(keysResp?.data) ? keysResp.data[0] : (keysResp?.data || keysResp)[0] || keysResp;

            const jsonLike = {
              id: poolId,
              baseMint: mi?.inputMint ?? mint,
              quoteMint: mi?.outputMint ?? wsolMintStr,
              lpMint: kd?.lpMint,
              openOrders: kd?.openOrders,
              targetOrders: kd?.targetOrders,
              marketId: kd?.marketId,
              marketProgramId: kd?.marketProgramId,
              authority: kd?.authority,
              ammId: kd?.ammId || poolId,
              ammOpenOrders: kd?.ammOpenOrders,
              ammTargetOrders: kd?.ammTargetOrders,
              poolCoinTokenAccount: kd?.poolCoinTokenAccount,
              poolPcTokenAccount: kd?.poolPcTokenAccount,
              serumProgramId: kd?.serumProgramId || kd?.marketProgramId,
              programId: kd?.programId || kd?.ammProgramId,
            };

            return jsonInfo2PoolKeys(jsonLike as any);
          } catch {
            // try next marketInfo
          }
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  for (const mint of TOKENS) {
    let poolKeys: any | undefined = await tryV3Resolve(mint);
    if (!poolKeys) poolKeys = await tryV2Resolve(mint);
    if (!poolKeys) poolKeys = await tryJupiterResolve(mint);

    if (poolKeys) {
      poolMap.set(mint, poolKeys);
      console.log('✅ Pool resolved for', mint);
    } else {
      console.warn('⚠️ Pool not found for', mint);
    }
  }
  // ---------------- конец получения пулов ----------------

  async function buy(tokenMint: PublicKey, poolKeys: any) {
    const solBalance = await connection!.getBalance(wallet.publicKey);
    if (solBalance < 1e7) {
      console.log('💤 Not enough SOL to buy');
      return;
    }
    const amountIn = BigInt(Math.floor(solBalance * Math.random()));
    const wsolAta = getAssociatedTokenAddressSync(Token.WSOL.mint, wallet.publicKey);
    const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

    const { innerTransactions } = await (Liquidity as any).makeSwapInstructionSimple({
      connection,
      poolKeys,
      userKeys: { owner: wallet.publicKey, tokenAccounts: [] },
      amountIn: amountIn as any,
      amountOutMin: 0 as any,
      fixedSide: 'in',
      makeTxVersion: 'legacy',
      config: { bypassAssociatedCheck: true },
    });

    const instructions = [
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        wsolAta,
        wallet.publicKey,
        Token.WSOL.mint,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        tokenAta,
        wallet.publicKey,
        tokenMint,
      ),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: Number(amountIn) }),
      createSyncNativeInstruction(wsolAta),
      ...innerTransactions.flatMap((itx: any) => itx.instructions),
      createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey),
    ];

    const latestBlockhash = await connection!.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    const extraSigners = innerTransactions.flatMap((itx: any) => itx.signers ?? []);
    tx.sign([wallet, ...extraSigners]);
    const sig = await retry(() => connection!.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
    console.log('🟢 Buy sent https://solscan.io/tx/' + sig);
  }

  async function sell(tokenMint: PublicKey, poolKeys: any) {
    const tokenAccounts = await getTokenAccounts(connection!, wallet.publicKey);
    const tokenAcc = tokenAccounts.find(t => t.accountInfo.mint.equals(tokenMint));
    if (!tokenAcc) {
      console.log('💤 No token balance to sell');
      return;
    }
    const amountAvailable = BigInt(tokenAcc.accountInfo.amount.toString());
    if (amountAvailable <= 0n) {
      console.log('💤 Token balance is zero');
      return;
    }
    const amountIn = randomPortion(amountAvailable);
    const wsolAta = getAssociatedTokenAddressSync(Token.WSOL.mint, wallet.publicKey);

    const { innerTransactions } = await (Liquidity as any).makeSwapInstructionSimple({
      connection,
      poolKeys,
      userKeys: { owner: wallet.publicKey, tokenAccounts: [tokenAcc] },
      amountIn: amountIn as any,
      amountOutMin: 0 as any,
      fixedSide: 'in',
      makeTxVersion: 'legacy',
      config: { bypassAssociatedCheck: true },
    });

    const instructions = [
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        wsolAta,
        wallet.publicKey,
        Token.WSOL.mint,
      ),
      ...innerTransactions.flatMap((itx: any) => itx.instructions),
      createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey),
    ];

    const latestBlockhash = await connection!.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    const extraSigners = innerTransactions.flatMap((itx: any) => itx.signers ?? []);
    tx.sign([wallet, ...extraSigners]);
    const sig = await retry(() => connection!.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
    console.log('🔴 Sell sent https://solscan.io/tx/' + sig);
  }

  while (true) {
    const action = Math.random() < 0.5 ? 'buy' : 'sell';
    const mintStr = TOKENS[Math.floor(Math.random() * TOKENS.length)];
    const poolKeys = poolMap.get(mintStr);
    if (!poolKeys) {
      console.log('⚠️ Pool not found for', mintStr);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    const tokenMint = new PublicKey(mintStr);
    try {
      if (action === 'buy') {
        console.log('🚀 Buying', mintStr);
        await buy(tokenMint, poolKeys);
      } else {
        console.log('💰 Selling', mintStr);
        await sell(tokenMint, poolKeys);
      }
    } catch (e) {
      console.error('Trade failed', e);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
})();
