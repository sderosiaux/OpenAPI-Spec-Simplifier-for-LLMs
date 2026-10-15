import { parseDocument } from 'yaml';
import { renderCompact } from './compact.ts';
import { MAX_BYTES, byteSize, estimateTokens } from './model.ts';
import type { ObjectValue, Options, Result, Operation, SimplifiedDocument } from './model.ts';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_CHILDREN = new Set([
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
]);
const OMIT = new Set(['externalDocs', 'xml', 'contact', 'license']);
export const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const decodePointer = (key: string) => key.replace(/~1/g, '/').replace(/~0/g, '~');
export function parseSpec(text: string): { spec: ObjectValue; format: 'JSON' | 'YAML' } {
  if (byteSize(text) > MAX_BYTES)
    throw new Error('This spec is too large. Choose a file under 5 MB.');
  if (!text.trim())
    throw new Error('Paste an OpenAPI spec or import a JSON or YAML file to get started.');
  let value: unknown;
  let format: 'JSON' | 'YAML' = 'JSON';
  try {
    value = JSON.parse(text);
  } catch {
    format = 'YAML';
    const parsed = parseDocument(text, { schema: 'core', uniqueKeys: true });
    if (parsed.errors.length) throw new Error(parsed.errors[0].message);
    value = parsed.toJS({ maxAliasCount: 50 });
  }
  // Bound traversal and reject cyclic YAML aliases before any transformation.
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function inspect(item: unknown, depth: number) {
    if (++nodes > 250_000 || depth > 80)
      throw new Error('This spec is too complex to process. Reduce its size or nesting depth.');
    if (item === null || typeof item !== 'object') return;
    if (ancestors.has(item))
      throw new Error(
        'Circular YAML aliases are unsupported. Use OpenAPI $ref references instead.',
      );
    ancestors.add(item);
    Object.values(item).forEach((child) => inspect(child, depth + 1));
    ancestors.delete(item);
  }
  inspect(value, 0);
  const spec = object(value);
  if (
    !(typeof spec.openapi === 'string' && /^3\.[01]\.\d+$/.test(spec.openapi)) &&
    spec.swagger !== '2.0'
  ) {
    throw new Error(
      'Expected an OpenAPI 3.0 / 3.1 or Swagger 2.0 document. Check the top-level openapi or swagger version.',
    );
  }
  if (!spec.paths || Array.isArray(spec.paths) || typeof spec.paths !== 'object') {
    throw new Error('The spec needs a paths object containing its API endpoints.');
  }
  return { spec, format };
}

