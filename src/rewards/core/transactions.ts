import { z } from "zod";
import { codeOf, parsed, refusal, type Answer, type ErrorCode } from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import type { Relay } from "../../common/core/relay.js";
import type { ChainTransaction } from "./claim.js";
import { REWARDS_ROUTE } from "./database.js";

/**
 * A claimed transaction as this server reads it for itself, from its own
 * RPC provider and at `finalized`: what a claim is worth is never taken
 * from the caller. The request goes through the relay, so the provider sees
 * this server's address, and nothing of it is logged but a route name, a
 * status and a fixed word.
 */

const RPC_TIMEOUT_MS = 8_000;
/** A trade with its logs and parsed instructions is tens of kilobytes. */
const MAX_RESPONSE_BYTES = 512 * 1024;

const RELAY_FAILURES: readonly ErrorCode[] = [
  "rate_limited",
  "upstream_failed",
  "upstream_refused",
  "upstream_not_reached",
  "upstream_timeout",
];

const tokenBalance = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string().nullish(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
});

/** `getTransaction` with `jsonParsed`: the fields a claim is checked against, and null for a transaction not there. */
const transactionReply = z.object({
  result: z
    .object({
      blockTime: z.number().int().positive().nullish(),
      meta: z.object({
        err: z.unknown().optional(),
        preTokenBalances: z.array(tokenBalance).nullish(),
        postTokenBalances: z.array(tokenBalance).nullish(),
      }),
      transaction: z.object({
        signatures: z.array(z.string()).min(1),
        message: z.object({
          accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean() })),
        }),
      }),
    })
    .nullable(),
});

type Balances = z.infer<typeof tokenBalance>[] | null | undefined;

const balancesOf = (entries: Balances) =>
  (entries ?? []).map((entry) => ({
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    owner: entry.owner ?? null,
    amount: BigInt(entry.uiTokenAmount.amount),
  }));

/** The transaction, null when the chain has not finalized one under that id, or the error to answer with. */
export type Looked = { transaction: ChainTransaction | null } | { failed: Answer };

export type Transactions = {
  finalized(signature: string): Promise<Looked>;
};

export function createTransactions(deps: { rpcUrl: string; relay: Relay; log: Log }): Transactions {
  const { rpcUrl, relay, log } = deps;

  const unusable = (reason: string): { failed: Answer } => {
    const failed = refusal("upstream_failed");
    log({ event: "refusal", route: REWARDS_ROUTE, status: failed.status, reason });
    return { failed };
  };

  return {
    async finalized(signature) {
      const replied = await relay(REWARDS_ROUTE, rpcUrl, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            signature,
            { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
          ],
        }),
        maxResponseBytes: MAX_RESPONSE_BYTES,
        timeoutMs: RPC_TIMEOUT_MS,
      });
      if (replied.status !== 200) {
        const failure = RELAY_FAILURES.find((code) => code === codeOf(replied));
        return failure ? { failed: refusal(failure) } : unusable("rpc_error_status");
      }
      const reply = transactionReply.safeParse(parsed(replied));
      if (!reply.success) return unusable("rpc_answer_unusable");
      const found = reply.data.result;
      // A transaction is known by its first signature alone. Read under any
      // other, the same trade could be claimed once for each signer.
      if (!found || !found.blockTime || found.transaction.signatures[0] !== signature) {
        return { transaction: null };
      }
      return {
        transaction: {
          succeeded: found.meta.err == null,
          blockTime: found.blockTime,
          signers: found.transaction.message.accountKeys
            .filter((key) => key.signer)
            .map((key) => key.pubkey),
          preTokenBalances: balancesOf(found.meta.preTokenBalances),
          postTokenBalances: balancesOf(found.meta.postTokenBalances),
        },
      };
    },
  };
}
