import type { ObjectValue, Options, SimplifiedDocument } from './model.ts';

const record = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const pointerName = (ref: string) => ref.slice(10).replace(/~1/g, '/').replace(/~0/g, '~');
const name = (value: string) => (/^[A-Za-z_][\w.-]*$/.test(value) ? value : JSON.stringify(value));
const inline = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(inline).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${name(key)}:${inline(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const signature = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${signature(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

/** A dense text encoding of the normalized contract. Shared definitions remove repetition,
 * while schema aliases in Max mode shorten names without removing their meaning. */
export function renderCompact(doc: SimplifiedDocument, options: Options): string {
  const aliases = new Map(
    Object.keys(doc.schemas).map((key, i) => [
      key,
      options.preset === 'max' ? i.toString(36) : name(key),
    ]),
  );
  const reference = (ref: string) =>
    ref.startsWith('#/schemas/')
      ? `@${aliases.get(pointerName(ref)) ?? name(pointerName(ref))}`
      : `ref(${JSON.stringify(ref)})`;
  const types: Record<string, string> = {
    string: 'str',
    integer: 'int',
    number: 'num',
    boolean: 'bool',
    object: 'obj',
  };
  function schema(value: unknown): string {
    if (!options.compactSchemas) return inline(value);
    if (typeof value === 'boolean') return String(value);
    const s = record(value);
    const rest = { ...s };
    const parts: string[] = [];
    if (typeof s.$ref === 'string') {
      parts.push(reference(s.$ref));
      delete rest.$ref;
    }
    if (s.properties) {
      const required = Array.isArray(s.required) ? s.required : [];
      parts.push(
        `{${Object.entries(record(s.properties))
          .map(
            ([key, child]) => `${name(key)}${required.includes(key) ? '!' : ''}:${schema(child)}`,
          )
          .join(',')}}`,
      );
      delete rest.properties;
      const extra = required.filter((key) => !Object.hasOwn(record(s.properties), String(key)));
      if (extra.length) rest.required = extra;
      else delete rest.required;
      if (s.type === 'object') delete rest.type;
    } else if (s.type === 'array' && s.items !== undefined && !Array.isArray(s.items)) {
      parts.push(`[${schema(s.items)}]`);
      delete rest.type;
      delete rest.items;
    } else if (s.type) {
      const type = Array.isArray(s.type)
        ? `(${s.type.map((t) => types[String(t)] || t).join('|')})`
        : types[String(s.type)] || String(s.type);
      parts.push(type);
      delete rest.type;
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (!Array.isArray(s[key])) continue;
      let children = s[key];
      // {} and true impose no constraints inside allOf.
      if (key === 'allOf')
        children = children.filter(
          (child) =>
            child !== true &&
            !(
              child !== null &&
              typeof child === 'object' &&
              !Array.isArray(child) &&
              Object.keys(child).length === 0
            ),
        );
      if (children.length === 1 && key === 'allOf') parts.push(schema(children[0]));
      else if (children.length)
        parts.push(
          key === 'anyOf'
            ? `(${children.map(schema).join('|')})`
            : `${key}(${children.map(schema).join(',')})`,
        );
      delete rest[key];
    }
    if (s.type === 'object' && rest.additionalProperties === false) {
      parts.push('closed');
      delete rest.additionalProperties;
    }
    if (Object.keys(rest).length) parts.push(inline(rest));
    return parts.join('&') || '{}';
  }
  function content(value: unknown): string {
    return Object.entries(record(value))
      .map(([mime, raw]) => {
        const { schema: body, ...rest } = record(raw);
        const bodyText = body === undefined ? 'unspecified' : schema(body);
        return `${mime === 'application/json' ? '' : `${JSON.stringify(mime)}:`}${bodyText}${Object.keys(rest).length ? inline(rest) : ''}`;
      })
      .join('|');
  }
  function parameter(raw: unknown, header = false): string {
    if (typeof record(raw).$ref === 'string') return `ref(${JSON.stringify(record(raw).$ref)})`;
    const {
      name: key,
      in: location,
      required,
      schema: value,
      content: media,
      description,
      ...rest
    } = record(raw);
    const prefix = header ? '' : `${location}:${name(String(key))}`;
    return `${prefix}${required ? '!' : ''}:${media ? content(media) : schema(value ?? rest)}${(value !== undefined || media) && Object.keys(rest).length ? inline(rest) : ''}${description ? ` desc=${JSON.stringify(description)}` : ''}`;
  }
  function headers(value: unknown): string {
    return `{${Object.entries(record(value))
      .map(([key, item]) => `${name(key)}${parameter(item, true)}`)
      .join(',')}}`;
  }

  // Only lift headers that are identical in EVERY response. Missing headers and overrides
  // must remain distinguishable, so majority-based defaults are intentionally avoided.
  const responses = doc.operations.flatMap((op) => Object.values(op.responses).map(record));
  const commonHeaders = { ...record(responses[0]?.headers) };
  for (const response of responses) {
    for (const key of Object.keys(commonHeaders)) {
      if (
        !Object.hasOwn(record(response.headers), key) ||
        signature(record(response.headers)[key]) !== signature(commonHeaders[key])
      )
        delete commonHeaders[key];
    }
  }
  function response(raw: unknown): string {
    if (typeof record(raw).$ref === 'string') return `ref(${JSON.stringify(record(raw).$ref)})`;
    const { content: media, schema: value, headers: originalHeaders, ...rest } = record(raw);
    const ownHeaders = Object.fromEntries(
      Object.entries(record(originalHeaders)).filter(([key]) => !Object.hasOwn(commonHeaders, key)),
    );
    return `${media ? content(media) : value !== undefined ? schema(value) : 'none'}${Object.keys(ownHeaders).length ? ` h=${headers(ownHeaders)}` : ''}${Object.keys(rest).length ? ` ${inline(rest)}` : ''}`;
  }

  // An alias is used only when its definition plus all references is shorter than repetition.
  function dictionary(values: string[], prefix: string) {
    const counts = new Map<string, number>();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    const definitions = new Map<string, string>();
    for (const [value, count] of counts) {
      const alias = `$${prefix}${definitions.size.toString(36)}`;
      if (count * value.length > value.length + alias.length + 2 + count * alias.length)
        definitions.set(value, alias);
    }
    return {
      use: (value: string) => definitions.get(value) || value,
      lines: [...definitions].map(([value, alias]) => `${alias}=${value}`),
    };
  }
  const sharedParams = dictionary(
    doc.operations.flatMap((op) => op.parameters.map((p) => parameter(p))),
    'p',
  );
  const sharedResponses = dictionary(responses.map(response), 'r');
  function responseGroups(op: SimplifiedDocument['operations'][number]) {
    const grouped = new Map<string, string[]>();
    for (const [status, raw] of Object.entries(op.responses)) {
      const text = sharedResponses.use(response(raw));
      grouped.set(text, [...(grouped.get(text) || []), status]);
    }
    return [...grouped].map(([value, codes]) => `${codes.join('|')}:${value}`);
  }
  const sharedStatuses = dictionary(doc.operations.flatMap(responseGroups), 's');
  const lines = [
    `# ${doc.title}${doc.version ? ` ${doc.version}` : ''}`,
    '# ! required; unmarked optional; @ schema; $ shared; [T] array; A|B anyOf; closed=no extra properties; media=application/json',
  ];
  if (doc.servers) lines.push(`servers=${inline(doc.servers)}`);
  if (doc.securitySchemes) lines.push(`auth=${inline(doc.securitySchemes)}`);
  if (doc.security !== undefined) lines.push(`security=${inline(doc.security)}`);
  if (Object.keys(commonHeaders).length)
    lines.push(`headers(all responses)=${headers(commonHeaders)}`);
  lines.push(
    ...sharedParams.lines,
    ...sharedResponses.lines,
    ...sharedStatuses.lines,
    '',
    `## Operations (${doc.operations.length})`,
  );
  for (const op of doc.operations) {
    const segments = [`${op.method} ${op.path}`];
    if (op.operationId) segments.push(`id=${name(String(op.operationId))}`);
    if (op.parameters.length)
      segments.push(
        `params(${op.parameters.map((p) => sharedParams.use(parameter(p))).join(',')})`,
      );
    if (op.requestBody) {
      const { required, content: media, ...rest } = record(op.requestBody);
      segments.push(
        `body${required ? '!' : ''}=${media ? content(media) : ''}${Object.keys(rest).length ? inline(rest) : ''}`,
      );
    }
    const groups = responseGroups(op);
    if (groups.length) segments.push(`->${groups.map(sharedStatuses.use).join(';')}`);
    for (const key of ['security', 'servers', 'deprecated', 'consumes', 'produces'])
      if (op[key] !== undefined) segments.push(`${key}=${inline(op[key])}`);
    if (op.description) segments.push(`desc=${JSON.stringify(op.description)}`);
    lines.push(segments.join(' '));
  }
  if (aliases.size) {
    lines.push('', `## Schemas (${aliases.size})`);
    for (const [key, value] of Object.entries(doc.schemas))
      lines.push(
        `@${aliases.get(key)}${options.preset === 'max' ? ` ${name(key)}` : ''}=${schema(value)}`,
      );
  }
  return lines.join('\n');
}
