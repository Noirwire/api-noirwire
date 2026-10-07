import { Module } from "@nestjs/common";
import { PublicKey } from "@solana/web3.js";
import { signerOf } from "../chain/core/signatures.js";
import type { Log } from "../common/core/log.js";
import type { QuotaStore } from "../common/core/quota.js";
import type { Relay } from "../common/core/relay.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, LOG, PROFILES, QUOTAS, RELAY } from "../tokens.js";
import { createProfiles } from "./core/profiles.js";
import { createRollup } from "./core/rollup.js";
import { ProfileController } from "./profile.controller.js";

@Module({
  controllers: [ProfileController],
  providers: [
    {
      provide: PROFILES,
      inject: [CONFIG, RELAY, QUOTAS, LOG],
      useFactory: ({ profile }: Config, relay: Relay, quotas: QuotaStore, log: Log) =>
        createProfiles({
          upstream: profile && {
            rollup: createRollup({ url: profile.rollupUrl, relay, log }),
            pins: {
              programId: new PublicKey(profile.programId),
              gate: new PublicKey(profile.gate),
              maxDataLen: profile.maxDataLen,
            },
            dailyCreateCap: profile.dailyCreateCap,
            signAsGate: signerOf(profile.gateSecretKey),
          },
          quotas,
          log,
        }),
    },
  ],
})
export class ProfileModule {}
