import { AsyncLocalStorage } from "node:async_hooks";
import type { DataforseoApiCallCost } from "@/server/lib/dataforseo/envelope";

/**
 * Per-request DataForSEO spend, for callers that meter their own budget.
 *
 * Self-hosted OpenSEO bills DataForSEO directly and meters nothing (Autumn
 * credits are hosted-only), so an integration that caps spend on its side —
 * Autograf Command, over an action service token — needs the provider's own
 * per-task `cost` for each call it caused. meterDataforseoCall records every
 * billed call (including charged failures) into the innermost open scope; the
 * MCP server opens one around each action-token tool call and reports the
 * total on the result's `_meta`. Background work (rank-check and audit
 * workflows) runs outside the request, so it is never in a scope: the caller
 * must account for it from its own estimate.
 */
export type DataforseoSpend = { costUsd: number; calls: number };

const spendStore = new AsyncLocalStorage<DataforseoSpend>();

export async function withDataforseoSpendScope<T>(
  run: () => Promise<T>,
): Promise<{ result: T; spend: DataforseoSpend }> {
  const spend: DataforseoSpend = { costUsd: 0, calls: 0 };
  const result = await spendStore.run(spend, run);
  return { result, spend: roundSpend(spend) };
}

export function recordDataforseoSpend(billing: DataforseoApiCallCost) {
  const spend = spendStore.getStore();
  if (!spend) return;
  spend.calls += 1;
  spend.costUsd += Number.isFinite(billing.costUsd) ? billing.costUsd : 0;
}

function roundSpend(spend: DataforseoSpend): DataforseoSpend {
  return { calls: spend.calls, costUsd: Math.round(spend.costUsd * 1e6) / 1e6 };
}
