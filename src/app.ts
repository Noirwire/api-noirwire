import "reflect-metadata";
import type { Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import type { Log } from "./common/core/log.js";
import {
  cors,
  noQueryString,
  requestLog,
  responseDeadline,
  securityHeaders,
} from "./common/http/middleware.js";
import type { Config } from "./config/core/config.js";
import { openApiDocument } from "./openapi.js";

/** How long a client may take to send its headers, and a whole request. */
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Longer than the platform edge keeps an idle connection (60 s), so this side is never the one to close it under a request. */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * The application, ready to listen. Bodies are not parsed by the framework:
 * each route reads its own, with its own size cap and a deadline.
 */
export async function createApp(config: Config, log: Log): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.with(config, log), {
    bodyParser: false,
    logger: false,
  });
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(securityHeaders(), requestLog(log), responseDeadline(), cors(config), noQueryString());
  SwaggerModule.setup("docs", app, openApiDocument(app), {
    jsonDocumentUrl: "docs-json",
    raw: ["json"],
    customSiteTitle: "NoirWire API",
  });
  app.enableShutdownHooks();

  const server = app.getHttpServer() as Server;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 100;
  return app;
}
