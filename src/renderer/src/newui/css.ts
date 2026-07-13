// Verbatim CSS-string → React style object parser.
//
// The approved Claude Design is authored with inline `style="..."` strings. To
// port it with ZERO visual translation (the user's hard rule: no approximate
// spacing, exact reproduction), we paste those exact strings into `css(...)`
// instead of hand-converting every declaration to a JS object. The pixel-diff
// harness catches any transcription typo. Keeps components real (wireable in
// Stage C) while guaranteeing fidelity.

export type Style = Record<string, string>

function camel(prop: string): string {
  prop = prop.trim()
  const lead = prop.startsWith('-')
  const parts = prop.replace(/^-/, '').split('-')
  return parts
    .map((p, i) => (i === 0 && !lead ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('')
}

/** Parse one or more `"prop:value;prop:value"` strings into a merged style object. */
export function css(...decls: (string | Style | undefined | false)[]): Style {
  const out: Style = {}
  for (const d of decls) {
    if (!d) continue
    if (typeof d !== 'string') {
      Object.assign(out, d)
      continue
    }
    for (const chunk of d.split(';')) {
      const seg = chunk.trim()
      if (!seg) continue
      const idx = seg.indexOf(':')
      if (idx === -1) continue
      const prop = seg.slice(0, idx)
      const val = seg.slice(idx + 1).trim()
      out[camel(prop)] = val
    }
  }
  return out
}
