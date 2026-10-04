import { Module } from "@nestjs/common";
import { Connection } from "@solana/web3.js";
import type { ChainReader } from "../chain/core/chainReader.js";
import { usdcMint } from "../chain/core/network.js";
import type { Log } from "../common/core/log.js";
import type { QuotaStore } from "../common/core/quota.js";
import type { Relay } from "../common/core/relay.js";
import type { Config } from "../config/core/config.js";
import { SERVER_KEY } from "../common/core/providerGate.js";
import type { RpcGates } from "../core.module.js";
import { CHAIN, CONFIG, LOG, QUOTAS, RELAY, RELAYER, RPC_GATES } from "../tokens.js";
import { createAccountRent } from "./core/accountRent.js";
import { createRelayer } from "./core/relayer.js";
import { createSolPrice } from "./core/solPrice.js";
import { RelayerController } from "./relayer.controller.js";

/** How long the server waits for one of its own chain reads: the SOL price, a mint, the rent. */
const CHAIN_READ_TIMEOUT_MS = 8_000;

@Module({
  controllers: [RelayerController],
  providers: [
    {
      // The chain as this server reads it for itself: the SOL price and the
      // rent of an account, straight from its own RPC provider.
      provide: CHAIN,
      inject: [CONFIG, RPC_GATES],
      useFactory: (config: Config, gates: RpcGates): ChainReader =>
        new Connection(config.rpcUrl, {
          commitment: "confirmed",
          // A read that does not come back is no price: nothing is priced or
          // signed without one, so it must fail and not hang.
          // These reads count against the provider's allowance like any other.
          fetch: (async (input: string, init?: RequestInit) => {
            if (!(await gates.all.acquire(SERVER_KEY))) throw new Error("RPC allowance spent.");
            return fetch(input, {
              ...init,
              signal: AbortSignal.timeout(CHAIN_READ_TIMEOUT_MS),
              redirect: "error",
            });
          }) as unknown as typeof fetch,
          disableRetryOnRateLimit: true,
        }),
    },
    {
      provide: RELAYER,
      inject: [CONFIG, CHAIN, RELAY, QUOTAS, LOG],
      useFactory: (
        config: Config,
        chain: ChainReader,
        relay: Relay,
        quotas: QuotaStore,
        log: Log,
      ) =>
        createRelayer({
          upstream: config.relayer,
          usdcMint: usdcMint(config.network),
          relay,
          solPrice: createSolPrice(chain),
          accountRent: createAccountRent(chain),
          quotas,
          log,
        }),
    },
  ],
})
export class RelayerModule {}
