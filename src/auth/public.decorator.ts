import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "noirwire:public";

/** Marks a route that is answered without a session token. Everything else requires one. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
