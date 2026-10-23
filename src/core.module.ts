import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { Log } from "./common/core/log.js";
import { createMemoryQuotaStore, type QuotaStore } from "./common/core/quota.js";
import { createRelay, type Relay } from "./common/core/relay.js";
import { chooseSpendStore, type SpendStore } from "./common/core/spend.js";
import { Admission } from "./common/http/admission.js";
import { createProviderGate, type ProviderGate } from "./common/core/providerGate.js";
import { heavyRps } from "./rpc/core/rpc.js";
import { CONFIG, JUPITER_GATE, LOG, QUOTAS, RELAY, RPC_GATES, SPEND } from "./tokens.js";

/** The RPC provider's allowance, and inside it the smaller one of the costly calls. */
export type RpcGates = { all: ProviderGate; heavy: ProviderGate };
import type { Config } from "./config/core/config.js";

/**
 * What every module shares: the configuration read at start-up, the log,
 * the one quota store every limit is counted in, and the relay.
 */
@Global()
@Module({})
export class CoreModule {
  static with(config: Config, log: Log): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: LOG, useValue: log },
        { provide: QUOTAS, useFactory: () => createMemoryQuotaStore() },
        { provide: RELAY, useFactory: () => createRelay({ fetch, log }) },
        {
          provide: SPEND,
          inject: [QUOTAS, RELAY],
          useFactory: (quotas: QuotaStore, relay: Relay): SpendStore =>
            chooseSpendStore({
              database: config.rewards && {
                url: config.auth.supabaseUrl,
                secretKey: config.rewards.databaseSecretKey,
              },
              quotas,
              relay,
              log,
            }),
        },
        {
          provide: RPC_GATES,
          useFactory: (): RpcGates => ({
            all: createProviderGate({ ratePerSecond: config.rpcProviderRps }),
            heavy: createProviderGate({ ratePerSecond: heavyRps(config.rpcProviderRps) }),
          }),
        },
        {
          provide: JUPITER_GATE,
          useFactory: () => createProviderGate({ ratePerSecond: config.jupiterProviderRps }),
        },
        Admission,
      ],
      exports: [CONFIG, LOG, QUOTAS, SPEND, RELAY, RPC_GATES, JUPITER_GATE, Admission],
    };
  }
}
