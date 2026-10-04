import { Module } from "@nestjs/common";
import { createCache } from "../common/core/cached.js";
import type { Config } from "../config/core/config.js";
import { SERVER_KEY, type ProviderGate } from "../common/core/providerGate.js";
import { CONFIG, JUPITER_GATE, LIVE_PRICES } from "../tokens.js";
import { loadLivePrices, PRICES_STALE_MS, PRICES_TTL_MS } from "./core/liveSource.js";
import { PricesController } from "./prices.controller.js";

@Module({
  controllers: [PricesController],
  providers: [
    {
      provide: LIVE_PRICES,
      inject: [CONFIG, JUPITER_GATE],
      useFactory: ({ jupiter }: Config, gate: ProviderGate) =>
        createCache({
          load: () =>
            loadLivePrices(
              {
                url: jupiter.url,
                headers: (): Record<string, string> =>
                  jupiter.apiKey ? { "x-api-key": jupiter.apiKey } : {},
              },
              {
                // The server's own reads of the index count against Jupiter's allowance too.
                fetch: (async (input: string, init?: RequestInit) => {
                  if (!(await gate.acquire(SERVER_KEY)))
                    throw new Error("Jupiter allowance spent.");
                  return fetch(input, init);
                }) as typeof fetch,
              },
            ),
          ttlMs: PRICES_TTL_MS,
          staleMs: PRICES_STALE_MS,
        }),
    },
  ],
})
export class PricesModule {}
