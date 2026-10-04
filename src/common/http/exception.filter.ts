import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { LOG } from "../../tokens.js";
import { refusal, type ErrorCode } from "../core/answer.js";
import type { Log } from "../core/log.js";
import { ApiRefusal } from "./refusal.js";
import { routeOf } from "./route.js";
import { send } from "./send.js";

const CODES: Record<number, ErrorCode> = {
  400: "invalid_request",
  404: "not_found",
  413: "request_too_large",
};

/**
 * Every error leaves as a fixed JSON message. No stack trace, no exception
 * message and no upstream body reaches a caller, and the log gets the
 * error's class name only: a message can carry whatever was being handled.
 */
@Catch()
export class AnswerFilter implements ExceptionFilter {
  constructor(@Inject(LOG) private readonly log: Log) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    if (exception instanceof ApiRefusal) return send(res, exception.answer);
    if (exception instanceof HttpException) {
      const code = CODES[exception.getStatus()];
      if (code) return send(res, refusal(code));
    }
    const name = exception instanceof Error ? exception.constructor.name : "unknown";
    this.log({ event: "error", route: routeOf(http.getRequest<Request>()), name });
    send(res, refusal("internal_error"));
  }
}
