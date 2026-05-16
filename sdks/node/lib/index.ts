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
// `Omit` over the constructor interface preserves the inherited statics
// but drops both `rest` (a key) and the `new(...)` construct signature
// (construct signatures are not keys). The intersection re-adds the
// construct signature plus the bag-taking `rest`.
export type BoxliteConstructor = Omit<JsBoxliteConstructor, "rest"> & {
  new (options: JsOptions): JsBoxliteInstance;
  rest(options: BoxliteRestOptions): JsBoxliteInstance;
};

const nativeBoxlite = getJsBoxlite();
const NativeBoxliteRestOptions = getNativeBoxliteRestOptions();

class BoxliteWithBagRest extends (nativeBoxlite as unknown as {
  new (options: JsOptions): JsBoxliteInstance;
}) {
  static rest(options: BoxliteRestOptions): JsBoxliteInstance {
    return nativeBoxlite.rest(
      new NativeBoxliteRestOptions(
        options.url,
        options.credential ?? null,
        options.prefix ?? null,
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
