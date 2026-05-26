Convert Markdown files in `./docs/` to PDF format using md-to-pdf.

Arguments: $ARGUMENTS

## Parameters

- **File pattern** (required): A glob pattern to match files in `./docs/`, e.g. `in-depth-*`, `in-depth-cn-*`, `in-depth-01-*`. The `.md` extension is appended automatically if not included.

Existing PDFs are always overwritten.

## Prerequisites

- **Node.js** must be installed
- **md-to-pdf** npm package: install globally if not available

```bash
npm install -g md-to-pdf
```

## Output File Naming

- **Input**: `{filename}.md`
- **Output**: `{filename}.pdf`

Example: `cn.d-big_data.s-literary.big_data-cn-v6.md.md` -> `cn.d-big_data.s-literary.big_data-cn-v6.md.pdf`

## Conversion Requirements

1. **Preserve Formatting**: The PDF must faithfully render all Markdown formatting including headings, bold, italic, bullet points, nested lists, blockquotes, and inline code.

2. **HTML Support**: Must correctly render embedded HTML tags (`<small>`, `<br>`, `&nbsp;`, etc.) commonly used in the resume files.

3. **Page Layout**:
   - Paper size: A4
   - Margins: 8.5mm all sides (matches MPE preview padding of 2em/32px)
   - Font: system default sans-serif

4. **Styling**: Use different stylesheets for Chinese and English files:
   - **Chinese files** (filename contains `-cn-`): Use `./docs/github-light.css` (original MPE stylesheet)
   - **English files** (filename does NOT contain `-cn-`): Use `./docs/en.github-light.css` (optimized with reduced h2 and h3 spacing)

5. **No External Dependencies Beyond md-to-pdf**: Do not require LaTeX, wkhtmltopdf, or other heavy toolchains.

## Process

1. Check if `md-to-pdf` is installed; if not, install it via `npm install -g md-to-pdf`
2. Parse arguments: extract the file pattern. If no file pattern is provided, report an error.
3. Use `Glob` to find matching `.md` files in `./docs/` using the pattern. If the pattern does not end with `.md`, append `.md` (e.g. `in-depth-*` becomes `in-depth-*.md`).
4. If no files match, report an error and list available `.md` files in `./docs/`.
5. For each matching file, determine the stylesheet based on filename:
   - If filename contains `-cn-`, use `./docs/github-light.css` (Chinese)
   - Otherwise, use `./docs/en.github-light.css` (English)

   Then run (use the stylesheet determined above):
   ```bash
   # Chinese files (containing "-cn-"):
   md-to-pdf --stylesheet "./docs/github-light.css" --pdf-options '{"format":"A4","margin":{"top":"8.5mm","bottom":"8.5mm","left":"8.5mm","right":"8.5mm"}}' <input_file>

   # English files (NOT containing "-cn-"):
   md-to-pdf --stylesheet "./docs/en.github-light.css" --pdf-options '{"format":"A4","margin":{"top":"8.5mm","bottom":"8.5mm","left":"8.5mm","right":"8.5mm"}}' <input_file>
   ```
6. Report results:
   - List converted files
   - Confirm total counts
