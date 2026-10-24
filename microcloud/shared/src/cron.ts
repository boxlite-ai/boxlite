const FIELDS = [
  { name: 'minute', min: 0, max: 59, names: [] as string[] },
  { name: 'hour', min: 0, max: 23, names: [] },
  { name: 'day of month', min: 1, max: 31, names: [] },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

/** Validates a 5-field cron expression. Returns a human message or null when the expression is fine. */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `cron "${expr}" must have 5 fields (minute hour day-of-month month day-of-week)`;
  for (let i = 0; i < 5; i++) {
    const field = FIELDS[i]!;
    const problem = validateField(parts[i]!, field);
    if (problem) return `cron "${expr}": ${field.name} field "${parts[i]}" ${problem}`;
  }
  return null;
}

function validateField(text: string, field: (typeof FIELDS)[number]): string | null {
  for (const item of text.split(',')) {
    const [range, step, ...more] = item.split('/');
    if (more.length > 0 || range === undefined) return 'is malformed';
    if (step !== undefined && !/^\d+$/.test(step)) return `has an invalid step "/${step}"`;
    if (step !== undefined && Number(step) === 0) return 'has a zero step';
    if (range === '*') continue;
    const bounds = range.split('-');
    if (bounds.length > 2) return 'is malformed';
    for (const b of bounds) {
      const n = toNumber(b, field);
      if (n === null) return `has an invalid value "${b}"`;
      if (n < field.min || n > field.max) return `value ${n} is outside ${field.min}-${field.max}`;
    }
    if (bounds.length === 2 && toNumber(bounds[0]!, field)! > toNumber(bounds[1]!, field)!) return `has a descending range "${range}"`;
  }
  return null;
}

function toNumber(text: string, field: (typeof FIELDS)[number]): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const idx = field.names.indexOf(text.toLowerCase());
  return idx >= 0 ? field.min + idx : null;
}
