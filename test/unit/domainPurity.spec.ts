import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const folders = ['src/money', 'src/money/dto', 'src/wager', 'src/wallet', 'src/messaging'];
// adapters added in later phases may use the framework, the domain may not
const adapter = /(\.(schema|mapper|repository|usecase|controller|module|provider)|Publisher)\.ts$/;

const domainFiles = folders.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !adapter.test(f))
    .map((f) => join(dir, f)),
);

describe('domain purity (README 6.0, D17)', () => {
  it('finds the domain files', () => {
    expect(domainFiles.length).toBeGreaterThan(10);
  });

  it.each(domainFiles)('%s does not import Nest or MikroORM', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/@nestjs|@mikro-orm/);
  });

  it.each(domainFiles)('%s does not read the clock or generate ids', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/new Date\(\s*\)/);
    expect(text).not.toMatch(/Date\.now\(/);
    expect(text).not.toMatch(/randomUUID/);
  });
});
