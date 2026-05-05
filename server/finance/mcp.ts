import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  forceRefreshAccounts,
  getOrRefreshAccounts,
  listActiveItems,
  type CachedAccount,
} from "./accounts.js";
import { logFinanceAudit } from "./audit.js";

interface FinanceMcpOptions {
  userTimeZone: string;
}

interface BalanceAggregate {
  checking: number;
  savings: number;
  credit_available: number;
  total: number;
  currency_code: string;
}

interface PerAccountBreakdown {
  alias: string;
  accounts: Array<{
    name: string;
    type: string;
    subtype: string | null;
    balance: number | null;
    currency_code: string | null;
  }>;
}

const BRL = "BRL";

function aggregateByType(accounts: CachedAccount[]): BalanceAggregate {
  let checking = 0;
  let savings = 0;
  let creditAvailable = 0;
  for (const a of accounts) {
    const balance = typeof a.balance === "number" ? a.balance : 0;
    if (a.type === "BANK" && a.subtype === "CHECKING_ACCOUNT") {
      checking += balance;
    } else if (a.type === "BANK" && a.subtype === "SAVINGS_ACCOUNT") {
      savings += balance;
    } else if (a.type === "CREDIT") {
      creditAvailable += balance;
    }
  }
  return {
    checking,
    savings,
    credit_available: creditAvailable,
    total: checking + savings + creditAvailable,
    // All Pluggy BR accounts return BRL today; if a non-BRL account ever
    // appears the aggregate is meaningless, but we keep the field so the
    // agent can reason about it.
    currency_code: BRL,
  };
}

function toBreakdown(alias: string, accounts: CachedAccount[]): PerAccountBreakdown {
  return {
    alias,
    accounts: accounts.map((a) => ({
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      balance: a.balance,
      currency_code: a.currencyCode,
    })),
  };
}

export function createFinanceMcp(opts: FinanceMcpOptions) {
  const { userTimeZone } = opts;

  return createSdkMcpServer({
    name: "boop-finance",
    version: "0.1.0",
    tools: [
      tool(
        "get_balance",
        // Intent-driven description: tell the agent WHAT this answers, not
        // which user phrases trigger it. The dispatcher decides routing
        // based on the user's intent.
        "Returns the user's current account balances from cached Pluggy data. " +
          "Without an item_alias, returns aggregated totals by account type " +
          "({ checking, savings, credit_available, total }) across all " +
          "registered banks. With an item_alias, returns a per-account " +
          "breakdown for that one bank. Cached data is refreshed lazily once " +
          "per calendar day; if the user explicitly asks to refresh, use " +
          "refresh_pluggy_data instead.",
        { item_alias: z.string().optional() },
        async (args) => {
          const started = Date.now();
          try {
            const items = listActiveItems(args.item_alias);
            if (items.length === 0) {
              const message = args.item_alias
                ? `No active item registered for alias "${args.item_alias}".`
                : "No active items registered. Use POST /api/finance/items to add one.";
              logFinanceAudit({
                source: "tool_call",
                action: "get_balance",
                payload: args,
                result: { error: message },
                durationMs: Date.now() - started,
              });
              return { content: [{ type: "text", text: message }] };
            }

            const allAccounts: CachedAccount[] = [];
            const refreshed: string[] = [];
            for (const item of items) {
              const result = await getOrRefreshAccounts(item.itemId, userTimeZone);
              if (result.refreshed) refreshed.push(item.alias);
              allAccounts.push(...result.accounts);
            }

            const body = args.item_alias
              ? toBreakdown(args.item_alias, allAccounts)
              : aggregateByType(allAccounts);

            logFinanceAudit({
              source: "tool_call",
              action: "get_balance",
              payload: args,
              result: { refreshed, accountCount: allAccounts.length },
              durationMs: Date.now() - started,
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ balance: body, refreshed }),
                },
              ],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logFinanceAudit({
              source: "tool_call",
              action: "get_balance",
              payload: args,
              result: { error: message },
              durationMs: Date.now() - started,
            });
            return { content: [{ type: "text", text: `error: ${message}` }] };
          }
        },
      ),
      tool(
        "refresh_pluggy_data",
        "Forces a fresh fetch from Pluggy for the user's registered bank " +
          "items, bypassing the daily cache. Use this when the user " +
          "explicitly asks to update or refresh their financial data. " +
          "Returns the per-item refresh result.",
        { item_alias: z.string().optional() },
        async (args) => {
          const started = Date.now();
          try {
            const items = listActiveItems(args.item_alias);
            if (items.length === 0) {
              const message = args.item_alias
                ? `No active item registered for alias "${args.item_alias}".`
                : "No active items registered. Use POST /api/finance/items to add one.";
              return { content: [{ type: "text", text: message }] };
            }

            const results: Array<{ alias: string; accountCount: number }> = [];
            for (const item of items) {
              const accounts = await forceRefreshAccounts(item.itemId);
              results.push({ alias: item.alias, accountCount: accounts.length });
            }

            logFinanceAudit({
              source: "tool_call",
              action: "refresh_pluggy_data",
              payload: args,
              result: { results },
              durationMs: Date.now() - started,
            });

            return {
              content: [{ type: "text", text: JSON.stringify({ refreshed: results }) }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logFinanceAudit({
              source: "tool_call",
              action: "refresh_pluggy_data",
              payload: args,
              result: { error: message },
              durationMs: Date.now() - started,
            });
            return { content: [{ type: "text", text: `error: ${message}` }] };
          }
        },
      ),
    ],
  });
}
