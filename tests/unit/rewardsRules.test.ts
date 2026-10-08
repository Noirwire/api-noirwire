import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { readClaim, referralFee, type ClaimTerms } from "../../src/rewards/core/claim.js";
import {
  MAX_CLOCK_DRIFT_SECONDS,
  rewardsMessage,
  signatureVerifies,
  timely,
} from "../../src/rewards/core/messages.js";
import { boostWeeksLeft, shareBps } from "../../src/rewards/core/points.js";
import {
  claimOpen,
  closedWeeks,
  isWeekStart,
  seasonWeekAt,
  weekAt,
  weekEndsAt,
} from "../../src/rewards/core/weeks.js";
import {
  DAY_MS,
  REFERRAL_ACCOUNT,
  SEASON_START_MS,
  signed,
  trade,
  USDC_MINT,
  WEEK_MS,
} from "../support/rewards.js";

/**
 * The rewards rules that are plain arithmetic in this server: the calendar,
 * the messages, the fee. The score and the split are the database's, and
 * are tested where they run (`tests/integration/rewardsSql.test.ts`).
 */

const START = SEASON_START_MS;
const key = () => Keypair.generate().publicKey.toBase58();

describe("the season's calendar", () => {
  it("takes a week start only at a Monday, 00:00 UTC", () => {
    expect(isWeekStart(Date.UTC(2026, 9, 19))).toBe(true);
    expect(isWeekStart(Date.UTC(2026, 9, 20))).toBe(false);
    expect(isWeekStart(Date.UTC(2026, 9, 19, 1))).toBe(false);
    expect(isWeekStart(Date.UTC(2026, 9, 18, 22))).toBe(false);
    expect(isWeekStart(NaN)).toBe(false);
  });

  it("puts a moment in the week that holds it, a Monday midnight in the week it opens", () => {
    expect(weekAt(START, START)).toBe(0);
    expect(weekAt(START, START + WEEK_MS - 1)).toBe(0);
    expect(weekAt(START, START + WEEK_MS)).toBe(1);
    expect(weekAt(START, START - 1)).toBe(-1);
    expect(weekEndsAt(START, 0)).toBe(START + WEEK_MS);
  });

  it("has twelve weeks, and none before the start or after the last", () => {
    expect(seasonWeekAt(START, START - 1)).toBeNull();
    expect(seasonWeekAt(START, START + 12 * WEEK_MS - 1)).toBe(11);
    expect(seasonWeekAt(START, START + 12 * WEEK_MS)).toBeNull();
  });

  it("keeps a week open for claims until 24 hours after it ends, and not a millisecond longer", () => {
    const closesAt = START + WEEK_MS + DAY_MS;
    expect(claimOpen(START, 0, closesAt - 1)).toBe(true);
    expect(claimOpen(START, 0, closesAt)).toBe(false);
  });

  it("counts a week as ready to settle exactly when its claims close, and never more than twelve", () => {
    expect(closedWeeks(START, START - 30 * DAY_MS)).toBe(0);
    expect(closedWeeks(START, START + WEEK_MS + DAY_MS - 1)).toBe(0);
    expect(closedWeeks(START, START + WEEK_MS + DAY_MS)).toBe(1);
    expect(closedWeeks(START, START + 5 * WEEK_MS)).toBe(4);
    expect(closedWeeks(START, START + 40 * WEEK_MS)).toBe(12);
  });
});

describe("a member's share of the running week", () => {
  it("is estimated in basis points, rounded down, and is zero of nothing", () => {
    expect(shareBps(1n, 3n)).toBe(3_333);
    expect(shareBps(5n, 5n)).toBe(10_000);
    expect(shareBps(0n, 0n)).toBe(0);
  });
});

describe("the weeks of the bonus left", () => {
  it("are never more than eight, for a week counted from before the member joined", () => {
    expect(boostWeeksLeft(true, 5, 0)).toBe(8);
  });

  it("are fewer from the start for a member who joined before week 0", () => {
    expect(boostWeeksLeft(true, -3, 0)).toBe(5);
  });
});

