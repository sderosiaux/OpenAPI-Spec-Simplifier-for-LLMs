import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simplify, parseSpec } from '../src/simplifier.ts';
import { PRESETS, MAX_BYTES } from '../src/model.ts';
import type { Options } from '../src/model.ts';

const settings: Options = { ...PRESETS.balanced, format: 'json', filter: '' };
const base = (paths = {}, extra = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Test API', version: '1' },
  paths,
  ...extra,
});
const convert = (spec: unknown, options: Partial<Options> = {}) =>
  simplify(JSON.stringify(spec), { ...settings, ...options });

test('the included commerce example produces smaller output in every preset', () => {
  const input = readFileSync(new URL('../example-large-spec.json', import.meta.url), 'utf8');
  for (const preset of Object.values(PRESETS)) {
    const result = simplify(input, { ...settings, ...preset, format: 'text' });
    assert.ok(result.totalOperations > 0);
    assert.equal(result.totalOperations, result.document.operations.length);
    assert.ok(result.schemaCount > 0);
    assert.ok(result.outputBytes < result.inputBytes);
    assert.equal(result.warnings.length, 0);
  }
});

test('accepts YAML, rejects malformed input and non-OpenAPI data', () => {
  assert.equal(
    parseSpec('openapi: 3.0.3\ninfo: {title: API, version: "1"}\npaths: {}').format,
    'YAML',
  );
  for (const input of ['hello', 'null', '[]', '{}', 'openapi: [', 'openapi: 3.1.0\npaths: []'])
    assert.throws(() => parseSpec(input));
  assert.throws(() => parseSpec('openapi: 3.1.0\npaths: {}\npaths: {}'), /unique|duplicate/i);
});

test('rejects oversized input, cyclic YAML and excessive nesting', () => {
  assert.throws(() => parseSpec(' '.repeat(MAX_BYTES + 1)), /large/);
  assert.throws(() => parseSpec('openapi: 3.1.0\npaths: {}\nx: &loop {self: *loop}'), /Circular/);
  let nested: unknown = {};
  for (let i = 0; i < 85; i++) nested = { nested };
  assert.throws(() => convert(base({}, { nested })), /complex/);
});

test('inherits path parameters and lets operation parameters override by name AND location', () => {
  const result = convert(
    base({
      '/pets/{id}': {
        parameters: [
          { name: 'id', in: 'path', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
        ],
        get: {
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10 } },
            { name: 'limit', in: 'header', required: false, schema: { type: 'string' } },
          ],
          responses: { 204: {} },
        },
      },
    }),
  );
  const params = result.document.operations[0].parameters;
  assert.equal(params.length, 3);
  assert.equal(params[0].required, true);
  assert.equal(params[1].required, false);
  assert.deepEqual(JSON.parse(JSON.stringify(params[1].schema)), { type: 'integer', maximum: 10 });
  assert.equal(params[2].in, 'header');
});

test('resolves parameter, request body, response and path item references', () => {
  const spec = base(
    { '/pets': { $ref: '#/x-paths/pets' } },
    {
      'x-paths': {
        pets: {
          post: {
            parameters: [{ $ref: '#/components/parameters/Q' }],
            requestBody: { $ref: '#/components/requestBodies/Body' },
            responses: { 201: { $ref: '#/components/responses/Created' } },
          },
        },
      },
      components: {
        parameters: { Q: { name: 'query', in: 'query', schema: { type: 'string' } } },
        requestBodies: {
          Body: {
            required: true,
            content: { 'application/xml': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
        responses: {
          Created: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
        schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
      },
    },
  );
  const result = convert(spec);
  assert.equal(result.document.operations[0].parameters[0].name, 'query');
  assert.equal(result.schemaCount, 1);
  assert.ok(result.output.includes('application/xml'));
  assert.equal(result.warnings.length, 0);
});

test('collects transitive and recursive schema references, omitting unused definitions', () => {
  const result = convert(
    base(
      {
        '/tree': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Root' } } },
              },
            },
          },
        },
      },
      {
        components: {
          schemas: {
            Root: { properties: { child: { $ref: '#/components/schemas/Leaf' } } },
            Leaf: { properties: { parent: { $ref: '#/components/schemas/Root' } } },
            Unused: { type: 'string' },
          },
        },
      },
    ),
  );
  assert.deepEqual(Object.keys(result.document.schemas), ['Root', 'Leaf']);
  assert.ok(result.output.includes('#/schemas/Root'));
});

