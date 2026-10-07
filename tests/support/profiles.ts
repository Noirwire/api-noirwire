import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Profile transactions as a wallet builds them, and every hostile variation
 * of them. Nothing here is taken from `src/profile`: the seeds, the fixed
 * addresses, the discriminators and the account order are written out again
 * from the program's contract, so a mistake in the server's copy shows.
 */

const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");

const DISCRIMINATOR = {
  create: [225, 205, 234, 143, 17, 186, 50, 220],
  write: [42, 24, 36, 43, 230, 170, 36, 247],
  close: [167, 36, 181, 8, 136, 158, 46, 207],
};

export const MAX_DATA_LEN = 64;

export const profileOf = (programId: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], programId)[0];

export type Kind = keyof typeof DISCRIMINATOR;
export type HostileProfile = Record<string, [build: () => Uint8Array, reason: string]>;

/** The transactions of one program deployment, one gate and one owner. */
export function profileScenario() {
  const programId = Keypair.generate().publicKey;
  const gate = Keypair.generate();
  const owner = Keypair.generate();
  const sponsor = PublicKey.findProgramAddressSync([Buffer.from("sponsor")], programId)[0];

  const record = (length: number) => Buffer.alloc(length, 7);

  function data(kind: Kind, bytes: Buffer = record(40), revision = 1n): Buffer {
    const head = Buffer.from(DISCRIMINATOR[kind]);
    if (kind === "close") return head;
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    const expected = Buffer.alloc(8);
    expected.writeBigUInt64LE(revision);
    return Buffer.concat([head, ...(kind === "write" ? [expected] : []), length, bytes]);
  }

  /** The instruction as the program's own client builds it for `of`. */
  function instruction(kind: Kind, of = owner.publicKey, bytes?: Buffer): TransactionInstruction {
    const profile = profileOf(programId, of);
    const permission = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), profile.toBuffer()],
      PERMISSION_PROGRAM,
    )[0];
    const signer = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: false });
    const written = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const read = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    const permissions = [written(permission), read(PERMISSION_PROGRAM)];
    return new TransactionInstruction({
      programId,
      keys: [
        ...(kind === "close" ? [] : [signer(gate.publicKey)]),
        signer(of),
        written(sponsor),
        written(profile),
        ...(kind === "write" ? [] : permissions),
        written(VAULT),
        read(MAGIC_PROGRAM),
      ],
      data: data(kind, bytes),
    });
  }

  const blockhash = () => Keypair.generate().publicKey.toBase58();
  const payerOf = (kind: Kind) => (kind === "close" ? owner.publicKey : gate.publicKey);

  /** Compiled and signed by those of `signers` the message requires. The gate never signs here. */
  function compile(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    signers: Keypair[] = [owner],
  ): VersionedTransaction {
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash(),
        instructions,
      }).compileToLegacyMessage(),
    );
    const required = transaction.message.staticAccountKeys.slice(
      0,
      transaction.message.header.numRequiredSignatures,
    );
    transaction.sign(
      signers.filter((signer) => required.some((key) => key.equals(signer.publicKey))),
    );
    return transaction;
  }

  const bytesOf = (transaction: VersionedTransaction) => transaction.serialize();
  const built = (kind: Kind, change: (instruction: TransactionInstruction) => void = () => {}) => {
    const made = instruction(kind);
    change(made);
    return bytesOf(compile([made], payerOf(kind)));
  };

  const genuine = {
    create: (bytes?: Buffer, as = owner) =>
      bytesOf(compile([instruction("create", as.publicKey, bytes)], gate.publicKey, [as])),
    write: (bytes?: Buffer) =>
      bytesOf(compile([instruction("write", owner.publicKey, bytes)], gate.publicKey)),
    close: () => bytesOf(compile([instruction("close")], owner.publicKey)),
    /** The same creation built with the older `Transaction` class, which orders the account keys differently. */
    createWithLegacyClass: () => {
      const transaction = new Transaction({
        feePayer: gate.publicKey,
        recentBlockhash: blockhash(),
      }).add(instruction("create"));
      transaction.partialSign(owner);
      return new Uint8Array(transaction.serialize({ requireAllSignatures: false }));
    },
  };

  const stranger = Keypair.generate();
  const memo = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [],
    data: Buffer.from("hi"),
  });

  /** Every transaction that is not a profile transaction, with the fixed reason it is refused for. */
  const hostile: HostileProfile = {
    "another program": [
      () => built("create", (made) => (made.programId = Keypair.generate().publicKey)),
      "program",
    ],
    "an instruction the wallets never send": [
      () => built("write", (made) => (made.data[0] ^= 1)),
      "instruction",
    ],
    "a second instruction": [
      () => bytesOf(compile([instruction("write"), memo], gate.publicKey)),
      "instruction_count",
    ],
    "a compute-budget instruction in front": [
      () =>
        bytesOf(
          compile(
            [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), instruction("create")],
            gate.publicKey,
          ),
        ),
      "instruction_count",
    ],
    "another sponsor": [
      () => built("create", (made) => (made.keys[2].pubkey = Keypair.generate().publicKey)),
      "accounts",
    ],
    "another owner's profile": [
      () =>
        built("write", (made) => (made.keys[3].pubkey = profileOf(programId, stranger.publicKey))),
      "accounts",
    ],
    "a permission account that is not the profile's": [
      () => built("create", (made) => (made.keys[4].pubkey = Keypair.generate().publicKey)),
      "accounts",
    ],
    "another permission program": [
      () => built("create", (made) => (made.keys[5].pubkey = Keypair.generate().publicKey)),
      "accounts",
    ],
    "the vault and the magic program swapped": [
      () =>
        built("create", (made) => {
          [made.keys[6].pubkey, made.keys[7].pubkey] = [made.keys[7].pubkey, made.keys[6].pubkey];
        }),
      "accounts",
    ],
    "a fee payer that is not the gate": [
      () => bytesOf(compile([instruction("create")], stranger.publicKey, [owner, stranger])),
      "fee_payer",
    ],
    "another key in the gate's place, with the gate still paying": [
      () => built("write", (made) => (made.keys[0].pubkey = stranger.publicKey)),
      "accounts",
    ],
    "no owner signature": [
      () => bytesOf(compile([instruction("create")], gate.publicKey, [])),
      "owner_signature",
    ],
    "an owner signature that does not verify": [
      () => {
        const transaction = compile([instruction("write")], gate.publicKey);
        transaction.signatures[1][5] ^= 1;
        return bytesOf(transaction);
      },
      "owner_signature",
    ],
    "another key's signature in the owner's place": [
      () => {
        const transaction = compile([instruction("write")], gate.publicKey);
        const other = compile([instruction("write", stranger.publicKey)], gate.publicKey, [
          stranger,
        ]);
        transaction.signatures[1] = other.signatures[1];
        return bytesOf(transaction);
      },
      "owner_signature",
    ],
    "a third signer": [
      () =>
        built("create", (made) =>
          made.keys.push({ pubkey: stranger.publicKey, isSigner: true, isWritable: false }),
        ),
      "accounts",
    ],
    "an account more than the program takes": [
      () =>
        built("write", (made) =>
          made.keys.push({ pubkey: stranger.publicKey, isSigner: false, isWritable: true }),
        ),
      "accounts",
    ],
    "an owner that does not sign": [
      () => built("create", (made) => (made.keys[1].isSigner = false)),
      "accounts",
    ],
    "an owner marked writable": [
      () => built("create", (made) => (made.keys[1].isWritable = true)),
      "accounts",
    ],
    "a sponsor marked read-only": [
      () => built("write", (made) => (made.keys[2].isWritable = false)),
      "accounts",
    ],
    "a versioned transaction": [
      () => {
        const transaction = new VersionedTransaction(
          new TransactionMessage({
            payerKey: gate.publicKey,
            recentBlockhash: blockhash(),
            instructions: [instruction("create")],
          }).compileToV0Message(),
        );
        transaction.sign([owner]);
        return bytesOf(transaction);
      },
      "not_legacy",
    ],
    "a lookup table": [
      () => {
        const transaction = new VersionedTransaction(
          new TransactionMessage({
            payerKey: gate.publicKey,
            recentBlockhash: blockhash(),
            instructions: [instruction("create")],
          }).compileToV0Message([
            new AddressLookupTableAccount({
              key: Keypair.generate().publicKey,
              state: {
                deactivationSlot: 0n,
                lastExtendedSlot: 0,
                lastExtendedSlotStartIndex: 0,
                addresses: [VAULT, sponsor],
              },
            }),
          ]),
        );
        transaction.sign([owner]);
        return bytesOf(transaction);
      },
      "not_legacy",
    ],
    "a record over the limit": [() => genuine.write(record(MAX_DATA_LEN + 1)), "record_too_large"],
    "an empty record": [() => genuine.create(record(0)), "empty_record"],
    "a record longer than it says": [
      () => built("write", (made) => (made.data = Buffer.concat([made.data, record(1)]))),
      "instruction_data",
    ],
    "a record cut short": [
      () => built("create", (made) => (made.data = made.data.subarray(0, made.data.length - 1))),
      "instruction_data",
    ],
    "a closing that carries an argument": [
      () => built("close", (made) => (made.data = Buffer.concat([made.data, record(1)]))),
      "instruction_data",
    ],
    "a closing with the gate as fee payer": [
      () => bytesOf(compile([instruction("close")], gate.publicKey)),
      "fee_payer",
    ],
    "a closing with a stranger as fee payer": [
      () => bytesOf(compile([instruction("close")], stranger.publicKey, [owner, stranger])),
      "fee_payer",
    ],
    "a closing of another owner's profile": [
      () =>
        built("close", (made) => (made.keys[2].pubkey = profileOf(programId, stranger.publicKey))),
      "accounts",
    ],
    "bytes after the transaction": [
      () => Buffer.concat([genuine.create(), Buffer.alloc(1)]),
      "not_canonical",
    ],
    "not a transaction at all": [() => Buffer.from("not a transaction"), "not_a_transaction"],
  };

  const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  return { programId, gate, owner, sponsor, stranger, record, genuine, hostile, encode };
}