export function simplify(text: string, options: Options): Result {
  const { spec, format } = parseSpec(text);
  const warnings = new Set<string>();
  const schemaQueue = new Map<string, string>();
  const schemas: ObjectValue = Object.create(null);
  const swagger = spec.swagger === '2.0';
  const schemaRoot = swagger ? '#/definitions/' : '#/components/schemas/';

  function lookup(ref: string): unknown {
    if (!ref.startsWith('#/')) {
      warnings.add(
        `External reference kept unresolved: ${ref}. Bundle external files before importing.`,
      );
      return undefined;
    }
    let current: unknown = spec;
    try {
      for (const segment of decodeURIComponent(ref.slice(2)).split('/').map(decodePointer)) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
          warnings.add(`Reference not found: ${ref}`);
          return undefined;
        }
        current = (current as ObjectValue)[segment];
      }
    } catch {
      warnings.add(`Invalid reference: ${ref}`);
      return undefined;
    }
    return current;
  }
  function resolve(value: unknown, seen = new Set<string>()): ObjectValue {
    const item = object(value);
    if (typeof item.$ref !== 'string') return item;
    if (seen.has(item.$ref)) {
      warnings.add(`Circular object reference: ${item.$ref}`);
      return item;
    }
    const target = lookup(item.$ref);
    if (target === undefined) return item;
    const next = new Set(seen).add(item.$ref);
    const { $ref: _ref, ...siblings } = item;
    return { ...resolve(target, next), ...siblings };
  }
  function schemaReference(ref: string) {
    if (lookup(ref) === undefined) return ref;
    const name = ref.startsWith(schemaRoot)
      ? decodePointer(decodeURIComponent(ref.slice(schemaRoot.length)))
      : ref.slice(2);
    schemaQueue.set(ref, name);
    return `#/schemas/${escapePointer(name)}`;
  }
  function description(value: unknown): string | undefined {
    if (typeof value !== 'string' || options.descriptionLength === 0) return undefined;
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length > options.descriptionLength
      ? clean.slice(0, options.descriptionLength).trimEnd() + '…'
      : clean || undefined;
  }
  function schema(value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    const result: ObjectValue = Object.create(null);
    for (const [key, val] of Object.entries(object(value))) {
      if (OMIT.has(key) || key.startsWith('x-') || key === 'title') continue;
      if (key === 'description') {
        const desc = description(val);
        if (desc) result[key] = desc;
      } else if (key === 'example' || key === 'examples') {
        if (options.includeExamples) result[key] = val;
      } else if (key === '$ref' && typeof val === 'string') result[key] = schemaReference(val);
      else if (key === 'discriminator') {
        const discriminator = object(val);
        result[key] = {
          ...discriminator,
          ...(discriminator.mapping
            ? {
                mapping: Object.fromEntries(
                  Object.entries(object(discriminator.mapping)).map(([tag, target]) => {
                    if (typeof target !== 'string') return [tag, target];
                    const definitions = object(
                      swagger ? spec.definitions : object(spec.components).schemas,
                    );
                    return [
                      tag,
                      schemaReference(
                        Object.hasOwn(definitions, target)
                          ? schemaRoot + escapePointer(target)
                          : target,
                      ),
                    ];
                  }),
                ),
              }
            : {}),
        };
      } else if (SCHEMA_MAPS.has(key))
        result[key] = Object.fromEntries(
          Object.entries(object(val)).map(([name, child]) => [name, schema(child)]),
        );
      else if (SCHEMA_ARRAYS.has(key) || (key === 'items' && Array.isArray(val)))
        result[key] = list(val).map(schema);
      else if (SCHEMA_CHILDREN.has(key)) result[key] = schema(val);
      else result[key] = val;
    }
    if (result.$id || result.$dynamicRef || result.$recursiveRef)
      warnings.add(
        'Advanced JSON Schema identifiers or dynamic references are retained but not resolved.',
      );
    return result;
  }
  function media(value: unknown): ObjectValue {
    return Object.fromEntries(
      Object.entries(object(value)).map(([type, raw]) => {
        const content = object(raw);
        return [
          type,
          {
            ...(content.schema !== undefined ? { schema: schema(content.schema) } : {}),
            ...(content.encoding
              ? {
                  encoding: Object.fromEntries(
                    Object.entries(object(content.encoding)).map(([name, rawEncoding]) => {
                      const encoding = object(rawEncoding);
                      return [
                        name,
                        {
                          ...encoding,
                          ...(encoding.headers
                            ? {
                                headers: Object.fromEntries(
                                  Object.entries(object(encoding.headers)).map(([header, raw]) => [
                                    header,
                                    parameter(raw),
                                  ]),
                                ),
                              }
                            : {}),
                        },
                      ];
                    }),
                  ),
                }
              : {}),
            ...(options.includeExamples && content.example !== undefined
              ? { example: content.example }
              : {}),
            ...(options.includeExamples && content.examples
              ? {
                  examples: Object.fromEntries(
                    Object.entries(object(content.examples)).map(([name, value]) => [
                      name,
                      resolve(value),
                    ]),
                  ),
                }
              : {}),
          },
        ];
      }),
    );
  }
  function parameter(raw: unknown): ObjectValue {
    const item = resolve(raw);
    if (item.$ref) return { $ref: item.$ref };
    const { description: desc, schema: paramSchema, content, ...rest } = item;
    const output: ObjectValue = {};
    for (const [key, value] of Object.entries(rest)) {
      if (
        key.startsWith('x-') ||
        OMIT.has(key) ||
        (!options.includeExamples && ['example', 'examples'].includes(key))
      )
        continue;
      output[key] = value;
    }
    // Swagger puts the schema fields directly on non-body parameters.
    if (paramSchema !== undefined) output.schema = schema(paramSchema);
    if (content) output.content = media(content);
    output.required = item.in === 'path' || item.required === true;
    const clean = description(desc);
    if (clean) output.description = clean;
    return output;
  }
  const document: SimplifiedDocument = {
    title: String(object(spec.info).title || 'Untitled API'),
    version: object(spec.info).version,
    operations: [],
    schemas,
  };
  function servers(value: unknown) {
    return list(value).map((raw) => {
      const { description: desc, ...server } = object(raw);
      const clean = description(desc);
      return { ...server, ...(clean ? { description: clean } : {}) };
    });
  }
  if (spec.servers) document.servers = servers(spec.servers);
  else if (swagger) {
    const host = spec.host ? `//${spec.host}` : '';
    const basePath = spec.basePath || '/';
    document.servers =
      spec.host && list(spec.schemes).length
        ? list(spec.schemes).map((scheme) => ({ url: `${scheme}:${host}${basePath}` }))
        : [{ url: `${host}${basePath}`, ...(spec.schemes ? { schemes: spec.schemes } : {}) }];
  }
  if (spec.security !== undefined) document.security = spec.security;
  const schemes = object(
    swagger ? spec.securityDefinitions : object(spec.components).securitySchemes,
  );
  if (Object.keys(schemes).length)
    document.securitySchemes = Object.fromEntries(
      Object.entries(schemes).map(([name, raw]) => {
        const { description: desc, ...details } = resolve(raw);
        const clean = description(desc);
        return [name, { ...details, ...(clean ? { description: clean } : {}) }];
      }),
    );
  if (Object.keys(object(spec.webhooks)).length)
    warnings.add('Top-level webhooks are omitted. This output describes path operations only.');
  let totalOperations = 0;
  const filter = options.filter.trim().toLowerCase();
  for (const [path, rawPath] of Object.entries(object(spec.paths))) {
    if (!path.startsWith('/')) continue;
    const pathItem = resolve(rawPath);
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) continue;
      const operation = object(rawOperation);
      totalOperations++;
      if (
        filter &&
        !`${method} ${path} ${operation.operationId || ''} ${operation.summary || ''} ${list(operation.tags).join(' ')}`
          .toLowerCase()
          .includes(filter)
      )
        continue;
      const endpoint: Operation = {
        method: method.toUpperCase(),
        path,
        parameters: [],
        responses: {},
      };
      for (const key of [
        'operationId',
        'deprecated',
        'security',
        'servers',
        'consumes',
        'produces',
      ]) {
        const value =
          operation[key] ??
          (key === 'servers'
            ? pathItem[key]
            : ['consumes', 'produces'].includes(key)
              ? spec[key]
              : undefined);
        if (value !== undefined) endpoint[key] = key === 'servers' ? servers(value) : value;
      }
      const desc = description(operation.summary || operation.description);
      if (desc) endpoint.description = desc;
      if (Object.keys(object(operation.callbacks)).length)
        warnings.add(
          'Operation callbacks are omitted. Keep the source spec for callback contracts.',
        );
      const merged = new Map<string, ObjectValue>();
      for (const raw of [...list(pathItem.parameters), ...list(operation.parameters)]) {
        const item = parameter(raw);
        merged.set(`${item.in}:${item.name}:${item.$ref || ''}`, item);
      }
      endpoint.parameters = [...merged.values()];
      if (operation.requestBody) {
        const body = resolve(operation.requestBody);
        endpoint.requestBody = body.$ref
          ? { $ref: body.$ref }
          : {
              required: body.required === true,
              content: media(body.content),
              ...(description(body.description)
                ? { description: description(body.description) }
                : {}),
            };
      }
      endpoint.responses = Object.fromEntries(
        Object.entries(object(operation.responses))
          .map(([status, raw]) => {
            if (status.startsWith('x-')) return [status, undefined];
            const response = resolve(raw);
            if (response.$ref) return [status, { $ref: response.$ref }];
            if (Object.keys(object(response.links)).length)
              warnings.add(
                'Response links are omitted. Keep the source spec for link expressions.',
              );
            return [
              status,
              {
                ...(response.content ? { content: media(response.content) } : {}),
                ...(response.schema !== undefined ? { schema: schema(response.schema) } : {}),
                ...(response.headers
                  ? {
                      headers: Object.fromEntries(
                        Object.entries(object(response.headers)).map(([name, header]) => [
                          name,
                          parameter(header),
                        ]),
                      ),
                    }
                  : {}),
                ...(description(response.description)
                  ? { description: description(response.description) }
                  : {}),
              },
            ];
          })
          .filter(([, value]) => value !== undefined),
      );
      document.operations.push(endpoint);
    }
  }
  if (!options.referencedOnly) {
    const allSchemas = object(swagger ? spec.definitions : object(spec.components).schemas);
    for (const name of Object.keys(allSchemas))
      schemaQueue.set(schemaRoot + escapePointer(name), name);
  }
  // Map iteration includes newly discovered transitive references; cycles stay symbolic.
  for (const [ref, name] of schemaQueue) schemas[name] = schema(lookup(ref));
  const output =
    options.format === 'json'
      ? JSON.stringify(document, null, ['compact', 'max'].includes(options.preset) ? 0 : 2)
      : ['compact', 'max'].includes(options.preset)
        ? renderCompact(document, options)
        : renderText(document, options);
  return {
    document,
    output,
    warnings: [...warnings],
    sourceFormat: format,
    specVersion: String(spec.openapi || spec.swagger),
    totalOperations,
    schemaCount: Object.keys(schemas).length,
    inputBytes: byteSize(text),
    outputBytes: byteSize(output),
    inputTokens: estimateTokens(text),
    outputTokens: estimateTokens(output),
  };
}

