import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import {
  Raydium,
  PoolFetchType,
  ApiV3PoolInfoStandardItem,
  AmmV4Keys,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import 'dotenv/config';

/**
 * trade_usd.ts — Raydium swap «на сумму в USD» (упрощённая версия).
 * Логика поиска пулов взята из sniper-бота и адаптирована под SDK-v2.
 * Сделаны уступки по типам (cast → any), чтобы код компилировался без ручного
 * расширения d.ts Raydium — важнее скорость запуска, чем идеальная типизация.
 *
 * Запуск:
 *   ts-node trade_usd.ts <FROM_MINT> <TO_MINT> <USD_AMOUNT>
 */

type CGIdMap = Record<string, string>;
type DecimalsMap = Record<string, number>;

// ---------- настройки токенов (CoinGecko + fallback decimals)
const cgIdMap: CGIdMap = {
  'So11111111111111111111111111111111111111112': 'solana',    // wSOL
  '4k3Dyjzvzp8eVeL5tyQaTDz7d8p71v47o7i4ZMg967SL': 'raydium',  // RAY
  'EPjFWdd5AufqSSqeM2qN1xzyWXGKe9D591iMZuj7W1HQ': 'usd-coin', // USDC
};
const decimalsMap: DecimalsMap = {
  'So11111111111111111111111111111111111111112': 9,
  '4k3Dyjzvzp8eVeL5tyQaTDz7d8p71v47o7i4ZMg967SL': 6,
  'EPjFWdd5AufqSSqeM2qN1xzyWXGKe9D591iMZuj7W1HQ': 6,
};

async function fetchPriceUSD(mint: string): Promise<number> {
  const slug = cgIdMap[mint];
  if (!slug) throw new Error(`Добавьте mint→CoinGecko-id: ${mint}`);
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${slug}&vs_currencies=usd`,
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data: Record<string, any> = await res.json();
  const price = data[slug]?.usd as number | undefined;
  if (!price) throw new Error(`Цена не найдена для ${slug}`);
  return price;
}

// -----------------------------------------------------------------------------
// ▶︎ Поиск пула — 3 шага (API → список → RPC). Cast to any, чтобы не править d.ts
// -----------------------------------------------------------------------------
async function findPool(
  raydium: Raydium,
  mintA: string,
  mintB: string,
): Promise<ApiV3PoolInfoStandardItem | null> {
  // 1) fetchPoolByMints (оба направления)
  for (const [a, b] of [[mintA, mintB], [mintB, mintA]] as [string, string][]) {
    try {
      const map = await raydium.api.fetchPoolByMints({ mint1: a, mint2: b });
      const info = Object.values(map)[0] as ApiV3PoolInfoStandardItem | undefined;
      if (info) return info;
    } catch {
      /* ignore */
    }
  }

  // 2) getPoolList и фильтр
  try {
    const list: any[] = (await raydium.api.getPoolList({
      pageSize: 5000,
      type: PoolFetchType.All,
    }) as unknown as any[]);
    const match = list.find(
      (p: any) =>
        (p.baseMint === mintA && p.quoteMint === mintB) ||
        (p.baseMint === mintB && p.quoteMint === mintA),
    );
    if (match) return match as ApiV3PoolInfoStandardItem;
  } catch {
    /* ignore */
  }

  // 3) on-chain RPC scan (дороже)
  try {
    const rpcPools: any[] = (await raydium.liquidity.getRpcPoolInfos([]) as unknown as any[]);
    const found = rpcPools.find(
      (p: any) =>
        (p.baseMint.toString() === mintA && p.quoteMint.toString() === mintB) ||
        (p.baseMint.toString() === mintB && p.quoteMint.toString() === mintA),
    );
    if (found) return found as ApiV3PoolInfoStandardItem;
  } catch {
    /* ignore */
  }

  return null; // не нашли
}

// -----------------------------------------------------------------------------
// ▶︎ Один своп в найденном пуле
// -----------------------------------------------------------------------------
async function ammSwap(
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoStandardItem,
  amountAtoms: number,
  fromMint: string,
  toMint: string,
  slippageBps: number,
): Promise<void> {
  console.log(`--- Swap: ${fromMint} → ${toMint} (atoms=${amountAtoms})`);
  const poolKeys: AmmV4Keys = await raydium.liquidity.getAmmPoolKeys(poolInfo.id);
  const { minAmountOut } = raydium.liquidity.computeAmountOut({
    poolInfo: poolInfo as any, // cast → any для обхода d.ts
    amountIn: new BN(amountAtoms),
    mintIn: new PublicKey(fromMint),
    mintOut: new PublicKey(toMint),
    slippage: slippageBps / 10_000,
  });
  const { execute } = await raydium.liquidity.swap({
    poolInfo: poolInfo as any,
    poolKeys,
    amountIn: new BN(amountAtoms),
    amountOut: minAmountOut,
    fixedSide: 'in',
    inputMint: fromMint,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`✅ Swap tx: https://explorer.solana.com/tx/${txId}?cluster=mainnet`);
}

// -----------------------------------------------------------------------------
// ▶︎ main()
// -----------------------------------------------------------------------------
async function main(): Promise<void> {
  const {
    RPC_URL = 'https://api.mainnet-beta.solana.com',
    KEYPAIR_PATH = './id.json',
    SLIPPAGE_BPS = '100', // 1 %
  } = process.env;

  const [fromMintStr, toMintStr, usdStr] = process.argv.slice(2);
  if (!fromMintStr || !toMintStr || !usdStr) {
    console.error('Usage: ts-node trade_usd.ts <FROM_MINT> <TO_MINT> <USD_AMOUNT>');
    process.exit(1);
  }
  const USD_AMOUNT = Number(usdStr);
  if (!Number.isFinite(USD_AMOUNT) || USD_AMOUNT <= 0) {
    console.error('USD_AMOUNT must be a positive number');
    process.exit(1);
  }

  // ключ + соединение
  const connection = new Connection(RPC_URL, 'confirmed');
  const secret = Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')));
  const wallet = Keypair.fromSecretKey(secret);

  // amountIn
  let decimals: number;
  try {
    decimals = (await getMint(connection, new PublicKey(fromMintStr))).decimals;
  } catch {
    decimals = decimalsMap[fromMintStr]!;
    console.warn(`⚠️ RPC failed, using decimals=${decimals}`);
  }
  const priceUsd = await fetchPriceUSD(fromMintStr);
  const amountInAtoms = Math.round((USD_AMOUNT / priceUsd) * 10 ** decimals);
  console.log(
    `➜ Продаём ≈ ${(USD_AMOUNT / priceUsd).toFixed(6)} ` +
      `(atoms: ${amountInAtoms}) по цене ${priceUsd.toFixed(4)} USD`,
  );

  const raydium = await Raydium.load({ connection, owner: wallet });

  // direct pool?
  const directPool = await findPool(raydium, fromMintStr, toMintStr);
  if (directPool) {
    console.log('⚡ Direct pool found — swapping');
    await ammSwap(
      raydium,
      directPool,
      amountInAtoms,
      fromMintStr,
      toMintStr,
      Number(SLIPPAGE_BPS),
    );
    return;
  }

  // hop via USDC
  console.log('⚠️ Direct pool not found — hopping via USDC');
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzyWXGKe9D591iMZuj7W1HQ';

  // from → USDC
  const pool1 = await findPool(raydium, fromMintStr, USDC_MINT);
  if (!pool1) throw new Error('Не найден пул from/USDC');
  await ammSwap(
    raydium,
    pool1,
    amountInAtoms,
    fromMintStr,
    USDC_MINT,
    Number(SLIPPAGE_BPS),
  );

  // USDC → to
  const usdcAtoms = Math.round(USD_AMOUNT * 10 ** decimalsMap[USDC_MINT]);
  const pool2 = await findPool(raydium, USDC_MINT, toMintStr);
  if (!pool2) throw new Error('Не найден пул USDC/to');
  await ammSwap(
    raydium,
    pool2,
    usdcAtoms,
    USDC_MINT,
    toMintStr,
    Number(SLIPPAGE_BPS),
  );
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});