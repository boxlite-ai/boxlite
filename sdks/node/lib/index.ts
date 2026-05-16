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
import { BoxliteRestOptions } from "./options.js";
import type { Credential } from "./credential.js";
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

// The native REST binding is positional `(url, credential?, prefix?)`.
// The public surface is the `BoxliteRestOptions` bag — identical in
// name and shape across the C/Go/Node/Python SDKs. A Proxy substitutes
// the bag-taking `rest`; every other static/instance member is the
// native one unchanged.
// `Omit` over the constructor interface preserves the `withDefaultConfig`
// / `initDefault` statics but drops both `rest` (a key) and the `new(...)`
// construct signature (construct signatures are not keys). The
// intersection re-adds the construct signature plus the bag-taking
// `rest`, leaving every other member native.
export type BoxliteConstructor = Omit<JsBoxliteConstructor, "rest"> & {
  new (options: JsOptions): JsBoxliteInstance;
  rest(options: BoxliteRestOptions): JsBoxliteInstance;
};

const nativeBoxlite = getJsBoxlite();
const positionalRest = nativeBoxlite.rest.bind(nativeBoxlite) as (
  url: string,
  credential?: Credential | null,
  prefix?: string | null,
) => JsBoxliteInstance;
const restFromBag = (options: BoxliteRestOptions): JsBoxliteInstance =>
  positionalRest(
    options.url,
    options.credential ?? null,
    options.prefix ?? null,
  );

// napi-rs registers class statics as non-writable AND non-configurable.
// Reassigning `rest` on the native constructor throws at import; a Proxy
// *over the native class* is also rejected, because a `get` trap may not
// substitute a non-configurable, non-writable own data property. So the
// Proxy target is a fresh function that owns no such property: `rest`
// resolves to the bag adapter, construction and every other static
// forward to the native class untouched.
function boxliteConstructor(): void {}
export const JsBoxlite = new Proxy(boxliteConstructor, {
  get(_target, prop, receiver) {
    if (prop === "rest") return restFromBag;
    const value = Reflect.get(nativeBoxlite, prop, receiver);
    return typeof value === "function" ? value.bind(nativeBoxlite) : value;
  },
  construct(_target, args) {
    return Reflect.construct(
      nativeBoxlite as unknown as new (...args: unknown[]) => object,
      args,
    );
  },
}) as unknown as BoxliteConstructor;
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
