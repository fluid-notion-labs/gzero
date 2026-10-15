// reflow.ts — markdown reflow and table rendering for pane-width detail
// views. Extracted from the retired WorkflowViewer (P5 cutover) so the
// contexture panel's detail panes get the same prose quality: hard-wrapped
// sources re-flowed, markdown tables aligned as plain text.

/**
 * Re-flow hard-wrapped prose to the pane width. Markdown authors often
 * wrap source lines at ~70 columns; rendered as-is, that leaves ragged
 * short lines and dead space on wide panes. Consecutive plain text lines
 * are joined into one paragraph (markdown treats single newlines inside
 * a paragraph as soft breaks). Everything structural stays put: blank
 * lines, headings, list items and their indented continuations,
 * blockquotes, fenced code blocks, and table rows.
 */
export function reflowMarkdown(md: string): string {
  const startsBlock = (l: string) =>
    l === "" ||
    /^#{1,6}\s/.test(l) ||
    /^\s*[-*+]\s/.test(l) ||
    /^\s*\d+[.)]\s/.test(l) ||
    /^\s*>/.test(l) ||
    /^\s*(```|~~~)/.test(l) ||
    /^\s*\|/.test(l) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
    /^[ \t]/.test(l); // indented = list continuation or code, keep as-is
  const out: string[] = [];
  let para: string[] = [];
  let fence = false;
  const flush = () => {
    if (para.length > 0) {
      out.push(para.join(" "));
      para = [];
    }
  };
  for (const line of md.split("\n")) {
    if (fence) {
      flush();
      out.push(line);
      if (/^\s*(```|~~~)/.test(line)) fence = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = true;
      out.push(line);
      continue;
    }
    if (startsBlock(line)) {
      flush();
      out.push(line);
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/**
 * Render markdown tables as aligned plain-text columns. A table is a
 * run of consecutive lines that start and end with `|`; the `---`
 * separator row is dropped, columns are sized to their widest cell,
 * and a dash rule sits under the header. Non-table lines pass through
 * unchanged, so section bodies keep their shape.
 */
export function renderTables(md: string): string {
  const lines = md.split("\n");
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isRow(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && isRow(lines[i])) i++;
    const rows = lines
      .slice(start, i)
      .map((l) =>
        l
          .trim()
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim()),
      )
      // drop separator rows (|---|---|)
      .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c) || c === ""));
    if (rows.length === 0) continue;
    const cols = Math.max(...rows.map((r) => r.length));
    const widths: number[] = [];
    for (const row of rows) {
      for (let c = 0; c < cols; c++) {
        widths[c] = Math.max(widths[c] ?? 0, (row[c] ?? "").length);
      }
    }
    const line = (cells: string[]) =>
      cells
        .map((cell, c) => (cell ?? "").padEnd(widths[c]))
        .join("  ")
        .trimEnd();
    out.push(line(rows[0]));
    out.push(widths.map((w) => "─".repeat(w)).join("  "));
    for (const row of rows.slice(1)) out.push(line(row));
  }
  return out.join("\n");
}
