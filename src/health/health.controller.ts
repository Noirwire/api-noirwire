import { Controller, Get, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../auth/public.decorator.js";
import { answer } from "../common/core/answer.js";
import { ApiErrors, ok } from "../common/http/api-docs.js";
import { send } from "../common/http/send.js";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({
    summary: "Whether the process is up",
    description:
      "For the hosting platform's health check. Needs no session. It says only that this process is running and has accepted its configuration: it calls no provider and reveals nothing about one.",
  })
  @ok(
    "The process is running.",
    {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["ok"], description: "Always `ok`." } },
    },
    { ok: { summary: "Up", value: { status: "ok" } } },
  )
  @ApiErrors()
  health(@Res() res: Response): void {
    send(res, answer(200, { status: "ok" }));
  }
}
