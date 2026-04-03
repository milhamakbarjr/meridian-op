import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.join(__dirname, "smart-wallets.json");
const POOL_MEMORY_PATH = path.join(__dirname, "pool-memory.json");

// ── LPAgent API (free-tier safe) ────────────────────────────────────────────
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const LPAGENT_KEYS = (process.env.LPAGENT_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let _lpKeyIndex = 0;
function nextLpKey() {
  if (!LPAGENT_KEYS.length) return null;
  const key = LPAGENT_KEYS[_lpKeyIndex % LPAGENT_KEYS.length];
  _lpKeyIndex++;
  return key;
}

// 13s between calls ≈ 4 req/min — comfortably under the ~5 req/min free-tier limit
const SWEEP_SLEEP_MS = 13_000;
const MAX_TRACKED_WALLETS = 20;

// Promotion criteria — stricter than study_top_lpers filters
const PROMOTE_CRITERIA = {
  minWinRate:  0.65,
  minLpCount:  10,
  minPnl:      0,    // must be net-positive
  minInflow:   500,  // USD — excludes micro/test wallets
};

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({ name, address, category = "alpha", type = "lp" }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  data.wallets.push({ name, address, category, type, addedAt: new Date().toISOString() });
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export function removeSmartWallet({ address }) {
  const data = loadWallets();
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets() {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool({ pool_address }) {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        const { positions } = await getWalletPositions({ wallet_address: wallet.address });
        _cache.set(wallet.address, { positions: positions || [], fetchedAt: Date.now() });
        return { wallet, positions: positions || [] };
      } catch {
        return { wallet, positions: [] };
      }
    })
  );

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}

// ── Auto-promotion ───────────────────────────────────────────────────────────

/**
 * Evaluate a raw top-lpers array (from LPAgent) and add any wallet that passes
 * PROMOTE_CRITERIA into smart-wallets.json. No extra API calls — called passively
 * inside studyTopLPers() for zero marginal cost.
 *
 * @param {Array}  lpers       Raw top-lpers objects from LPAgent API
 * @param {string} poolAddress Pool the lpers were fetched from (for audit trail)
 * @returns {string[]} Addresses of newly added wallets
 */
export function autoPromoteFromStudy(lpers, poolAddress) {
  const data = loadWallets();
  if (data.wallets.length >= MAX_TRACKED_WALLETS) return [];

  const existingAddresses = new Set(data.wallets.map(w => w.address));
  const added = [];

  for (const lper of lpers) {
    if (data.wallets.length >= MAX_TRACKED_WALLETS) break;
    if (!lper.owner || !SOLANA_PUBKEY_RE.test(lper.owner)) continue;
    if (existingAddresses.has(lper.owner)) continue;
    if ((lper.win_rate ?? 0) < PROMOTE_CRITERIA.minWinRate) continue;
    if ((lper.total_lp ?? 0) < PROMOTE_CRITERIA.minLpCount) continue;
    if ((lper.total_pnl ?? 0) <= PROMOTE_CRITERIA.minPnl) continue;
    if ((lper.total_inflow ?? 0) < PROMOTE_CRITERIA.minInflow) continue;

    const wallet = {
      name: `auto-${lper.owner.slice(0, 8)}`,
      address: lper.owner,
      category: "alpha",
      type: "lp",
      addedAt: new Date().toISOString(),
      addedFrom: poolAddress || "study",
      autoAdded: true,
      notes: `Auto: ${Math.round((lper.win_rate ?? 0) * 100)}% WR, $${Math.round(lper.total_pnl ?? 0)} PnL, ${lper.total_lp} pos, ${parseFloat(((lper.avg_age_hour ?? 0)).toFixed(1))}h hold`,
    };

    data.wallets.push(wallet);
    existingAddresses.add(lper.owner);
    added.push(lper.owner);
    log("smart_wallets", `Auto-promoted: ${wallet.name} from ${(poolAddress || "study").slice(0, 8)} — ${wallet.notes}`);
  }

  if (added.length > 0) saveWallets(data);
  return added;
}

/**
 * Active sweep: call top-lpers on a list of pools, auto-promote qualifiers.
 * Respects free-tier rate limits (~4 req/min) via SWEEP_SLEEP_MS delay.
 * Falls back to pool-memory.json if no pool_addresses provided.
 *
 * @param {string[]} [pool_addresses] Pool addresses to sweep. Defaults to pool-memory keys.
 * @returns {{ success, swept_pools, new_wallets, total_tracked, details }}
 */
export async function sweepWalletsFromPools({ pool_addresses } = {}) {
  const key = nextLpKey();
  if (!key) {
    return { success: false, error: "LPAGENT_API_KEY not set — wallet sweep disabled", new_wallets: [] };
  }

  // Resolve pool list: explicit param → pool-memory.json → empty
  let pools = Array.isArray(pool_addresses) && pool_addresses.length ? pool_addresses : [];
  if (!pools.length) {
    try {
      const raw = fs.readFileSync(POOL_MEMORY_PATH, "utf8");
      pools = Object.keys(JSON.parse(raw)).slice(0, 10); // cap at 10 pools per sweep
    } catch {
      pools = [];
    }
  }

  if (!pools.length) {
    return {
      success: false,
      error: "No pools to sweep — deploy into some pools first or pass pool_addresses explicitly",
      new_wallets: [],
    };
  }

  log("smart_wallets", `Starting wallet sweep across ${pools.length} pools`);
  const allNew = [];
  const details = [];

  for (let i = 0; i < pools.length; i++) {
    const poolAddr = pools[i];
    try {
      const res = await fetch(
        `${LPAGENT_API}/pools/${poolAddr}/top-lpers?sort_order=desc&page=1&limit=100`,
        { headers: { "x-api-key": nextLpKey() } }
      );

      if (res.status === 429) {
        log("smart_wallets", `Sweep rate-limited on pool ${poolAddr.slice(0, 8)} — stopping early`);
        details.push({ pool: poolAddr, error: "rate_limited" });
        break;
      }
      if (!res.ok) {
        log("smart_wallets", `Sweep HTTP ${res.status} for pool ${poolAddr.slice(0, 8)}`);
        details.push({ pool: poolAddr, error: `HTTP ${res.status}` });
      } else {
        const j = await res.json();
        const lpers = j.data || [];
        const added = autoPromoteFromStudy(lpers, poolAddr);
        allNew.push(...added);
        details.push({ pool: poolAddr, lpers_checked: lpers.length, new_wallets: added.length });
        log("smart_wallets", `Sweep pool ${poolAddr.slice(0, 8)}: ${lpers.length} LPers, ${added.length} promoted`);
      }
    } catch (err) {
      log("smart_wallets", `Sweep error pool ${poolAddr.slice(0, 8)}: ${err.message}`);
      details.push({ pool: poolAddr, error: err.message });
    }

    // Sleep between calls — skip after last pool
    if (i < pools.length - 1) await new Promise(r => setTimeout(r, SWEEP_SLEEP_MS));
  }

  const { wallets } = loadWallets();
  return {
    success: true,
    swept_pools: details.length,
    new_wallets: allNew,
    total_tracked: wallets.length,
    details,
  };
}
