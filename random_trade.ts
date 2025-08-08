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

  const TOKENS = [
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'CreiuhfwdWCN5mJbMJtA9bBpYQrQF2tCBuZwSPWfpump',
  ];

  const poolsJson: any = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json').then(r => r.json());
  const poolMap = new Map<string, any>();
  const wsolMintStr = Token.WSOL.mint.toBase58();
  for (const mint of TOKENS) {
    const info = poolsJson.data.find(
      (p: any) =>
        (p.baseMint === mint && p.quoteMint === wsolMintStr) ||
        (p.quoteMint === mint && p.baseMint === wsolMintStr),
    );
    if (info) poolMap.set(mint, jsonInfo2PoolKeys(info));
  }

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
