import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { Log } from "./common/core/log.js";
import { createMemoryQuotaStore } from "./common/core/quota.js";
import { createRelay } from "./common/core/relay.js";
import { Admission } from "./common/http/admission.js";
import { CONFIG, LOG, QUOTAS, RELAY } from "./tokens.js";
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
        Admission,
      ],
      exports: [CONFIG, LOG, QUOTAS, RELAY, Admission],
    };
  }
}
