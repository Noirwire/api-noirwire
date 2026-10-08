import { readFileSync } from "node:fs";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { ERRORS } from "../../src/common/core/answer.js";
import { openApiDocument } from "../../src/openapi.js";
import { startApi, type Api } from "./support/harness.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: Api;
let document: any;

beforeAll(async () => {
  api = await startApi();
  document = JSON.parse(JSON.stringify(openApiDocument(api.app)));
});
afterAll(() => api.close());

const operations = () =>
  Object.entries<any>(document.paths).flatMap(([path, methods]) =>
    Object.entries<any>(methods).map(([method, operation]) => ({
      name: `${method.toUpperCase()} ${path}`,
      operation,
    })),
  );

describe("the OpenAPI document", () => {
  it("matches the committed docs/openapi.json (run `npm run openapi` when this fails)", () => {
    const committed = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
    expect(committed).toEqual(document);
  });

  it("documents every route of the contract", () => {
    expect(
      operations()
        .map(({ name }) => name)
        .sort(),
    ).toEqual([
      "GET /health",
      "GET /v1/history/{symbol}/{range}",
      "GET /v1/jupiter/{path}",
      "GET /v1/prices",
      "GET /v1/profile/config",
      "GET /v1/relayer",
      "GET /v1/rewards/config",
      "POST /v1/events",
      "POST /v1/jupiter/{path}",
      "POST /v1/private-payments/{path}",
      "POST /v1/profile/blockhash",
      "POST /v1/profile/challenge",
      "POST /v1/profile/read",
      "POST /v1/profile/session",
      "POST /v1/profile/submit",
      "POST /v1/relayer",
      "POST /v1/rewards/claims",
      "POST /v1/rewards/join",
      "POST /v1/rewards/state",
      "POST /v1/rpc",
      "POST /v1/session",
      "POST /v1/session/refresh",
    ]);
  });

  it("gives every status an example", () => {
    for (const { name, operation } of operations()) {
      expect(operation.summary, name).toBeTruthy();
      for (const [status, response] of Object.entries<any>(operation.responses)) {
        expect(response.description, `${name} ${status}`).toBeTruthy();
        if (status === "204") continue;
        const examples = response.content?.["application/json"]?.examples;
        expect(Object.keys(examples ?? {}).length, `${name} ${status}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every success a real schema: no bare object, every field described", () => {
    const describedAll = (schema: any, where: string) => {
      const variants = schema.oneOf ?? [schema];
      for (const variant of variants) {
        if (variant.type === "array") {
          expect(variant.items, where).toBeDefined();
          continue;
        }
        expect(variant.type, where).toBe("object");
        const properties = Object.entries<any>(variant.properties ?? {});
        expect(properties.length + (variant.additionalProperties ? 1 : 0), where).toBeGreaterThan(
          0,
        );
        for (const [field, property] of properties) {
          if (property.type === "object" && property.properties && !property.description) {
            describedAll(property, `${where}.${field}`);
          } else {
            expect(
              property.description ?? property.enum ?? property.additionalProperties,
              `${where}.${field}`,
            ).toBeTruthy();
          }
        }
      }
    };
    for (const { name, operation } of operations()) {
      const success = operation.responses["200"];
      if (!success) continue;
      describedAll(success.content["application/json"].schema, name);
    }
  });

  it("declares the Age header where it is sent, with its unit", () => {
    const aged = ["GET /v1/prices", "GET /v1/history/{symbol}/{range}"];
    for (const { name, operation } of operations()) {
      const header = operation.responses["200"]?.headers?.Age;
      expect(Boolean(header), name).toBe(aged.includes(name));
      if (header) expect(header.description).toContain("seconds");
    }
  });

  it("enumerates the paths and symbols a route takes, not in prose", () => {
    const enumOf = (name: string, parameter: string) =>
      operations()
        .find((entry) => entry.name === name)
        ?.operation.parameters.find((entry: any) => entry.name === parameter).schema.enum;
    expect(enumOf("GET /v1/jupiter/{path}", "path")).toEqual(["lend/v1/earn/tokens"]);
    expect(enumOf("POST /v1/jupiter/{path}", "path")).toEqual([
      "swap/v2/order",
      "swap/v2/execute",
      "lend/v1/earn/earnings",
      "lend/v1/earn/deposit",
      "lend/v1/earn/withdraw",
      "lend/v1/earn/deposit-instructions",
      "lend/v1/earn/withdraw-instructions",
    ]);
    expect(enumOf("POST /v1/private-payments/{path}", "path")).toEqual([
      "v1/spl/transfer",
      "v1/transaction/send",
      "v1/spl/transfer-queue/ensure-crank",
    ]);
    expect(enumOf("GET /v1/history/{symbol}/{range}", "range")).toEqual(["1D", "1W", "1M"]);
    expect(enumOf("GET /v1/history/{symbol}/{range}", "symbol")).toContain("NVDAx");
    const methods =
      document.paths["/v1/rpc"].post.requestBody.content["application/json"].schema.properties
        .method.enum;
    expect(methods).toContain("getSignaturesForAddress");
    expect(methods).toContain("sendTransaction");
  });

  it("lists every status a route can answer, each with its codes as an enum", () => {
    const everywhere = ["400", "403", "500", "504"];
    const behindSession = ["401", "429", "503"];
    const withBody = ["408", "413"];
    const relayed = [
      "POST /v1/rpc",
      "GET /v1/jupiter/{path}",
      "POST /v1/jupiter/{path}",
      "POST /v1/private-payments/{path}",
    ];
    for (const { name, operation } of operations()) {
      const statuses = Object.keys(operation.responses);
      for (const status of everywhere) expect(statuses, `${name} ${status}`).toContain(status);
      if (operation.security) {
        for (const status of behindSession) expect(statuses, `${name} ${status}`).toContain(status);
      }
      if ((operation.requestBody && name !== "POST /v1/events") || name === "POST /v1/session") {
        for (const status of withBody) expect(statuses, `${name} ${status}`).toContain(status);
      }
      if (relayed.includes(name)) expect(statuses, name).toContain("502");
      for (const [status, response] of Object.entries<any>(operation.responses)) {
        if (Number(status) < 400) continue;
        const { schema, examples } = response.content["application/json"];
        expect(schema.required).toEqual(["code", "error"]);
        expect(schema.properties.code.enum, `${name} ${status}`).toEqual(Object.keys(examples));
      }
    }
    const codesOf = (name: string, status: string) =>
      operations().find((entry) => entry.name === name)?.operation.responses[status].content[
        "application/json"
      ].schema.properties.code.enum;
    expect(codesOf("POST /v1/rpc", "403")).toEqual(["method_not_allowed", "origin_not_allowed"]);
    expect(codesOf("POST /v1/rpc", "502")).toEqual(["upstream_failed", "upstream_refused"]);
    expect(codesOf("POST /v1/relayer", "503")).toEqual(["relayer_unavailable", "unavailable"]);
    expect(codesOf("POST /v1/relayer", "422")).toEqual(["insufficient_payment", "refused"]);
    expect(codesOf("POST /v1/profile/submit", "409")).toEqual([
      "StaleRevision",
      "ProfileExists",
      "ProfileMissing",
      "Paused",
      "RecordTooLarge",
    ]);
    expect(codesOf("POST /v1/profile/submit", "422")).toEqual(["refused"]);
    expect(codesOf("POST /v1/profile/read", "404")).toEqual(["not_found"]);
    // A wallet reads any 422 on a join as "this invite code is not valid".
    expect(codesOf("POST /v1/rewards/join", "422")).toEqual(["invite_code_invalid"]);
    expect(codesOf("POST /v1/rewards/claims", "404")).toEqual(["not_a_member", "not_found"]);
    expect(codesOf("POST /v1/rewards/claims", "409")).toEqual(["already_claimed"]);
    expect(codesOf("POST /v1/rewards/claims", "422")).toEqual([
      "transaction_not_finalized",
      "transaction_failed",
      "not_a_signer",
      "no_referral_fee",
      "outside_claim_window",
    ]);
    expect(codesOf("GET /v1/history/{symbol}/{range}", "404")).toEqual(["not_found"]);
    expect(codesOf("GET /v1/prices", "400")).toEqual(["invalid_request"]);
    expect(codesOf("POST /v1/session/refresh", "401")).toEqual([
      "session_expired",
      "session_invalid",
    ]);
  });

  it("uses only well-formed, plainly made-up addresses, signatures and transactions in its examples", () => {
    const strings: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    for (const { operation } of operations()) {
      for (const response of Object.values<any>(operation.responses)) {
        for (const example of Object.values<any>(
          response.content?.["application/json"]?.examples ?? {},
        )) {
          collect(example.value);
        }
      }
      const body = operation.requestBody?.content["application/json"].examples ?? {};
      for (const example of Object.values<any>(body)) collect(example.value);
    }

    const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const allowedAddresses = [
      PublicKey.default.toBase58(),
      new PublicKey(new Uint8Array(32).fill(1)).toBase58(),
      new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
      // The made-up blockhash, which is written the way an address is.
      new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
    ];
    const signature = base58(new Uint8Array(64).fill(1));
    let addresses = 0;
    let signatures = 0;
    let transactions = 0;
    for (const value of strings) {
      if (BASE58.test(value) && value.length >= 32 && value.length <= 44) {
        // A valid key, and one of the three made-up ones: never a real account.
        expect(new PublicKey(value).toBase58()).toBe(value);
        expect(allowedAddresses, value).toContain(value);
        addresses += 1;
      } else if (BASE58.test(value) && value.length >= 80) {
        expect(value).toBe(signature);
        signatures += 1;
      } else if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(value)) {
        const parsed = VersionedTransaction.deserialize(Buffer.from(value, "base64"));
        expect(parsed.message.compiledInstructions).toHaveLength(0);
        expect(parsed.signatures.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        transactions += 1;
      }
      expect(value).not.toContain("...");
      expect(value).not.toMatch(/^Examp[lL1]e[A-Z]/);
    }
    expect(addresses).toBeGreaterThan(5);
    expect(signatures).toBeGreaterThan(2);
    expect(transactions).toBeGreaterThan(5);
  });

  it("says which routes need a session, and that the others do not", () => {
    const open = ["GET /health", "POST /v1/session", "POST /v1/session/refresh"];
    for (const { name, operation } of operations()) {
      const secured = (operation.security ?? []).some((entry: object) => "session" in entry);
      expect(secured, name).toBe(!open.includes(name));
      if (secured) expect(Object.keys(operation.responses), name).toContain("401");
    }
    expect(document.components.securitySchemes.session).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("lists every error code, in the introduction and nowhere with another status", () => {
    for (const [code, [status]] of Object.entries(ERRORS)) {
      expect(document.info.description).toContain(`| \`${code}\` | \`${status}\` |`);
    }
    for (const { name, operation } of operations()) {
      for (const [status, response] of Object.entries<any>(operation.responses)) {
        if (Number(status) < 400) continue;
        const examples = response.content["application/json"].examples;
        for (const example of Object.values<any>(examples)) {
          const { code, error } = example.value;
          expect(ERRORS[code as keyof typeof ERRORS], `${name} ${status} ${code}`).toEqual([
            Number(status),
            error,
          ]);
        }
      }
    }
  });

  it("states what a session is, what carries addresses, what is logged, and the unit of expiresAt", () => {
    const text = document.info.description as string;
    for (const phrase of [
      "quota bucket",
      "It is not a login",
      "anyone can get another",
      "What contains wallet addresses",
      "Never a token, a session id, an address",
      "A `401` means one thing only",
      "Everything a wallet does on Solana is public",
      "The fee relayer's checks are made on the transaction itself",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    const session = document.paths["/v1/session"].post;
    const schema = session.responses["200"].content["application/json"].schema;
    expect(schema.required).toEqual(["accessToken", "refreshToken", "expiresAt"]);
    expect(schema.properties.expiresAt.description).toContain("SECONDS");
    for (const { name, operation } of operations()) {
      if (name === "GET /health") continue;
      expect(operation.description, name).toMatch(/Contains wallet addresses: (yes|no)/);
    }
  });

  it("uses dummy values only in its examples", () => {
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.eyJ/);
    expect(text).not.toContain("sb_publishable");
    expect(text).not.toContain("sb_secret");
  });
});