function compactSchema(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  const s = object(value);
  const remaining = { ...s };
  const parts: string[] = [];
  if (typeof s.$ref === 'string') {
    parts.push(
      s.$ref.startsWith('#/schemas/')
        ? `@${JSON.stringify(decodePointer(s.$ref.slice(10)))}`
        : `ref(${JSON.stringify(s.$ref)})`,
    );
    delete remaining.$ref;
  }
  const types: Record<string, string> = {
    string: 'str',
    integer: 'int',
    boolean: 'bool',
    number: 'num',
  };
  if (s.properties) {
    parts.push(
      `{${Object.entries(object(s.properties))
        .map(
          ([name, child]) =>
            `${/^[\w-]+$/.test(name) ? name : JSON.stringify(name)}${list(s.required).includes(name) ? '!' : '?'}:${compactSchema(child)}`,
        )
        .join(', ')}}`,
    );
    delete remaining.properties;
    // Keep required names without properties, too (valid in composed schemas).
    const extra = list(s.required).filter(
      (name) => !Object.hasOwn(object(s.properties), String(name)),
    );
    if (extra.length) remaining.required = extra;
    else delete remaining.required;
    if (s.type === 'object') delete remaining.type;
  } else if (s.type === 'array' && s.items !== undefined && !Array.isArray(s.items)) {
    parts.push(`Array<${compactSchema(s.items)}>`);
    delete remaining.type;
    delete remaining.items;
  } else if (s.type) {
    parts.push(
      Array.isArray(s.type)
        ? s.type.map((type) => types[String(type)] || type).join('|')
        : types[String(s.type)] || String(s.type),
    );
    delete remaining.type;
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (s[key]) {
      parts.push(`${key}(${list(s[key]).map(compactSchema).join(', ')})`);
      delete remaining[key];
    }
  }
  if (Object.keys(remaining).length) parts.push(JSON.stringify(remaining));
  return parts.join(' & ') || '{}';
}