describe("the signed messages", () => {
  const member = Keypair.generate();
  const rewardsKey = member.publicKey.toBase58();
  const text = (message: Uint8Array) => new TextDecoder().decode(message);

  it("are four lines of UTF-8 for a state and a claim, with no line feed after the last", () => {
    expect(text(rewardsMessage("state", rewardsKey, "1790000000"))).toBe(
      `NoirWire rewards v1\nstate\n${rewardsKey}\n1790000000`,
    );
    expect(text(rewardsMessage("claim", rewardsKey, "tx"))).toBe(
      `NoirWire rewards v1\nclaim\n${rewardsKey}\ntx`,
    );
  });

  it("are five lines for a join: the invite code last, and an empty last line when there is none", () => {
    expect(text(rewardsMessage("join", rewardsKey, "1790000000", "K7M2QX9R"))).toBe(
      `NoirWire rewards v1\njoin\n${rewardsKey}\n1790000000\nK7M2QX9R`,
    );
    expect(text(rewardsMessage("join", rewardsKey, "1790000000", ""))).toBe(
      `NoirWire rewards v1\njoin\n${rewardsKey}\n1790000000\n`,
    );
  });

  it("verify under the key that signed, in base58, and under no other", () => {
    const message = rewardsMessage("state", rewardsKey, "1790000000");
    const signature = signed(member, "state", rewardsKey, "1790000000");
    expect(signatureVerifies(rewardsKey, message, signature)).toBe(true);
    expect(signatureVerifies(key(), message, signature)).toBe(false);
  });

  it("do not let a signature for one action or one time stand for another", () => {
    const signature = signed(member, "state", rewardsKey, "1790000000");
    for (const message of [
      rewardsMessage("join", rewardsKey, "1790000000"),
      rewardsMessage("state", rewardsKey, "1790000001"),
      rewardsMessage("state", key(), "1790000000"),
    ]) {
      expect(signatureVerifies(rewardsKey, message, signature)).toBe(false);
    }
  });

  it("refuse a signature that is not 64 bytes of base58, without throwing", () => {
    const message = rewardsMessage("state", rewardsKey, "1");
    for (const signature of ["", "0OIl", base58(new Uint8Array(63).fill(7))]) {
      expect(signatureVerifies(rewardsKey, message, signature)).toBe(false);
    }
  });

  it("take a time within 300 seconds of the clock, either way", () => {
    const now = 1_790_000_000_500;
    const seconds = 1_790_000_000;
    expect(timely(seconds - MAX_CLOCK_DRIFT_SECONDS, now)).toBe(true);
    expect(timely(seconds + MAX_CLOCK_DRIFT_SECONDS, now)).toBe(true);
    expect(timely(seconds - MAX_CLOCK_DRIFT_SECONDS - 1, now)).toBe(false);
    expect(timely(seconds + MAX_CLOCK_DRIFT_SECONDS + 1, now)).toBe(false);
  });
});

