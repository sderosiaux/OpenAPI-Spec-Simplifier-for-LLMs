export type ObjectValue = Record<string, unknown>;
export type Preset = 'readable' | 'balanced' | 'compact' | 'max';
export type OutputFormat = 'text' | 'json';
export interface Options {
  preset: Preset;
  format: OutputFormat;
  descriptionLength: number;
  compactSchemas: boolean;
  referencedOnly: boolean;
  includeExamples: boolean;
  filter: string;
}
export const PRESETS: Record<Preset, Omit<Options, 'format' | 'filter'>> = {
  readable: {
    preset: 'readable',
    descriptionLength: 300,
    compactSchemas: false,
    referencedOnly: true,
    includeExamples: true,
  },
  balanced: {
    preset: 'balanced',
    descriptionLength: 120,
    compactSchemas: true,
    referencedOnly: true,
    includeExamples: false,
  },
  max: {
    preset: 'max',
    descriptionLength: 0,
    compactSchemas: true,
    referencedOnly: true,
    includeExamples: false,
  },
  compact: {
    preset: 'compact',
    descriptionLength: 0,
    compactSchemas: true,
    referencedOnly: true,
    includeExamples: false,
  },
};
export const DEFAULT_PRESET: Preset = 'max';
export const MAX_BYTES = 5 * 1024 * 1024;
export const byteSize = (text: string) => new TextEncoder().encode(text).length;
export const estimateTokens = (text: string) => (text ? Math.ceil(text.length / 4) : 0);

export interface Operation extends ObjectValue {
  method: string;
  path: string;
  parameters: ObjectValue[];
  responses: ObjectValue;
}
export interface SimplifiedDocument {
  title: string;
  version?: unknown;
  servers?: unknown;
  security?: unknown;
  securitySchemes?: ObjectValue;
  operations: Operation[];
  schemas: ObjectValue;
}
export interface Result {
  document: SimplifiedDocument;
  output: string;
  warnings: string[];
  sourceFormat: 'JSON' | 'YAML';
  specVersion: string;
  totalOperations: number;
  schemaCount: number;
  inputBytes: number;
  outputBytes: number;
  inputTokens: number;
  outputTokens: number;
}