export function renderText(doc: SimplifiedDocument, options: Options): string {
  const schemaText = (value: unknown) =>
    options.compactSchemas ? compactSchema(value) : JSON.stringify(value);
  const lines = [
    `# ${doc.title}${doc.version ? ` · ${doc.version}` : ''}`,
    '# API context · ! required · ? optional · @ schema reference',
  ];
  if (doc.servers) lines.push(`servers: ${JSON.stringify(doc.servers)}`);
  if (doc.security !== undefined) lines.push(`security: ${JSON.stringify(doc.security)}`);
  if (doc.securitySchemes) lines.push(`securitySchemes: ${JSON.stringify(doc.securitySchemes)}`);
  lines.push('', `## Operations (${doc.operations.length})`);
  for (const op of doc.operations) {
    lines.push('', `${op.method} ${op.path}${op.operationId ? ` # ${op.operationId}` : ''}`);
    if (op.description) lines.push(`  ${op.description}`);
    for (const p of op.parameters) {
      if (p.$ref) {
        lines.push(`  parameter: ${p.$ref}`);
        continue;
      }
      const { name, in: location, required, schema, description, ...details } = p;
      lines.push(
        `  ${location} ${JSON.stringify(name)}${required ? '!' : '?'}: ${schemaText(schema ?? details)}${schema !== undefined && Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}${description ? ` — ${description}` : ''}`,
      );
    }
    if (op.requestBody) {
      const body = object(op.requestBody);
      lines.push(`  body${body.required ? '!' : '?'}: ${body.$ref || JSON.stringify(body)}`);
    }
    for (const [status, response] of Object.entries(op.responses)) {
      const value = object(response);
      const content = object(value.content);
      if (Object.keys(content).length) {
        for (const [type, raw] of Object.entries(content)) {
          const item = object(raw);
          const { content: _content, ...other } = value;
          const { schema, ...mediaDetails } = item;
          const metadata = { ...other, ...mediaDetails };
          lines.push(
            `  → ${status} ${type}: ${schema !== undefined ? schemaText(schema) : '(unspecified body)'}${Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : ''}`,
          );
        }
      } else if (value.schema !== undefined) {
        const { schema, ...rest } = value;
        lines.push(
          `  → ${status}: ${schemaText(schema)}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`,
        );
      } else
        lines.push(
          `  → ${status}: ${Object.keys(value).length ? JSON.stringify(value) : '(no declared body)'}`,
        );
    }
    for (const key of ['security', 'servers', 'deprecated', 'consumes', 'produces'])
      if (op[key] !== undefined) lines.push(`  ${key}: ${JSON.stringify(op[key])}`);
  }
  if (Object.keys(doc.schemas).length) {
    lines.push('', `## Schemas (${Object.keys(doc.schemas).length})`);
    for (const [name, schema] of Object.entries(doc.schemas))
      lines.push(`${JSON.stringify(name)} = ${schemaText(schema)}`);
  }
  return lines.join('\n');
}
