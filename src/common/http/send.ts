import type { Response } from "express";
import { ANSWER_HEADERS, type Answer } from "../core/answer.js";

/** The statuses after which the rest of the request is not read, so the connection is not reused. */
const CLOSES_CONNECTION = new Set([408, 413]);

/** Writes an answer: always JSON or empty, always with the fixed headers, never cached. */
export function send(res: Response, answer: Answer): void {
  if (res.headersSent) return;
  res.status(answer.status);
  res.set(ANSWER_HEADERS);
  if (answer.headers) res.set(answer.headers);
  if (CLOSES_CONNECTION.has(answer.status)) res.set("Connection", "close");
  if (answer.body === null) {
    res.removeHeader("Content-Type");
    res.end();
    return;
  }
  res.end(answer.body);
}
