import { Module } from "@nestjs/common";
import { createCache } from "../common/core/cached.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, LIVE_PRICES } from "../tokens.js";
import { loadLivePrices, PRICES_STALE_MS, PRICES_TTL_MS } from "./core/liveSource.js";
import { PricesController } from "./prices.controller.js";

@Module({
  controllers: [PricesController],
  providers: [
    {
      provide: LIVE_PRICES,
      inject: [CONFIG],
      useFactory: ({ jupiter }: Config) =>
        createCache({
          load: () =>
            loadLivePrices(
              {
                url: jupiter.url,
                headers: (): Record<string, string> =>
                  jupiter.apiKey ? { "x-api-key": jupiter.apiKey } : {},
              },
              { fetch },
            ),
          ttlMs: PRICES_TTL_MS,
          staleMs: PRICES_STALE_MS,
        }),
    },
  ],
})
export class PricesModule {}
