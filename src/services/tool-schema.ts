import type { JsonSchema, OpenAIFunctionTool } from "../types/openai.js";

export type ToolSpec = {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
};

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

export function functionToolsFromUnknown(tools: unknown): ToolSpec[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  const specs: ToolSpec[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") {
      continue;
    }
    const fn = (isRecord(tool.function) ? tool.function : tool) as OpenAIFunctionTool["function"];
    if (typeof fn.name !== "string" || !isToolName(fn.name)) {
      continue;
    }
    specs.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isRecord(fn.parameters) ? (fn.parameters as JsonSchema) : { type: "object" },
      strict: Boolean(fn.strict)
    });
  }
  return specs;
}

export function toolMap(tools: ToolSpec[]): Map<string, ToolSpec> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function validateToolArguments(tool: ToolSpec, args: unknown): ValidationResult {
  if (!isRecord(args)) {
    return { ok: false, errors: [`${tool.name}: arguments must be a JSON object`] };
  }
  const errors: string[] = [];
  validateSchema(tool.parameters ?? { type: "object" }, args, "$", errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: args };
}

export function toolSpecsForPrompt(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function isToolName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateSchema(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.anyOf?.length) {
    const nested = schema.anyOf.map((item) => {
      const branchErrors: string[] = [];
      validateSchema(item, value, path, branchErrors);
      return branchErrors;
    });
    if (nested.every((branch) => branch.length > 0)) {
      errors.push(`${path}: does not match any allowed schema`);
    }
    return;
  }

  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter((item) => {
      const branchErrors: string[] = [];
      validateSchema(item, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(`${path}: must match exactly one schema`);
    }
    return;
  }

  if (schema.enum && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return;
  }

  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesType(type, value))) {
    errors.push(`${path}: expected ${expectedTypes.join(" or ")}, got ${actualType(value)}`);
    return;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: length must be >= ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: length must be <= ${schema.maxLength}`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path}: does not match pattern ${schema.pattern}`);
        }
      } catch {
        errors.push(`${path}: schema pattern is invalid`);
      }
    }
    return;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items as JsonSchema, item, `${path}[${index}]`, errors));
    }
    return;
  }

  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) {
        errors.push(`${path}.${required}: required property is missing`);
      }
    }

    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        validateSchema(propertySchema, item, `${path}.${key}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property is not allowed`);
      } else if (isRecord(schema.additionalProperties)) {
        validateSchema(schema.additionalProperties as JsonSchema, item, `${path}.${key}`, errors);
      }
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function matchesType(type: string, value: unknown): boolean {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
