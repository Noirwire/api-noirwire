import swc from "unplugin-swc";

/**
 * NestJS reads constructor types from decorator metadata, which esbuild does
 * not emit. SWC compiles the sources the way `tsc` does for the build.
 */
export const decorators = swc.vite({
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: "es2023",
    keepClassNames: true,
  },
  module: { type: "es6" },
});
