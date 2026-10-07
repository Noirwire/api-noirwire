import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module.js";
import type { Log } from "./common/core/log.js";
import { AnswerFilter } from "./common/http/exception.filter.js";
import type { Config } from "./config/core/config.js";
import { CoreModule } from "./core.module.js";
import { EventsController } from "./events/events.controller.js";
import { HealthController } from "./health/health.controller.js";
import { HistoryController } from "./history/history.controller.js";
import { JupiterController } from "./jupiter/jupiter.controller.js";
import { PricesModule } from "./prices/prices.module.js";
import { PrivatePaymentsController } from "./private-payments/private-payments.controller.js";
import { ProfileModule } from "./profile/profile.module.js";
import { RelayerModule } from "./relayer/relayer.module.js";
import { RpcController } from "./rpc/rpc.controller.js";
import { SessionModule } from "./session/session.module.js";

@Module({})
export class AppModule {
  static with(config: Config, log: Log): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.with(config, log),
        AuthModule,
        SessionModule,
        RelayerModule,
        ProfileModule,
        PricesModule,
      ],
      controllers: [
        HealthController,
        RpcController,
        JupiterController,
        PrivatePaymentsController,
        HistoryController,
        EventsController,
      ],
      providers: [{ provide: APP_FILTER, useClass: AnswerFilter }],
    };
  }
}
