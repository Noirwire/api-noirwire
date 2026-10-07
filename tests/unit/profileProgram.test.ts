import { existsSync, readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ERRORS } from "../../src/common/core/answer.js";
import { PROFILE_CONFLICTS } from "../../src/profile/core/profiles.js";
import {
  accountsOf,
  DISCRIMINATORS,
  FIRST_PROGRAM_ERROR,
  PROGRAM_ERRORS,
  programErrorOf,
  type ProfileAction,
} from "../../src/profile/core/program.js";
import { PROFILE_IDL } from "../support/profileIdl.js";

/**
 * What this server knows of the profile program is a copy: the error
 * numbers, the discriminators and each instruction's accounts. These hold
 * the copy to the program's own IDL, of which `tests/support/profileIdl.ts`
 * keeps the parts that matter here, so they run everywhere. Where a checkout
 * of the program sits beside this repository, that copy is itself held to
 * the IDL the program's build wrote, which is how a stale one is noticed.
 */

const IDL_PATH = "../profile-noirwire/target/idl/noirwire_profile.json";

type IdlAccount = { name: string; signer?: boolean; writable?: boolean; address?: string };
type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[];
  errors: { code: number; name: string }[];
};

const INSTRUCTION: Record<ProfileAction, string> = {
  create: "create_profile",
  write: "write_profile",
  close: "close_profile",
};

describe.skipIf(!existsSync(IDL_PATH))("the copy of the IDL, against the program's build", () => {
  const built = (): Idl => JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl;

  it("has the program's address and its three profile instructions exactly", () => {
    expect(PROFILE_IDL.address).toBe(built().address);
    for (const copied of PROFILE_IDL.instructions) {
      const found = built().instructions.find(({ name }) => name === copied.name);
      expect(found?.discriminator, copied.name).toEqual(copied.discriminator);
      const accounts = found?.accounts.map(({ name, signer, writable, address }) => ({
        name,
        ...(signer ? { signer } : {}),
        ...(writable ? { writable } : {}),
        ...(address ? { address } : {}),
      }));
      expect(accounts, copied.name).toEqual(copied.accounts);
    }
  });

  // The program may have gained errors since the copy was made; none that was copied may have moved.
  it("numbers every error it lists as the program does", () => {
    const numbered = Object.fromEntries(built().errors.map(({ code, name }) => [name, code]));
    for (const { code, name } of PROFILE_IDL.errors) expect(numbered[name], name).toBe(code);
  });
});

describe("the profile program, against its IDL", () => {
  const idl = (): Idl => PROFILE_IDL;
  const instruction = (action: ProfileAction) => {
    const found = idl().instructions.find((entry) => entry.name === INSTRUCTION[action]);
    if (!found) throw new Error(`The IDL has no ${INSTRUCTION[action]}.`);
    return found;
  };

  // The program may gain errors after the ones copied here; what is copied must not move.
  it("numbers every error it knows as the program does", () => {
    const numbered = Object.fromEntries(idl().errors.map(({ code, name }) => [name, code]));
    for (const [index, name] of PROGRAM_ERRORS.entries()) {
      expect(numbered[name], name).toBe(FIRST_PROGRAM_ERROR + index);
    }
  });

  it("reads each error a wallet acts on out of a failed transaction by the program's own number", () => {
    const numbered = Object.fromEntries(idl().errors.map(({ code, name }) => [name, code]));
    for (const name of PROFILE_CONFLICTS) {
      expect(programErrorOf({ InstructionError: [0, { Custom: numbered[name] }] })).toBe(name);
    }
  });

  it("answers as a conflict only errors the program has, each under the program's name", () => {
    const names = idl().errors.map(({ name }) => name);
    for (const conflict of PROFILE_CONFLICTS) {
      expect(names, conflict).toContain(conflict);
      expect(ERRORS[conflict][0]).toBe(409);
    }
  });

  it.each(["create", "write", "close"] as const)(
    "knows the %s instruction: its discriminator, and its accounts in order with their flags",
    (action) => {
      const programId = new PublicKey(idl().address);
      const gate = Keypair.generate().publicKey;
      const owner = Keypair.generate().publicKey;
      const { discriminator, accounts } = instruction(action);
      expect([...DISCRIMINATORS[action]]).toEqual(discriminator);

      const slots = accountsOf(action, owner, { programId, gate });
      expect(slots).toHaveLength(accounts.length);
      const named = Object.fromEntries(accounts.map(({ name }, index) => [name, slots[index]]));
      expect(named.owner.key.equals(owner)).toBe(true);
      if (action !== "close") expect(named.gate.key.equals(gate)).toBe(true);
      for (const [index, account] of accounts.entries()) {
        const slot = slots[index];
        expect(slot.signer, account.name).toBe(account.signer ?? false);
        // The fee payer is the one account the network makes writable whatever the program asks.
        expect(slot.writable, account.name).toBe(index === 0 || (account.writable ?? false));
        if (account.address) expect(slot.key.toBase58(), account.name).toBe(account.address);
      }
    },
  );
});

describe("a failed transaction", () => {
  it("has no program error when it failed for another reason", () => {
    for (const err of [
      null,
      "AlreadyProcessed",
      "BlockhashNotFound",
      { InstructionError: [0, "ProgramFailedToComplete"] },
      { InstructionError: [0, { Custom: 1 }] },
      { InstructionError: [0, { Custom: FIRST_PROGRAM_ERROR + PROGRAM_ERRORS.length }] },
    ]) {
      expect(programErrorOf(err), JSON.stringify(err)).toBeNull();
    }
  });
});
