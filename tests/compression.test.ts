import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { simplify } from '../src/simplifier.ts';
import { PRESETS, DEFAULT_PRESET } from '../src/model.ts';
import type { Options, SimplifiedDocument } from '../src/model.ts';
import { renderCompact } from '../src/compact.ts';

const options: Options = { ...PRESETS.max, format: 'text', filter: '' };
const doc = (): SimplifiedDocument => ({ title: 'Example', operations: [], schemas: {} });

test('Nevia stays below a 2% output budget with all operations and schemas retained', () => {
  const raw = gunzipSync(
    readFileSync(new URL('./fixtures/nevia.openapi.yaml.gz', import.meta.url)),
  );
  const metadata = JSON.parse(
    readFileSync(new URL('./fixtures/nevia.metadata.json', import.meta.url), 'utf8'),
  );
  assert.equal(createHash('sha256').update(raw).digest('hex'), metadata.sha256);
  assert.equal(DEFAULT_PRESET, 'max');
  const result = simplify(raw.toString('utf8'), options);
  assert.equal(result.document.operations.length, metadata.operations);
  assert.equal(result.schemaCount, metadata.schemas);
  assert.deepEqual(result.warnings, []);
  assert.ok(
    result.outputBytes / raw.length < 0.02,
    `Compression regressed: ${result.outputBytes} / ${raw.length} bytes`,
  );
  assert.equal(
    result.output
      .split('\n')
      .filter((line) => /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|HEAD) /.test(line)).length,
    metadata.operations,
  );
  assert.equal(
    result.output.split('\n').filter((line) => /^@[\da-z]+ /.test(line)).length,
    metadata.schemas,
  );
  const compact = simplify(raw.toString('utf8'), { ...options, ...PRESETS.compact });
  assert.ok(compact.outputBytes / raw.length < 0.025);
  // Dense notation changes presentation, not the normalized API contract.
  assert.deepEqual(result.document, compact.document);
  assert.ok(result.output.includes('Idempotency-Key!'));
  assert.ok(result.output.includes('WWW-Authenticate!'));
  assert.ok(result.output.includes('Retry-After!'));
  assert.ok(result.output.includes('minLength:20,maxLength:4096'));
});

test('global response headers require an exact match across every response', () => {
  const d = doc();
  const header = { required: true, schema: { type: 'string' } };
  d.operations = [
    {
      method: 'GET',
      path: '/one',
      parameters: [],
      responses: {
        200: { headers: { 'X-Request-ID': header } },
        204: {},
      },
    },
  ];
  assert.ok(!renderCompact(d, options).includes('headers(all responses)'));
  d.operations[0].responses['204'] = { headers: { 'X-Request-ID': header } };
  assert.ok(renderCompact(d, options).includes('headers(all responses)={X-Request-ID!:str}'));
  d.operations[0].responses['204'] = {
    headers: { 'X-Request-ID': { required: false, schema: { type: 'string' } } },
  };
  assert.ok(!renderCompact(d, options).includes('headers(all responses)'));
});

test('sharing response definitions preserves exact status codes, media, and header differences', () => {
  const d = doc();
  const response = {
    content: { 'application/json': { schema: { type: 'string', enum: ['error'] } } },
    headers: { 'Retry-After': { schema: { type: 'integer' } } },
  };
  d.operations = Array.from({ length: 6 }, (_, i) => ({
    method: 'GET',
    path: `/${i}`,
    parameters: [],
    responses: { 200: {}, '4XX': response, default: response },
  }));
  const text = renderCompact(d, options);
  assert.ok(text.includes('4XX|default:'));
  assert.ok(text.includes('Retry-After:int'));
  assert.ok(text.includes('200:none'));
  assert.ok(text.includes('$r0='));
  assert.equal(text.match(/Retry-After/g)?.length, 1);
});

test('Max retains schema constraints, composition, nullability, escaped names and literal values', () => {
  const d = doc();
  d.schemas = {
    'A/B~C': {
      type: 'object',
      properties: {
        'a|b': { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        nullable: { anyOf: [{ $ref: '#/schemas/A~1B~0C' }, { type: 'null' }] },
        id: { allOf: [{ type: 'string', pattern: '^x$' }, {}] },
      },
      required: ['a|b', 'undeclared'],
      additionalProperties: false,
      default: { text: 'true,$r0|@1' },
    },
  };
  const text = renderCompact(d, options);
  for (const expected of [
    '@0 "A/B~C"=',
    '"a|b"!:oneOf(str,int)',
    'nullable:(@0|null)',
    'pattern:"^x$"',
    'required:["undeclared"]',
    '&closed',
    '"true,$r0|@1"',
  ])
    assert.ok(text.includes(expected), expected);
});

test('dense output keeps parameter content metadata, authentication overrides and unresolved refs', () => {
  const d = doc();
  d.security = [{ Bearer: [] }];
  d.operations = [
    {
      method: 'POST',
      path: '/upload',
      security: [],
      parameters: [
        {
          name: 'filter',
          in: 'query',
          content: { 'application/json': { schema: false } },
          deprecated: true,
        },
        { $ref: './parameters.yaml#/Token' },
      ],
      requestBody: {
        required: true,
        content: { 'text/plain': { schema: { type: 'string' }, example: 'a,b|c' } },
      },
      responses: { 202: { $ref: './responses.yaml#/Accepted' } },
    },
  ];
  const text = renderCompact(d, { ...options, includeExamples: true });
  for (const expected of [
    'security=[]',
    'deprecated:true',
    'body!="text/plain":str',
    'example:"a,b|c"',
    'ref("./parameters.yaml#/Token")',
    '202:ref("./responses.yaml#/Accepted")',
  ])
    assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('undefined'));
});
