import React, { useState, useCallback, useEffect } from 'react';
import { Copy, Download, Upload } from 'lucide-react';

// Load js-yaml from CDN
const loadYAMLParser = () => {
  return new Promise((resolve, reject) => {
    if (window.jsyaml) {
      resolve(window.jsyaml);
      return;
    }
    
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js';
    script.onload = () => resolve(window.jsyaml);
    script.onerror = () => reject(new Error('Failed to load YAML parser'));
    document.head.appendChild(script);
  });
};

const OpenAPISimplifier = () => {
  const [inputSpec, setInputSpec] = useState('');
  const [outputSpec, setOutputSpec] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [yamlParser, setYamlParser] = useState(null);

  // Load YAML parser on component mount
  useEffect(() => {
    loadYAMLParser()
      .then(parser => setYamlParser(parser))
      .catch(err => setError(`Failed to load YAML parser: ${err.message}`));
  }, []);

  const parseSpec = async (text) => {
    try {
      // Try JSON first
      return JSON.parse(text);
    } catch (e) {
      // If JSON fails, try YAML
      if (!yamlParser) {
        throw new Error('YAML parser not loaded yet');
      }
      
      try {
        return yamlParser.load(text);
      } catch (yamlError) {
        throw new Error(`Invalid JSON or YAML format: ${yamlError.message}`);
      }
    }
  };

  const cleanSchemaRef = (ref) => {
    if (!ref || typeof ref !== 'string') return ref;
    return ref.replace('#/components/schemas/', '');
  };

  const collectReferencedSchemas = (spec) => {
    const refs = new Set();
    
    const addRef = (ref) => {
      if (ref && typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
        refs.add(ref.replace('#/components/schemas/', ''));
      }
    };

    const walkObject = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      
      if (obj.$ref) {
        addRef(obj.$ref);
      }
      
      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
          value.forEach(walkObject);
        } else if (typeof value === 'object') {
          walkObject(value);
        }
      }
    };

    // Walk all paths and operations
    if (spec.paths) {
      walkObject(spec.paths);
    }

    // Add commonly needed schemas
    const seedSchemas = ['Error', 'Granularity', 'AggregationFunction', 'ResponseFormat'];
    seedSchemas.forEach(schema => {
      if (spec.components?.schemas?.[schema]) {
        refs.add(schema);
      }
    });

    return Array.from(refs);
  };

  const simplifySchema = (schema) => {
    if (!schema || typeof schema !== 'object') return schema;
    
    // If it's a simple type with just a type field, use compact format
    if (schema.type && Object.keys(schema).length === 1) {
      return schema.type;
    }
    
    // If it has type and format only, combine them
    if (schema.type && schema.format && Object.keys(schema).length === 2) {
      return `${schema.type}(${schema.format})`;
    }
    
    const simplified = {};
    
    // Keep essential fields
    if (schema.type) simplified.type = schema.type;
    if (schema.format) simplified.format = schema.format;
    if (schema.enum) simplified.enum = schema.enum;
    if (schema.required) simplified.required = schema.required;
    if (schema.$ref) simplified.$ref = cleanSchemaRef(schema.$ref);
    
    // Simplify properties using compact format
    if (schema.properties) {
      simplified.properties = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        const simplifiedProp = simplifySchema(prop);
        
        // Use compact "[type] [name]" format for simple properties
        if (typeof simplifiedProp === 'string') {
          simplified.properties[`${simplifiedProp} ${key}`] = true;
        } else {
          simplified.properties[key] = simplifiedProp;
        }
      }
    }
    
    if (schema.items) {
      simplified.items = simplifySchema(schema.items);
    }
    
    return simplified;
  };

  const truncateDescription = (desc, maxLength = 100) => {
    if (!desc || typeof desc !== 'string') return undefined;
    const cleaned = desc.replace(/\s+/g, ' ').trim();
    return cleaned.length <= maxLength ? cleaned : cleaned.substring(0, maxLength) + '...';
  };

  const simplifySpec = (spec) => {
    const simplified = {};
    
    // Host information
    if (spec.servers?.[0]?.url) {
      simplified.host = spec.servers[0].url;
    } else if (spec.host) {
      simplified.host = spec.host;
    }
    
    // Security schemes
    if (spec.components?.securitySchemes || spec.securityDefinitions) {
      const secSchemes = spec.components?.securitySchemes || spec.securityDefinitions;
      simplified.sec = Object.keys(secSchemes);
    }
    
    // Process endpoints
    simplified.endpoints = [];
    
    if (spec.paths) {
      for (const [path, pathItem] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(pathItem)) {
          if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
          
          const endpoint = {
            m: method.toLowerCase(),
            p: path
          };
          
          // Add operation description if present
          const desc = truncateDescription(operation.summary || operation.description);
          if (desc) endpoint.desc = desc;
          
          // Parameters
          if (operation.parameters) {
            const pathParams = operation.parameters.filter(p => p.in === 'path');
            const queryParams = operation.parameters.filter(p => p.in === 'query');
            
            if (pathParams.length) {
              endpoint.pp = pathParams.map(p => {
                let paramStr = `${p.name}:${p.schema?.type || p.type || 'unknown'}`;
                if (p.required === false) paramStr += '?'; // Mark optional params
                return paramStr;
              });
            }
            
            if (queryParams.length) {
              endpoint.qp = queryParams.map(p => {
                let paramStr = `${p.name}:${p.schema?.type || p.type || 'unknown'}`;
                if (p.required === false) paramStr += '?'; // Mark optional params
                if (p.schema?.format) paramStr += `(${p.schema.format})`;
                if (p.schema?.enum) paramStr += `[${p.schema.enum.join('|')}]`;
                return paramStr;
              });
            }
          }
          
          // Request body
          if (operation.requestBody) {
            const content = operation.requestBody.content;
            const jsonContent = content?.['application/json'];
            if (jsonContent?.schema?.$ref) {
              endpoint.req = cleanSchemaRef(jsonContent.schema.$ref);
            }
          }
          
          // Response
          const responses = operation.responses;
          const okResponse = responses?.['200'] || responses?.['201'];
          if (okResponse?.content?.['application/json']?.schema?.$ref) {
            endpoint.res = cleanSchemaRef(okResponse.content['application/json'].schema.$ref);
          }
          
          // Status codes
          endpoint.codes = Object.keys(responses || {}).map(Number).filter(c => !isNaN(c));
          
          simplified.endpoints.push(endpoint);
        }
      }
    }
    
    // Collect and include only referenced schemas
    const referencedSchemas = collectReferencedSchemas(spec);
    if (referencedSchemas.length && spec.components?.schemas) {
      simplified.schemas = {};
      for (const schemaName of referencedSchemas) {
        if (spec.components.schemas[schemaName]) {
          simplified.schemas[schemaName] = simplifySchema(spec.components.schemas[schemaName]);
        }
      }
    }
    
    return simplified;
  };

  const processSpec = useCallback(async () => {
    if (!inputSpec.trim()) {
      setOutputSpec('');
      setError('');
      return;
    }
    
    if (!yamlParser) {
      setError('YAML parser not loaded yet, please wait...');
      return;
    }
    
    setIsProcessing(true);
    setError('');
    
    try {
      const parsed = await parseSpec(inputSpec);
      const simplified = simplifySpec(parsed);
      const minified = JSON.stringify(simplified, null, 0);
      setOutputSpec(minified);
    } catch (err) {
      setError(`Error processing spec: ${err.message}`);
      setOutputSpec('');
    } finally {
      setIsProcessing(false);
    }
  }, [inputSpec, yamlParser]);

  // Auto-process when input changes
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      processSpec();
    }, 300); // Debounce by 300ms to avoid excessive processing

    return () => clearTimeout(timeoutId);
  }, [processSpec]);

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  };

  const downloadOutput = () => {
    const blob = new Blob([outputSpec], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'simplified-openapi-spec.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const loadExample = () => {
    const exampleSpec = `{
  "openapi": "3.0.0",
  "info": {
    "title": "Pet Store API",
    "description": "A simple API for managing pets",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "https://api.petstore.com/v1"
    }
  ],
  "paths": {
    "/pets": {
      "get": {
        "summary": "List all pets",
        "operationId": "listPets",
        "parameters": [
          {
            "name": "limit",
            "in": "query",
            "description": "How many items to return",
            "required": false,
            "schema": {
              "type": "integer",
              "format": "int32"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "A paged array of pets",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Pets"
                }
              }
            }
          }
        }
      },
      "post": {
        "summary": "Create a pet",
        "operationId": "createPet",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Pet"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Pet created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Pet"
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "Pet": {
        "type": "object",
        "required": ["id", "name"],
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "name": {
            "type": "string"
          },
          "tag": {
            "type": "string"
          }
        }
      },
      "Pets": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/Pet"
        }
      }
    }
  }
}`;
    setInputSpec(exampleSpec);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            OpenAPI Spec Simplifier for LLMs
          </h1>
          <p className="text-gray-600 max-w-2xl mx-auto">
            Convert your OpenAPI/Swagger specs into a minimal, token-efficient format optimized for LLM consumption.
            Automatically processes as you type - just paste your spec and watch it simplify in real-time.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Input Panel */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="border-b border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">
                  Input: OpenAPI Spec (JSON/YAML) {inputSpec && `(${inputSpec.length.toLocaleString()} chars)`}
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={loadExample}
                    className="px-3 py-1 text-sm bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition-colors"
                  >
                    Load Example
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4">
              <textarea
                value={inputSpec}
                onChange={(e) => setInputSpec(e.target.value)}
                placeholder="Paste your OpenAPI spec here (JSON or YAML format)..."
                className="w-full h-96 p-3 font-mono text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
              {error && (
                <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Output Panel */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="border-b border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">
                  Output: Simplified Spec {outputSpec ? `(${outputSpec.length.toLocaleString()} chars)` : ''}
                </h2>
                {outputSpec && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => copyToClipboard(outputSpec)}
                      className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                      title="Copy to clipboard"
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      onClick={downloadOutput}
                      className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                      title="Download as JSON"
                    >
                      <Download size={16} />
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="p-4">
              {outputSpec ? (
                <div className="relative">
                  <textarea
                    value={outputSpec}
                    readOnly
                    className="w-full h-96 p-3 font-mono text-sm border border-gray-300 rounded-md bg-gray-50 resize-none"
                  />
                  <div className="mt-2 text-xs text-gray-500">
                    Token reduction: ~{Math.round(((inputSpec.length - outputSpec.length) / inputSpec.length) * 100)}%
                  </div>
                </div>
              ) : (
                <div className="h-96 flex items-center justify-center text-gray-500 bg-gray-50 rounded-md border-2 border-dashed border-gray-300">
                  <div className="text-center">
                    <Upload size={48} className="mx-auto mb-4 text-gray-400" />
                    <p>Simplified spec will appear here</p>
                    <p className="text-sm mt-1">Start typing or paste a spec to see live results</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Info Panel */}
        <div className="mt-6 bg-blue-50 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">How it works:</h3>
          <div className="grid md:grid-cols-2 gap-4 text-sm text-blue-800">
            <div>
              <h4 className="font-semibold mb-2">What's kept:</h4>
              <ul className="space-y-1">
                <li>• Host URLs and security schemes</li>
                <li>• All endpoints with methods and paths</li>
                <li>• Brief descriptions (first 100 chars)</li>
                <li>• Parameter names, types, and requirements</li>
                <li>• Request/response schema references</li>
                <li>• Only referenced schemas with minimal fields</li>
                <li>• Status codes and enum values</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-2">What's removed:</h4>
              <ul className="space-y-1">
                <li>• Long descriptions (truncated to 100 chars)</li>
                <li>• Examples and sample data</li>
                <li>• Documentation and markdown</li>
                <li>• Tags and external docs</li>
                <li>• Verbose titles and summaries</li>
                <li>• Unused schema definitions</li>
                <li>• Pretty formatting and whitespace</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OpenAPISimplifier;