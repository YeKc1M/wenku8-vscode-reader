import { Content } from './model';

export const COVER = `export function normalizeValues(values: readonly number[]): number[] {
  const unique = new Set(values.filter(Number.isFinite));
  return [...unique].sort((left, right) => left - right);
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}
`;
export function renderCode(content: Content, width = 52): string {
  const lines: string[] = [];
  for (const p of content.paragraphs) {
    // 按 Unicode 码点换行，JSON 字符串转义阻止正文形成可执行代码。
    const chars = Array.from(p);
    for (let i = 0; i < chars.length; i += width) lines.push(`  ${JSON.stringify(chars.slice(i, i + width).join('')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')},`);
    lines.push('');
  }
  if (!lines.length) lines.push('  // No text entries.');
  return ['export const entries: readonly string[] = [', ...lines, '];', ''].join('\n');
}
