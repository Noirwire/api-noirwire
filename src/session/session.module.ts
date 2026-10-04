import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import type { Verifier } from "../auth/core/verifier.js";
import type { Log } from "../common/core/log.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, LOG, SESSIONS, VERIFIER } from "../tokens.js";
import { createSessions } from "./core/sessions.js";
import { SessionController } from "./session.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [SessionController],
  providers: [
    {
      provide: SESSIONS,
      inject: [CONFIG, VERIFIER, LOG],
      useFactory: (config: Config, verify: Verifier, log: Log) =>
        createSessions(
          {
            supabaseUrl: config.auth.supabaseUrl,
            publishableKey: config.auth.publishableKey,
            sessionMaxAgeMs: config.auth.sessionMaxAgeMs,
          },
          { fetch, verify, log },
        ),
    },
  ],
})
export class SessionModule {}
