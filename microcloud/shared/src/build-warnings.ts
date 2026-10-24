/**
 * Warnings a build printed that do not fail it but deserve a look (npm audit, oversized bundles,
 * deprecated packages): pulled out of the build log so a live deployment does not read as "nothing
 * to look at" (deploy output, app context).
 */
export interface BuildWarning {
  id: 'npm_audit' | 'large_bundle' | 'deprecated_packages';
  title: string;
  fix: string;
  evidence: string[];
}

export function buildWarnings(lines: readonly string[]): BuildWarning[] {
  const out: BuildWarning[] = [];
  // A clean install prints "found 0 vulnerabilities": only a non-zero count is a warning.
  const audit = lines.filter((l) => /\b[1-9]\d*\s+(?:low|moderate|high|critical)\s+severity vulnerabilit/i.test(l) || /found [1-9]\d* vulnerabilit/i.test(l));
  const serious = audit.find((l) => /\b(high|critical)\b/i.test(l));
  if (audit.length) {
    out.push({
      id: 'npm_audit',
      title: `npm reports vulnerable dependencies: ${(serious ?? audit[0]!).replace(/^.*?(\d+\s+\w+\s+severity vulnerabilit\w*|found \d+ vulnerabilit\w*.*)$/i, '$1').trim()}`,
      fix: 'run `npm audit` locally to see which package and whether the app uses the vulnerable part; `npm audit fix` or upgrade it, then `boxlite-app deploy`',
      evidence: audit.slice(0, 3),
    });
  }
  const bundle = lines.filter((l) => /chunks? (?:are|is) larger than \d+\s*kB/i.test(l) || /exceeds the recommended size limit/i.test(l));
  if (bundle.length) {
    out.push({
      id: 'large_bundle',
      title: 'the frontend bundle has chunks over the size limit, so first loads are slow',
      fix: 'split it: load heavy screens with dynamic import(), or set build.rollupOptions.output.manualChunks (Vite); then `boxlite-app deploy`',
      evidence: bundle.slice(0, 2),
    });
  }
  const deprecated = [...new Set(lines.map((l) => /npm warn deprecated ([^\s:]+)/i.exec(l)?.[1]).filter((p): p is string => !!p))];
  if (deprecated.length) {
    out.push({
      id: 'deprecated_packages',
      title: `${deprecated.length} deprecated package${deprecated.length === 1 ? '' : 's'}: ${deprecated.slice(0, 5).join(', ')}${deprecated.length > 5 ? ', …' : ''}`,
      fix: 'upgrade or replace them when convenient (`npm ls <package>` shows what pulls each in)',
      evidence: deprecated.slice(0, 5).map((p) => `npm warn deprecated ${p}`),
    });
  }
  return out;
}
