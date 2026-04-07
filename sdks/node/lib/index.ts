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

import { getNativeModule, getJsBoxlite } from "./native.js";
import type {
  JsImageHandle as NativeImageHandle,
  JsImageInfo as NativeImageInfo,
  JsImagePullResult as NativeImagePullResult,
} from "../native/index.js";

// Re-export native bindings
export const JsBoxlite = getJsBoxlite();
export type { CopyOptions } from "./copy.js";
export type ImageHandle = NativeImageHandle;
export type ImageInfo = NativeImageInfo;
export type ImagePullResult = NativeImagePullResult;

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
