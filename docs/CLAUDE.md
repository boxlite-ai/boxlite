# Docs guidance

## Placement

Place a new or moved doc by the first matching rule in
[CONTRIBUTING.md#documentation](../CONTRIBUTING.md#documentation), and follow its conventions.

## Map

| Path               | Contents                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `getting-started/` | A first box: quickstarts for Python, Node.js, Rust, and C; the landing page links Go's SDK README |
| `guides/`          | Task steps, such as `volumes.md` and `troubleshooting.md`                                         |
| `concepts/`        | How boxes, images, storage, networking, security, and metrics work                                |
| `reference/`       | SDK APIs (`python/`, `nodejs/`, `rust/`, `c/`), `cli/`, configuration, errors, file formats       |
| `faq.md`           | Short answers that link to the detailed page                                                      |
| `contributing/`    | `architecture/`, `development/`, and dated `investigations/`                                      |
| `legal/CLA.md`     | The CLA; its URL is published, so keep the path                                                   |

Each section's `README.md` is its landing page: start there, and link every new page from it.

## Sources of truth

Check each example, default, and path against its source before writing it:

| Fact                  | Source                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Python API            | PyO3 signatures in `sdks/python/src/`, wrappers in `sdks/python/boxlite/`                                                         |
| Node API              | Types in `sdks/node/lib/native-contracts.ts`, defaults in `sdks/node/src/options.rs`, `SimpleBox` in `sdks/node/lib/simplebox.ts` |
| Rust API and defaults | `src/boxlite/src/lib.rs`, `src/boxlite/src/runtime/options.rs`                                                                    |
| C API                 | `sdks/c/include/boxlite.h`                                                                                                        |
| CLI                   | Command tree, global flags, and their env vars in `src/cli/src/cli.rs`; commands in `src/cli/src/commands/`                       |
| Error types           | `BoxliteError` in `src/shared/src/errors.rs`                                                                                      |
| Home directory layout | `src/boxlite/src/runtime/layout.rs`                                                                                               |

Defaults can differ between an SDK's layers. On a local runtime, a Node `SimpleBox` is removed on
stop by default, but a box created from raw `JsBoxOptions` is kept.

## Verification

- No make target or CI job checks links. Resolve every relative link and anchor you add, move, or
  rename.
- Grep for each path or claim you replace, and fix every hit in the same change.