test('JSON pointer escaping works and unusual property names cannot pollute prototypes', () => {
  const spec = JSON.parse(
    '{"openapi":"3.1.0","paths":{"/a":{"get":{"responses":{"200":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/A~1B~0C"}}}}}}}},"components":{"schemas":{"A/B~C":{"type":"object","properties":{"__proto__":{"type":"string"},"description":{"type":"integer"}},"enum":["a,b","x|y"]}}}}',
  );
  const result = convert(spec);
  assert.ok(Object.hasOwn(result.document.schemas, 'A/B~C'));
  assert.ok(result.output.includes('"__proto__"'));
  assert.ok(result.output.includes('"description": {'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('preserves all response codes, inline arrays, headers, defaults and non-JSON content', () => {
  const result = convert(
    base({
      '/files': {
        get: {
          responses: {
            200: {
              content: {
                'application/json': { schema: { type: 'array', items: { type: 'integer' } } },
                'text/csv': { schema: { type: 'string' } },
              },
              headers: { 'X-Count': { schema: { type: 'integer' } } },
            },
            204: {},
            '4XX': { description: 'Client error' },
            default: { description: 'Fallback' },
          },
        },
      },
    }),
  );
  assert.deepEqual(Object.keys(result.document.operations[0].responses), [
    '200',
    '204',
    '4XX',
    'default',
  ]);
  assert.ok(result.output.includes('text/csv'));
  assert.ok(result.output.includes('X-Count'));
  assert.ok(result.output.includes('"items"'));
});

test('keeps auth requirements, scopes, overrides, and scheme details', () => {
  const result = convert(
    base(
      { '/public': { get: { security: [], responses: { 200: {} } } } },
      {
        security: [{ OAuth: ['read'] }],
        components: {
          securitySchemes: {
            OAuth: {
              type: 'oauth2',
              flows: { clientCredentials: { tokenUrl: '/token', scopes: { read: 'Read things' } } },
            },
          },
        },
      },
    ),
  );
  assert.deepEqual(result.document.security, [{ OAuth: ['read'] }]);
  assert.deepEqual(result.document.operations[0].security, []);
  assert.ok(result.output.includes('tokenUrl'));
});

test('supports Swagger 2.0 definitions, body/form parameters, base path and response schemas', () => {
  const result = convert({
    swagger: '2.0',
    info: { title: 'Legacy' },
    host: 'api.example.com',
    basePath: '/v2',
    schemes: ['http', 'https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    paths: {
      '/pets': {
        post: {
          parameters: [
            { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } },
            { name: 'file', in: 'formData', type: 'file' },
          ],
          responses: { 201: { schema: { $ref: '#/definitions/Pet' } } },
        },
      },
    },
    definitions: { Pet: { type: 'object', properties: { id: { type: 'integer' } } } },
  });
  assert.equal(result.schemaCount, 1);
  assert.ok(result.output.includes('http://api.example.com/v2'));
  assert.ok(result.output.includes('formData'));
  assert.ok(result.output.includes('consumes'));
});

test('retains schema semantics including boolean schemas, compositions, constraints, and nullability', () => {
  const result = convert(
    base(
      {},
      {
        components: {
          schemas: {
            Model: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['id'],
              properties: {
                id: { type: 'integer', minimum: 0, default: 0, readOnly: true },
                never: false,
                anything: true,
                choice: {
                  oneOf: [{ type: 'string' }, { type: 'number' }],
                  discriminator: { propertyName: 'kind' },
                },
                composed: {
                  allOf: [{ type: 'string', minLength: 1 }, { pattern: '^x' }],
                  nullable: true,
                },
              },
            },
          },
        },
      },
    ),
    { referencedOnly: false, format: 'text' },
  );
  for (const text of [
    'oneOf(',
    'allOf(',
    'minimum',
    'default',
    'readOnly',
    'never?:false',
    'anything?:true',
    'additionalProperties',
    'nullable',
    'discriminator',
    'object',
    'null',
  ])
    assert.ok(result.output.includes(text), text);
});

test('filtering keeps only relevant operations and their schema dependencies', () => {
  const result = convert(
    base(
      {
        '/cats': {
          get: {
            tags: ['animals'],
            operationId: 'listCats',
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Cat' } } },
              },
            },
          },
        },
        '/dogs': { post: { responses: { 204: {} } } },
      },
      { components: { schemas: { Cat: { type: 'string' } } } },
    ),
    { filter: 'LISTCATS' },
  );
  assert.equal(result.totalOperations, 2);
  assert.equal(result.document.operations.length, 1);
  assert.equal(result.schemaCount, 1);
  assert.equal(
    convert(base({ '/pets': { get: { responses: {} } } }), { filter: 'unmatched' }).document
      .operations.length,
    0,
  );
});

