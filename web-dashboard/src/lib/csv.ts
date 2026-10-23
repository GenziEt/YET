/**
 * Phase 5 (D) — client-side CSV export for reports (§Master: "export a weekly
 * trip report"). Pure string building so it is unit-testable and never touches
 * the network; downloadBlob isolates the DOM side effect.
 *
 * Escaping follows RFC 4180: fields containing , " or newline are quoted and
 * inner quotes doubled. A leading =/+/-/@ is neutralized with a prefix space to
 * blunt CSV formula injection (§1.7 privacy posture: report cells contain driver
 * names/plates that ultimately originate from device-supplied data).
 */

export type CsvCell = string | number | boolean | null | undefined;

export function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = ' ' + s; // formula-injection guard
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Trigger a browser download (UTF-8 BOM so Excel opens Amharic text correctly). */
export function downloadBlob(filename: string, csv: string): void {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
