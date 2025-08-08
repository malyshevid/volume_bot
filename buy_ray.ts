// buy_ray.ts  –  одиночный своп 0.01 SOL → RAY через Raydium
//------------------------------------------------------------
import dotenv from 'dotenv';
import bs58 from 'bs58';
import fetch from 'node-fetch';

import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { Liquidity, Token, jsonInfo2PoolKeys } from '@raydium-io/raydium-sdk';
import { getTokenAccounts } from './liquidity'; // поправьте путь, если файл лежит иначе

import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

// ──────────────────────────────────────────────────────────────
//                     маленький helper-retry
// ──────────────────────────────────────────────────────────────
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

dotenv.config();

(async () => {
  // 1️⃣  кошелёк ──────────────────────────────────────────────
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing');
  const secret = pk.trim().startsWith('[') ? Uint8Array.from(JSON.parse(pk)) : bs58.decode(pk.trim());
  const wallet = Keypair.fromSecretKey(secret);
  console.log('✅ Wallet', wallet.publicKey.toBase58());

  // 2️⃣  RPC (сначала личный Helius / QuickNode, потом fallback) ────────────
  const RPC_LIST = [
    process.env.HELIUS_KEY && `https://rpc.helius.xyz/?api-key=${process.env.HELIUS_KEY}`,
    process.env.QUICKNODE_RPC,
    'https://rpc.helio.io/',
    'https://solana.public-rpc.com',
  ].filter(Boolean) as string[];

  let connection: Connection | undefined;
  for (const url of RPC_LIST) {
    try {
      const c = new Connection(url, 'confirmed');
      await c.getLatestBlockhash();
      connection = c;
      console.log('✅ RPC', url);
      break;
    } catch {
      console.warn('⚠️ RPC dead:', url);
    }
  }
  if (!connection) throw new Error('No alive RPC');

  // 3️⃣  пул RAY/SOL c Raydium-API ────────────────────────────
  const poolsJson: any = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json').then(r =>
    r.json(),
  );

  const RAY_MINT = new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R');
  const WSOL_MINT = Token.WSOL.mint;

  const raySolInfo = poolsJson.data.find(
    (p: any) =>
      (p.baseMint === RAY_MINT.toBase58() && p.quoteMint === WSOL_MINT.toBase58()) ||
      (p.quoteMint === RAY_MINT.toBase58() && p.baseMint === WSOL_MINT.toBase58()),
  );
  if (!raySolInfo) throw new Error('RAY/SOL pool not found in Raydium API');

  const poolKeys = jsonInfo2PoolKeys(raySolInfo);
  console.log('✅ Pool', poolKeys.id.toBase58());

  // 4️⃣  токен-аккаунты пользователя ──────────────────────────
  const tokenAccs: any[] = await getTokenAccounts(connection, wallet.publicKey);
  const wsolAcc = tokenAccs.find(t => t.accountInfo.mint.equals(WSOL_MINT));
  if (!wsolAcc) throw new Error('No WSOL account in wallet (wrap some SOL first)');

  const rayATA = getAssociatedTokenAddressSync(RAY_MINT, wallet.publicKey);

  // 5️⃣  строим своп 0.01 SOL → RAY ───────────────────────────
  const lamportsIn = BigInt(Math.round(0.01 * 1e9)); // 0.01 SOL

  const { innerTransactions } = await (Liquidity as any).makeSwapInstructionSimple({
    connection,
    poolKeys: poolKeys as any,
    userKeys: { owner: wallet.publicKey, tokenAccounts: [wsolAcc] },
    amountIn: lamportsIn as any, // SDK принимает BN/TokenAmount, используем any
    amountOutMin: 0 as any,
    fixedSide: 'in',
    makeTxVersion: 'legacy',
    config: { bypassAssociatedCheck: true },
  });

  // 6️⃣  финальная транзакция ─────────────────────────────────
  const latestBlockhash = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        rayATA,
        wallet.publicKey,
        RAY_MINT,
      ),
      ...innerTransactions.flatMap((itx: any) => itx.instructions),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  const extraSigners = innerTransactions.flatMap((itx: any) => itx.signers ?? []);
  tx.sign([wallet, ...extraSigners]);

  const sig = await retry(
    () => connection!.sendRawTransaction(tx.serialize(), { skipPreflight: true }),
    3,
    700,
  );
  console.log('🟢 Swap sent → https://solscan.io/tx/' + sig);
})();
