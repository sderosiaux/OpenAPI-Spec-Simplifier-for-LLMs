import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { simplify } from '../src/simplifier.ts';
import { PRESETS } from '../src/model.ts';

const path = process.argv[2] || new URL('../tests/fixtures/nevia.openapi.yaml.gz', import.meta.url);
const bytes = readFileSync(path);
const source = (String(path).endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
const results = Object.entries(PRESETS).map(([preset, settings]) => {
  const result = simplify(source, { ...settings, format: 'text', filter: '' });
  return {
    preset,
    inputBytes: result.inputBytes,
    outputBytes: result.outputBytes,
    sizeReduction: `${(100 * (1 - result.outputBytes / result.inputBytes)).toFixed(2)}%`,
    operations: result.document.operations.length,
    schemas: result.schemaCount,
  };
});
console.table(results);
console.log(
  'Size reduction compares UTF-8 bytes. Token counts are not measured by this benchmark.',
);
