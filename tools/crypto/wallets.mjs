// Watch-only wallets for the crypto CLI: balances read from public
// blockchains by address. No keys are involved, nothing can be moved.
//
// - EVM addresses (0x…) are read on every chain in CHAINS: the native coin
//   plus a short list of common tokens (stablecoins, wrapped ETH/BTC). Other
//   tokens are not discovered (that needs a paid indexer).
// - Bitcoin addresses (bc1…, 1…, 3…) through mempool.space.
// - Solana addresses through the public RPC, with every token account found.
//
// Every chain has a backup endpoint, tried when the first one fails.
// Addresses are public data; they are sent to these public endpoints only.

/** Public, keyless JSON-RPC endpoints per EVM chain, in the order tried. */
export const CHAINS = {
  ethereum: { rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], native: "ETH" },
  polygon: { rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"], native: "POL" },
  base: { rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org"], native: "ETH" },
  arbitrum: { rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"], native: "ETH" },
  optimism: { rpcs: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"], native: "ETH" },
  bsc: { rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"], native: "BNB" },
};

/** Tokens checked on each EVM chain: [symbol used for pricing, contract]. Decimals are read on chain. */
export const TOKENS = {
  ethereum: [
    ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
    ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F"],
    ["EURC", "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"],
    ["ETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"], // WETH
    ["BTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"], // WBTC
  ],
  polygon: [
    ["USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
    ["USDC", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"], // USDC.e (bridged)
    ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"],
    ["ETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"], // WETH
  ],
  base: [
    ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    ["EURC", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"],
  ],
  arbitrum: [
    ["USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
    ["USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"],
  ],
  optimism: [
    ["USDC", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"],
    ["USDT", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"],
  ],
  bsc: [
    ["USDT", "0x55d398326f99059fF775485246999027B3197955"],
    ["USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"],
  ],
};

const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
/** Esplora APIs with the same /api/address/<addr> answer, in the order tried. */
const BITCOIN_APIS = ["https://mempool.space/api", "https://blockstream.info/api"];
/** Solana mints we can name and price. */
const SOLANA_MINTS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};
const SPL_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/**
 * Which chain family an address belongs to.
 * @param {string} address @returns {"evm" | "bitcoin" | "solana" | null}
 */
export function addressKind(address) {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "evm";
  if (/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a)) return "bitcoin";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "solana";
  return null;
}

/**
 * Try `call` on each endpoint in turn; the first answer wins, and only when
 * every endpoint fails does the last error come out.
 * @template T @param {string[]} urls @param {(url: string) => Promise<T>} call @returns {Promise<T>}
 */
async function firstAnswer(urls, call) {
  let last;
  for (const url of urls) {
    try {
      return await call(url);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * POST a JSON-RPC call to the first endpoint that answers. A rate limit, an
 * HTML challenge page or a reply with no result counts as a failure, never
 * as a zero balance.
 * @param {string[]} urls @param {string} method @param {unknown[]} params
 */
function rpc(urls, method, params) {
  return firstAnswer(urls, async (url) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`${method}: HTTP ${res.status}, not a JSON-RPC answer`);
    if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
    if (json.result === undefined || json.result === null) throw new Error(`${method}: no result`);
    return json.result;
  });
}

/** A hex quantity scaled by `decimals`. @param {string} hex @param {number} decimals */
function scaled(hex, decimals) {
  const v = BigInt(hex && hex !== "0x" ? hex : "0x0");
  const base = 10n ** BigInt(decimals);
  return Number(v / base) + Number(v % base) / Number(base);
}

/** ERC-20 balanceOf / decimals call data. */
const balanceOfData = (/** @type {string} */ owner) => `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
const DECIMALS = "0x313ce567";

/**
 * Non-zero holdings of an EVM address on one chain.
 * @param {string} chain @param {string} address
 * @returns {Promise<{ asset: string, amount: number, chain: string, token?: string }[]>}
 */
async function evmHoldings(chain, address) {
  const { rpcs: urls, native } = CHAINS[chain];
  const out = [];
  const wei = await rpc(urls, "eth_getBalance", [address, "latest"]);
  const coin = scaled(wei, 18);
  if (coin > 0) out.push({ asset: native, amount: coin, chain });
  const tokens = await Promise.all(
    TOKENS[chain].map(async ([asset, token]) => {
      const raw = await rpc(urls, "eth_call", [{ to: token, data: balanceOfData(address) }, "latest"]);
      if (BigInt(raw && raw !== "0x" ? raw : "0x0") === 0n) return null;
      const decimals = Number(BigInt(await rpc(urls, "eth_call", [{ to: token, data: DECIMALS }, "latest"])));
      return { asset, amount: scaled(raw, decimals), chain, token };
    }),
  );
  return out.concat(tokens.filter(Boolean));
}

/** Confirmed + pending BTC of an address. @param {string} address */
async function bitcoinHoldings(address) {
  const j = await firstAnswer(BITCOIN_APIS, async (api) => {
    const res = await fetch(`${api}/address/${address}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${new URL(api).host}: HTTP ${res.status}`);
    return res.json();
  });
  const sats =
    j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum + (j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum);
  return sats > 0 ? [{ asset: "BTC", amount: sats / 1e8, chain: "bitcoin" }] : [];
}

/** SOL plus every SPL token account of an address. @param {string} address */
async function solanaHoldings(address) {
  const out = [];
  const lamports = (await rpc(SOLANA_RPCS, "getBalance", [address])).value;
  if (lamports > 0) out.push({ asset: "SOL", amount: lamports / 1e9, chain: "solana" });
  for (const programId of SPL_PROGRAMS) {
    const accounts = await rpc(SOLANA_RPCS, "getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]);
    for (const a of accounts.value ?? []) {
      const info = a.account.data.parsed.info;
      const amount = Number(info.tokenAmount.uiAmount ?? 0);
      if (amount > 0) out.push({ asset: SOLANA_MINTS[info.mint] ?? `SPL:${info.mint.slice(0, 8)}…`, amount, chain: "solana", token: info.mint });
    }
  }
  return out;
}

/**
 * Holdings of one watched wallet, per chain. A chain that fails is reported
 * in `errors` instead of failing the whole wallet.
 * @param {{ address: string, chains?: string[] }} wallet
 */
export async function walletHoldings(wallet) {
  const kind = addressKind(wallet.address);
  /** @type {string[]} */
  const errors = [];
  /** @type {{ asset: string, amount: number, chain: string, token?: string }[]} */
  let holdings = [];
  const attempt = async (/** @type {string} */ chain, /** @type {() => Promise<any[]>} */ read) => {
    try {
      // Await first: chains are read at once, and `holdings = holdings.concat(await …)`
      // would take `holdings` before the wait and drop the chains that finished meanwhile.
      const got = await read();
      holdings = holdings.concat(got);
    } catch (err) {
      errors.push(`${chain}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  };
  if (kind === "evm") {
    const chains = wallet.chains?.length ? wallet.chains : Object.keys(CHAINS);
    await Promise.all(chains.map((c) => attempt(c, () => evmHoldings(c, wallet.address))));
  } else if (kind === "bitcoin") await attempt("bitcoin", () => bitcoinHoldings(wallet.address));
  else if (kind === "solana") await attempt("solana", () => solanaHoldings(wallet.address));
  else errors.push("unrecognised address format");
  return { holdings, errors };
}
