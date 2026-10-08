import { Module } from "@nestjs/common";
import { usdcMint } from "../chain/core/network.js";
import type { Log } from "../common/core/log.js";
import type { Relay } from "../common/core/relay.js";
import type { Config } from "../config/core/config.js";
import type { RpcGates } from "../core.module.js";
import { CONFIG, LOG, RELAY, REWARDS, RPC_GATES } from "../tokens.js";
import { createRewardsDatabase } from "./core/database.js";
import { createRewards } from "./core/rewards.js";
import { createTransactions } from "./core/transactions.js";
import { RewardsController } from "./rewards.controller.js";

@Module({
  controllers: [RewardsController],
  providers: [
    {
      provide: REWARDS,
      inject: [CONFIG, RELAY, RPC_GATES, LOG],
      useFactory: (config: Config, relay: Relay, gates: RpcGates, log: Log) =>
        createRewards({
          upstream: config.rewards && {
            storage: createRewardsDatabase({
              url: config.auth.supabaseUrl,
              secretKey: config.rewards.databaseSecretKey,
              relay,
              log,
            }),
            transactions: createTransactions({ rpcUrl: config.rpcUrl, relay, log }),
            // Reading a transaction is one of the provider's costly calls, and
            // counts against its allowance like a wallet's own.
            rpcAllowance: async (sessionId) =>
              (await gates.heavy.acquire(sessionId)) && (await gates.all.acquire(sessionId)),
            seasonStartMs: config.rewards.seasonStartMs,
            dailyJoinCap: config.rewards.dailyJoinCap,
            doubleHourStartMs: config.rewards.doubleHourStartMs,
            referralAccount: config.rewards.referralAccount,
            usdcMint: usdcMint(config.network),
            fingerprintSecret: config.rewards.fingerprintSecret,
          },
          log,
        }),
    },
  ],
})
export class RewardsModule {}
