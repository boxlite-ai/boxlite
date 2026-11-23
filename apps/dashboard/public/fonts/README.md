# Console fonts

Unmodified upstream variable WOFF2 files, self-hosted to keep typography independent
of third-party font requests. Both use SIL Open Font License 1.1; retain the adjacent
copyright and license files when redistributing.

| Asset                       | Source                                                                                                                                                                          | CSS weights | Bytes   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- |
| `InterVariable-4.001.woff2` | [rsms/inter, 353b61b9](https://github.com/rsms/inter/blob/353b61b9f4430d5f420d56605a6e7993e0941470/docs/font-files/InterVariable.woff2)                                         | 100–900     | 352,240 |
| `CommitMono-1.143.woff2`    | [eigilnikolajsen/commit-mono, d407cd2b](https://github.com/eigilnikolajsen/commit-mono/blob/d407cd2bf8e01ca1db70544052fbbb9606406c3b/src/fonts/fontlab/CommitMonoV143-VF.woff2) | 200–700     | 86,768  |

The binaries identify themselves as Inter 4.001 and Commit Mono 1.143. Both are
registered as normal faces. Commit Mono's source includes an italic axis, but this
console does not register a separate italic face or apply website customization.

SHA-256:

```text
693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3  InterVariable-4.001.woff2
f342ca6c3f2597e6c0fcd84b3f3ed64d3ce5bdb6d0af19d190d645a558b1cf29  CommitMono-1.143.woff2
```

`index.html` preloads the files. `src/index.css` defines `@font-face` with swap
fallbacks and the canonical `--font-sans` / `--font-mono` stacks; Tailwind references
those stacks. Keep filenames versioned when replacing binaries. For usage rules,
see the [console typography contract](../../README.md#interface-typography).
