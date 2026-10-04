import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      "GET /v1/relayer",
      "POST /v1/events",
      "POST /v1/jupiter/{path}",
      "POST /v1/private-payments/{path}",
      "POST /v1/relayer",
      "POST /v1/rpc",
      "POST /v1/session",
      "POST /v1/session/refresh",
    ]);
  });

  it("explains every route in words, and gives every status an example", () => {
    for (const { name, operation } of operations()) {
      expect(operation.summary, name).toBeTruthy();
      expect(operation.description.length, name).toBeGreaterThan(150);
      for (const [status, response] of Object.entries<any>(operation.responses)) {
        expect(response.description, `${name} ${status}`).toBeTruthy();
        if (status === "204") continue;
        const examples = response.content?.["application/json"]?.examples;
        expect(Object.keys(examples ?? {}).length, `${name} ${status}`).toBeGreaterThan(0);
      }
    }
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
