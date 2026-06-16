import { getWalletBalances } from "../../tools/wallet.js";

export async function registerWalletRoutes(app) {
  app.get("/wallet/balances", async () => {
    try {
      const balances = await getWalletBalances();
      return { ...balances, fetched_at: new Date().toISOString() };
    } catch (e) {
      return { error: e.message, fetched_at: new Date().toISOString() };
    }
  });
}