test('reports unresolved external/missing references and omitted webhook/callback/link features', () => {
  const result = convert(
    base(
      {
        '/pets': {
          get: {
            callbacks: {
              onEvent: { '$request.body#/callbackUrl': { post: { responses: { 204: {} } } } },
            },
            responses: {
              200: {
                links: { next: { operationId: 'nextPage' } },
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        { $ref: './external.yaml#/Pet' },
                        { $ref: '#/components/schemas/Missing' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      { webhooks: { changed: { post: { responses: { 204: {} } } } } },
    ),
  );
  for (const expected of [
    'External reference',
    'Reference not found',
    'webhooks',
    'callbacks',
    'links',
  ])
    assert.ok(
      result.warnings.some((w) => w.includes(expected)),
      expected,
    );
  assert.ok(result.output.includes('./external.yaml#/Pet'));
});

test('description and example settings apply without damaging enum or default data', () => {
  const result = convert(
    base(
      {},
      {
        components: {
          schemas: {
            A: {
              type: 'object',
              description: 'Drop me',
              example: { id: 1 },
              default: { description: 'Keep me' },
              enum: [{ description: 'Also keep me' }],
            },
          },
        },
      },
    ),
    { ...PRESETS.compact, referencedOnly: false },
  );
  assert.ok(!result.output.includes('Drop me'));
  assert.ok(!result.output.includes('"example"'));
  assert.ok(result.output.includes('Keep me'));
  assert.ok(result.output.includes('Also keep me'));
  const withExamples = convert(
    base({}, { components: { schemas: { A: { example: 'sample' } } } }),
    { referencedOnly: false, includeExamples: true },
  );
  assert.ok(withExamples.output.includes('sample'));
});

test('JSON output is always parseable; shrinking estimates use actual UTF-8 bytes', () => {
  const result = convert(base({ '/日本語': { trace: { responses: { default: {} } } } }), {
    ...PRESETS.compact,
  });
  assert.equal(JSON.parse(result.output).operations[0].method, 'TRACE');
  assert.equal(result.outputBytes, Buffer.byteLength(result.output));
  assert.ok(Number.isFinite(result.inputTokens));
});

test('discriminator-only dependencies are retained and references are rewritten', () => {
  const result = convert(
    base(
      {
        '/animals': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Animal' } },
                },
              },
            },
          },
        },
      },
      {
        components: {
          schemas: {
            Animal: {
              type: 'object',
              discriminator: {
                propertyName: 'kind',
                mapping: { cat: '#/components/schemas/Cat', dog: 'Dog' },
              },
            },
            Cat: { type: 'object' },
            Dog: { type: 'object' },
          },
        },
      },
    ),
  );
  assert.deepEqual(Object.keys(result.document.schemas), ['Animal', 'Cat', 'Dog']);
  const doc = JSON.parse(result.output);
  assert.equal(doc.schemas.Animal.discriminator.mapping.cat, '#/schemas/Cat');
  assert.equal(doc.schemas.Animal.discriminator.mapping.dog, '#/schemas/Dog');
  assert.equal(result.warnings.length, 0);
});

test('named media examples and multipart encoding headers resolve local references', () => {
  const result = convert(
    base(
      {
        '/upload': {
          post: {
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: { type: 'object' },
                  examples: { sample: { $ref: '#/components/examples/Sample' } },
                  encoding: {
                    file: { headers: { 'X-File': { $ref: '#/components/headers/File' } } },
                  },
                },
              },
            },
            responses: { 204: {} },
          },
        },
      },
      {
        components: {
          examples: { Sample: { value: { file: 'abc' } } },
          headers: { File: { schema: { $ref: '#/components/schemas/FileType' } } },
          schemas: { FileType: { type: 'string' } },
        },
      },
    ),
    { includeExamples: true },
  );
  const doc = JSON.parse(result.output);
  assert.deepEqual(
    doc.operations[0].requestBody.content['multipart/form-data'].examples.sample.value,
    { file: 'abc' },
  );
  assert.equal(result.schemaCount, 1);
});

test('server descriptions honor the preset and Swagger never invents an HTTPS scheme', () => {
  const compact = convert(base({}, { servers: [{ url: '/api', description: 'Remove this' }] }), {
    ...PRESETS.compact,
  });
  assert.ok(!compact.output.includes('Remove this'));
  const legacy = convert({ swagger: '2.0', host: 'example.com', basePath: '/v1', paths: {} });
  assert.deepEqual(legacy.document.servers, [{ url: '//example.com/v1' }]);
  assert.deepEqual(convert({ swagger: '2.0', basePath: '/v2', paths: {} }).document.servers, [
    { url: '/v2' },
  ]);
});
