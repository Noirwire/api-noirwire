import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Config } from "../config/core/config.js";
import { CONFIG, VERIFIER } from "../tokens.js";
import { createVerifier } from "./core/verifier.js";
import { SessionGuard } from "./session.guard.js";

@Module({
  providers: [
    {
      provide: VERIFIER,
      inject: [CONFIG],
      useFactory: (config: Config) =>
        createVerifier({
          issuer: config.auth.issuer,
          jwksUrl: config.auth.jwksUrl,
          jwtSecret: config.auth.jwtSecret,
          sessionMaxAgeMs: config.auth.sessionMaxAgeMs,
        }),
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [VERIFIER],
})
export class AuthModule {}