describe("the fee of a claimed trade", () => {
  const portfolio = key();
  const inWeekTwo = (START + 2 * WEEK_MS + DAY_MS) / 1_000;
  const terms: ClaimTerms = {
    portfolio,
    referralAccount: REFERRAL_ACCOUNT,
    usdcMint: USDC_MINT,
    seasonStartMs: START,
    doubleHourStartMs: null,
    nowMs: START + 2 * WEEK_MS + 2 * DAY_MS,
  };
  const genuine = () => trade({ portfolio, blockTime: inWeekTwo, feeMicroUsdc: 61_000n });
  const fee = (transaction = genuine()) => referralFee(transaction, REFERRAL_ACCOUNT, USDC_MINT);

  it("is what the referral account's USDC account gained, and is credited to the trade's week", () => {
    expect(readClaim(genuine(), terms)).toEqual({
      ok: true,
      week: 2,
      feeMicroUsdc: 61_000n,
      countedMicroUsdc: 61_000n,
    });
  });

  describe("in the double hour", () => {
    const hourStartMs = START + 2 * WEEK_MS + 5 * DAY_MS + 18 * 3_600_000;
    const during: ClaimTerms = {
      ...terms,
      doubleHourStartMs: hourStartMs,
      nowMs: hourStartMs + DAY_MS,
    };
    /** What a trade made `seconds` after the hour began is credited with. */
    const madeAt = (seconds: number, inForce = during) =>
      readClaim(
        trade({ portfolio, blockTime: hourStartMs / 1_000 + seconds, feeMicroUsdc: 61_000n }),
        inForce,
      );
    const twice = { ok: true, week: 2, feeMicroUsdc: 61_000n, countedMicroUsdc: 122_000n };
    const once = { ...twice, countedMicroUsdc: 61_000n };

    it("counts twice from the second the hour begins", () => {
      expect(madeAt(0)).toEqual(twice);
    });

    it("counts twice in its last second", () => {
      expect(madeAt(59 * 60 + 59)).toEqual(twice);
    });

    it("counts once a second before it begins", () => {
      expect(madeAt(-1)).toEqual(once);
    });

    it("counts once at the very moment it ends", () => {
      expect(madeAt(60 * 60)).toEqual(once);
    });

    it("counts once at that same hour where no double hour is set", () => {
      expect(madeAt(0, { ...during, doubleHourStartMs: null })).toEqual(once);
    });
  });

  it("counts an account the transaction itself opened from zero", () => {
    const transaction = genuine();
    transaction.preTokenBalances = transaction.preTokenBalances.slice(1);
    expect(fee(transaction)).toBe(1_250_000n + 61_000n);
  });

  it("ignores what anyone else's USDC account gained, and what the referral account gained of another token", () => {
    const elsewhere = genuine();
    elsewhere.postTokenBalances[0].owner = key();
    expect(fee(elsewhere)).toBe(0n);

    const otherToken = genuine();
    for (const side of [otherToken.preTokenBalances, otherToken.postTokenBalances]) {
      side[0].mint = key();
    }
    expect(fee(otherToken)).toBe(0n);
  });

  it("is never negative: a transaction that takes from the referral account earns nothing", () => {
    const withdrawal = genuine();
    withdrawal.postTokenBalances[0].amount = 0n;
    expect(readClaim(withdrawal, terms)).toEqual({ ok: false, code: "no_referral_fee" });
  });

  it("refuses a failed transaction, whatever its balances say", () => {
    const failed = trade({ portfolio, blockTime: inWeekTwo, succeeded: false });
    expect(readClaim(failed, terms)).toEqual({ ok: false, code: "transaction_failed" });
  });

  it("refuses a portfolio that did not sign, even one whose tokens moved in it", () => {
    const transaction = genuine();
    transaction.signers = [transaction.signers[0]];
    expect(readClaim(transaction, terms)).toEqual({ ok: false, code: "not_a_signer" });
  });

  it("refuses a trade with no fee to NoirWire", () => {
    const free = trade({ portfolio, blockTime: inWeekTwo, feeMicroUsdc: 0n });
    expect(readClaim(free, terms)).toEqual({ ok: false, code: "no_referral_fee" });
  });

  it("refuses a trade made before the season or after it, and one whose week closed over 24 hours ago", () => {
    const outside = { ok: false, code: "outside_claim_window" };
    const at = (ms: number) => trade({ portfolio, blockTime: ms / 1_000 });
    expect(readClaim(at(START - 1_000), terms)).toEqual(outside);
    expect(readClaim(at(START + 12 * WEEK_MS), { ...terms, nowMs: START + 12 * WEEK_MS })).toEqual(
      outside,
    );

    const lastMoment = START + 3 * WEEK_MS + DAY_MS - 1;
    expect(readClaim(genuine(), { ...terms, nowMs: lastMoment })).toMatchObject({ ok: true });
    expect(readClaim(genuine(), { ...terms, nowMs: lastMoment + 1 })).toEqual(outside);
  });
});
