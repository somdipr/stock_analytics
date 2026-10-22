import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/server/db.js';
import { commitStaged, stageFile } from '../src/server/imports.js';

export const fixture = (name: string) => readFileSync(resolve('tests/fixtures', name));
export const freshDb = () => openDb(':memory:');
export async function importFixture(db: ReturnType<typeof freshDb>, name: string) {
  const staged = await stageFile(db, name, fixture(name));
  return { staged, committed: commitStaged(db, staged.id) };
}
