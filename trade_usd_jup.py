# -------- 2. Проверяем, что оба токена торгуемы (Jupiter token list) --------
try:
    tokens = requests.get("https://token.jup.ag/all", timeout=TIMEOUT, headers=HEADERS)
    tokens.raise_for_status()
    token_list = tokens.json()
    tradable: set[str] = {t["address"] for t in token_list if t.get("trades") != 0 or t.get("extensions", {}).get("coingeckoId")}
    if from_mint not in tradable:
        sys.exit("❌ Входной токен не отмечен как торгуемый в Jupiter token list")
    if to_mint not in tradable:
        sys.exit("❌ Выходной токен не отмечен как торгуемый в Jupiter token list — попробуйте другой mint")
except Exception as err:
    print(f"⚠️ Не удалось скачать token list Jupiter ({err}). Продолжаем без проверки …")

# -------- 3. Получаем маршрут Jupiter -----------
quote_resp = requests.get(
    JUP_QUOTE_V6,
    params={
        "inputMint": from_mint,
        "outputMint": to_mint,
        "amount": atoms_in,
        "slippageBps": SLIPPAGE_BPS,
        "swapMode": "ExactIn",
    },
    timeout=TIMEOUT,
    headers=HEADERS,
)

try:
    quote_resp.raise_for_status()
except requests.HTTPError as e:
    sys.exit(f"❌ Ошибка quote‑API: {e} → {quote_resp.text[:300]}")

q_json = quote_resp.json()
# API v6 отдаёт либо {"data": [...]} либо сразу [...]
routes = q_json.get("data") if isinstance(q_json, dict) else q_json

if not routes:
    # Пытаемся показать пользователю минимальную входную сумму, если она есть в ответе
    min_in_atoms: int | None = None
    if isinstance(q_json, dict):
        min_in_atoms = q_json.get("minInAmount") or q_json.get("minIn")
    if min_in_atoms and isinstance(min_in_atoms, int) and min_in_atoms > atoms_in:
        min_usd = min_in_atoms / 10**input_dec * price_usd
        sys.exit(
            f"❌ Минимальный объём для этой пары ≈ {min_usd:.2f} USD "
            f"(minInAmount = {min_in_atoms}). Попробуйте увеличить сумму или другую пару."
        )
    # Если Jupiter вернул ошибку или пустой list – выводим весь ответ для диагностики
    print("🔍 Quote API raw response (truncated):", json.dumps(q_json, indent=2)[:800])
    sys.exit("❌ Jupiter не нашёл маршрут. Попробуйте чуть больше USD или другую пару.")

quote = routes[0]

# -------- 3. Получаем готовую swap‑tx ----------
try:
    swap_resp = requests.post(
        JUP_SWAP_V6,
        json={
            "quoteResponse": quote,
            "userPublicKey": str(owner.pubkey()),
            "wrapAndUnwrapSol": True,
        },
        timeout=TIMEOUT,
        headers=HEADERS,
    )
    swap_resp.raise_for_status()
except requests.HTTPError as e:
    sys.exit(f"❌ Ошибка swap‑API: {e} → {swap_resp.text[:300]}")

swap_json = swap_resp.json()
if "swapTransaction" not in swap_json:
    sys.exit("❌ Swap API не вернула swapTransaction: " + json.dumps(swap_json)[:400])

swap_b64 = swap_json["swapTransaction"]
trx = VersionedTransaction.from_bytes(base64.b64decode(swap_b64))
trx.sign([owner])

# -------- 4. Отправляем и выводим ссылку --------
try:
    sig = rpc_send_raw(trx.serialize())
except Exception as e:
    sys.exit(f"❌ RPC sendTransaction failed: {e}")

print("✅ Sent tx: https://explorer.solana.com/tx/" + sig)
