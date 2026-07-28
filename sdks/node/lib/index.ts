/**
 * BoxLite Node.js SDK
 *
 * Embeddable VM runtime for secure, isolated code execution environments.
 *
 * @example
 * ```typescript
 * import { SimpleBox } from '@boxlite-ai/boxlite';
 *
 * const box = new SimpleBox({ image: 'alpine:latest' });
 * try {
 *   const result = await box.exec('echo', 'Hello from BoxLite!');
 *   console.log(result.stdout);
 * } finally {
 *   await box.stop();
 * }
 * ```
 *
 * @packageDocumentation
 */

import {
  getNativeModule,
  getJsBoxlite,
  getNativeBoxliteRestOptions,
} from "./native.js";
import { BoxliteRestOptions } from "./options.js";
import type {
  JsBoxlite as JsBoxliteInstance,
  JsBoxliteConstructor,
  JsOptions,
} from "./native-contracts.js";
export type {
  ImageHandle,
  ImageInfo,
  ImagePullResult,
  VolumeHandle,
  VolumeInfo,
  JsImageRegistry,
  JsImageRegistryAuth,
  JsOptions,
} from "./native-contracts.js";

// The public `rest` takes the cross-SDK `BoxliteRestOptions` bag. The
// positional→bag adaptation now lives in the Rust binding (the native
// `rest` takes its own `BoxliteRestOptions` class — see
// `sdks/node/src/options.rs`, mirroring the Python SDK). This subclass
// only restates `rest` over the bag; `new`, `withDefaultConfig`, and
// `initDefault` inherit unchanged from the native class.
// The constructor type only replaces the native positional `rest` factory;
// instance methods and the other static factories remain native.
export type Boxlite = JsBoxliteInstance;

export type BoxliteConstructor = Omit<
  JsBoxliteConstructor,
  "rest" | "withDefaultConfig"
> & {
  new (options: JsOptions): Boxlite;
  withDefaultConfig(): Boxlite;
  rest(options: BoxliteRestOptions): Boxlite;
};

const nativeBoxlite = getJsBoxlite();
const NativeBoxliteRestOptions = getNativeBoxliteRestOptions();

class BoxliteWithBagRest extends (nativeBoxlite as unknown as {
  new (options: JsOptions): JsBoxliteInstance;
}) {
  static rest(options: BoxliteRestOptions): Boxlite {
    return nativeBoxlite.rest(
      new NativeBoxliteRestOptions(
        options.url,
        options.credential ?? null,
        options.pathPrefix ?? null,
      ),
    );
  }
}

export const JsBoxlite = BoxliteWithBagRest as unknown as BoxliteConstructor;
export { BoxliteRestOptions } from "./options.js";
export type { CopyOptions } from "./copy.js";

// Credential abstraction: structural `Credential` interface + concrete
// `ApiKeyCredential` class.
export {
  ApiKeyCredential,
  type Credential,
  type AccessToken,
} from "./credential.js";

// Export native module loader for advanced use cases
export { getNativeModule, getJsBoxlite };

// Re-export TypeScript wrappers
export {
  SimpleBox,
  BoxTunnel,
  NetworkHandle,
  type NetworkSpec,
  type SimpleBoxOptions,
  type SecurityOptions,
  type Secret,
} from "./simplebox.js";
export { type ExecResult } from "./exec.js";
export { BoxliteError, ExecError, TimeoutError, ParseError } from "./errors.js";
export * from "./constants.js";

// Specialized boxes
export { CodeBox, type CodeBoxOptions } from "./codebox.js";
export {
  BrowserBox,
  type BrowserBoxOptions,
  type BrowserType,
} from "./browserbox.js";
export {
  ComputerBox,
  type ComputerBoxOptions,
  type Screenshot,
} from "./computerbox.js";
export {
  InteractiveBox,
  type InteractiveBoxOptions,
} from "./interactivebox.js";
export { SkillBox, type SkillBoxOptions } from "./skillbox.js";
