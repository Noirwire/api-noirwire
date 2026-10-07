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

/**
 * What this server knows of the profile program is a copy: the error
 * numbers, the discriminators and each instruction's accounts. These hold
 * the copy to the program's own IDL, as its build writes it in a checkout of
 * the program beside this repository. Without that checkout there is
 * nothing to compare with, and they are skipped.
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

describe.skipIf(!existsSync(IDL_PATH))("the profile program, against its IDL", () => {
  const idl = (): Idl => JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl;
  const instruction = (action: ProfileAction) => {
    const found = idl().instructions.find((entry) => entry.name === INSTRUCTION[action]);
    if (!found) throw new Error(`The IDL has no ${INSTRUCTION[action]}.`);
    return found;
  };

  it("numbers every error as the program does", () => {
    const numbered = Object.fromEntries(
      PROGRAM_ERRORS.map((name, index) => [FIRST_PROGRAM_ERROR + index, name]),
    );
    expect(numbered).toEqual(
      Object.fromEntries(idl().errors.map(({ code, name }) => [code, name])),
    );
  });

  it("reads each of the program's errors out of a failed transaction by its own number", () => {
    for (const { code, name } of idl().errors) {
      expect(programErrorOf({ InstructionError: [0, { Custom: code }] }), name).toBe(name);
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
