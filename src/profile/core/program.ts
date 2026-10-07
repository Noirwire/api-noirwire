import { PublicKey } from "@solana/web3.js";

/**
 * The profile program as this server needs to know it: the three
 * instructions a wallet may send, the addresses each one names, and the
 * program's own errors. All of it mirrors the program's IDL, and
 * `tests/unit/profileProgram.test.ts` holds it to that file.
 */

/** MagicBlock's permission program, the rollup's rent vault and its magic program: the same on every deployment. */
export const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const ROLLUP_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");

export type ProfileAction = "create" | "write" | "close";

/** The first eight bytes of each instruction's data. */
export const DISCRIMINATORS: Record<ProfileAction, Uint8Array> = {
  create: Uint8Array.of(225, 205, 234, 143, 17, 186, 50, 220),
  write: Uint8Array.of(42, 24, 36, 43, 230, 170, 36, 247),
  close: Uint8Array.of(167, 36, 181, 8, 136, 158, 46, 207),
};

const encoder = new TextEncoder();
const SPONSOR_SEED = encoder.encode("sponsor");
const PROFILE_SEED = encoder.encode("profile");
const PERMISSION_SEED = encoder.encode("permission:");

/** The one account that pays the rent of every profile. */
export function sponsorAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SPONSOR_SEED], programId)[0];
}

/** The one profile `owner` can have. */
export function profileAddress(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([PROFILE_SEED, owner.toBytes()], programId)[0];
}

/** The account that says who may read `profile`, under the permission program. */
export function permissionAddress(profile: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, profile.toBytes()],
    PERMISSION_PROGRAM,
  )[0];
}

export type AccountSlot = { key: PublicKey; signer: boolean; writable: boolean };

/**
 * The accounts an instruction names, in the program's order, with the flags
 * each must carry in the transaction. The fee payer (the gate for a creation
 * or a write, the owner for a closing) is writable because the network makes
 * every fee payer so; nothing else differs from the program's own list.
 */
export function accountsOf(
  action: ProfileAction,
  owner: PublicKey,
  pins: { programId: PublicKey; gate: PublicKey },
): AccountSlot[] {
  const profile = profileAddress(pins.programId, owner);
  const signer = (key: PublicKey, writable: boolean) => ({ key, signer: true, writable });
  const written = (key: PublicKey) => ({ key, signer: false, writable: true });
  const read = (key: PublicKey) => ({ key, signer: false, writable: false });

  const sponsor = written(sponsorAddress(pins.programId));
  const permission = [written(permissionAddress(profile)), read(PERMISSION_PROGRAM)];
  const rollup = [written(ROLLUP_VAULT), read(MAGIC_PROGRAM)];
  if (action === "close") {
    return [signer(owner, true), sponsor, written(profile), ...permission, ...rollup];
  }
  return [
    signer(pins.gate, true),
    signer(owner, false),
    sponsor,
    written(profile),
    ...(action === "create" ? permission : []),
    ...rollup,
  ];
}

/** Where the owner sits in each instruction's accounts. */
export const OWNER_POSITION: Record<ProfileAction, number> = { create: 1, write: 1, close: 0 };

/** The program's errors in the order it numbers them, the first being `FIRST_PROGRAM_ERROR`. */
export const FIRST_PROGRAM_ERROR = 6000;
export const PROGRAM_ERRORS: readonly string[] = [
  "NotUpgradeAuthority",
  "NotAdmin",
  "GateMissing",
  "Paused",
  "EmptyRecord",
  "RecordTooLarge",
  "InvalidSizeLimit",
  "ProfileExists",
  "ProfileMissing",
  "NotOwner",
  "StaleRevision",
  "UnknownLayout",
  "BelowRent",
  "Overflow",
  "NotNominee",
];

/**
 * The name of the program error in a failed transaction's `err`, as the
 * rollup reports one (`{ InstructionError: [0, { Custom: 6010 }] }`), or
 * null when it failed for any other reason.
 */
export function programErrorOf(err: unknown): string | null {
  const failure = (err as { InstructionError?: unknown } | null)?.InstructionError;
  const code = Array.isArray(failure) ? (failure[1] as { Custom?: unknown } | null)?.Custom : null;
  if (typeof code !== "number") return null;
  return PROGRAM_ERRORS[code - FIRST_PROGRAM_ERROR] ?? null;
}
