import type { Answer } from "../core/answer.js";

/** Thrown where a request is turned away before a controller runs; the filter writes its answer. */
export class ApiRefusal extends Error {
  constructor(readonly answer: Answer) {
    super("refused");
    this.name = "ApiRefusal";
  }
}
