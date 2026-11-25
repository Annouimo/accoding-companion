/** Character-level comparison, bounded for very long lines. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export interface DiffPart { text: string; changed: boolean }
function graphemes(s: string): string[] {
  return /^[\x00-\x7f]*$/.test(s) ? s.split("") :
    Array.from(segmenter.segment(s), x => x.segment);
}
function parts(chars: string[], changed: boolean[]): DiffPart[] {
  const result: DiffPart[] = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i === chars.length || changed[i] !== changed[start]) {
      result.push({ text: chars.slice(start, i).join(""), changed: changed[start] });
      start = i;
    }
  }
  return result;
}
export function lineDiff(expected: string, actual: string): [DiffPart[], DiffPart[]] {
  if (expected === actual) return [[{text: expected, changed: false}], [{text: actual, changed: false}]];
  // Equal-length student outputs are positional: a transposition is two changes.
  // For very large lines retain the bounded prefix/suffix fallback.
  if (expected.length + actual.length <= 16000) {
    const a = graphemes(expected), b = graphemes(actual);
    if (a.length === b.length) {
      const changed = a.map((value, i) => value !== b[i]);
      return [parts(a, changed), parts(b, changed)];
    }
  }
  // Avoid splitting multi-megabyte lines into millions of graphemes.
  // Preserve common prefix/suffix at code point boundaries on very long lines.
  if (expected.length + actual.length > 16000) {
    let p = 0, a = expected.length, b = actual.length;
    while (p < a && p < b && expected[p] === actual[p]) p++;
    if (p && /[\uD800-\uDBFF]/.test(expected[p-1])) p--;
    while (a > p && b > p && expected[a-1] === actual[b-1]) { a--; b--; }
    if (a < expected.length && /[\uDC00-\uDFFF]/.test(expected[a])) { a++; b++; }
    const split = (s: string, end: number): DiffPart[] =>
      [{text:s.slice(0,p),changed:false},{text:s.slice(p,end),changed:true},
        {text:s.slice(end),changed:false}].filter(part => part.text.length > 0);
    return [split(expected,a),split(actual,b)];
  }
  // Avoid allocating a dynamic-programming matrix for giant lines.
  const a = graphemes(expected), b = graphemes(actual);
  const x = a.map(() => true), y = b.map(() => true);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    x[prefix] = y[prefix] = false; prefix++;
  }
  let endA = a.length, endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    x[--endA] = y[--endB] = false;
  }
  const m = endA - prefix, n = endB - prefix;
  if (m && n && m * n <= 100000 && m + n <= 4000) {
    const stride = n + 1, matrix = new Uint16Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        matrix[i * stride + j] = a[prefix + i] === b[prefix + j]
          ? 1 + matrix[(i + 1) * stride + j + 1]
          : Math.max(matrix[(i + 1) * stride + j], matrix[i * stride + j + 1]);
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[prefix + i] === b[prefix + j]) {
        x[prefix + i++] = y[prefix + j++] = false;
      } else if (matrix[(i + 1) * stride + j] >= matrix[i * stride + j + 1]) i++;
      else j++;
    }
  }
  return [parts(a, x), parts(b, y)];
}
