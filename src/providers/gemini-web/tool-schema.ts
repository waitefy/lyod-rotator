import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../compat/schema-sanitizer.js";

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ANNOTATIONS = new Set(["$schema", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const BOUNDS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const SIZES = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);

/** Validate the supported JSON Schema subset without silently dropping constraints. */
export function toolSchemaError(schema: unknown): string | undefined {
  let remaining = 2048;
  const visit = (node: unknown, path: string, depth: number): string | undefined => {
    if (--remaining < 0 || depth > 32) return `${path}: schema is too large or deeply nested`;
    if (typeof node === "boolean") return undefined;
    if (!isRecord(node)) return `${path}: expected an object or boolean schema`;
    for (const [key, value] of Object.entries(node)) {
      const location = `${path}.${key}`;
      if (ANNOTATIONS.has(key)) continue;
      if (key === "type") {
        const types = Array.isArray(value) ? value : [value];
        if (!types.length || types.some((type) => typeof type !== "string" || !TYPES.has(type)) ||
            new Set(types).size !== types.length) return `${location}: invalid schema type`;
      } else if (key === "properties") {
        if (!isRecord(value)) return `${location}: expected property schemas`;
        for (const [name, child] of Object.entries(value)) {
          const error = visit(child, `${location}.${name}`, depth + 1);
          if (error) return error;
        }
      } else if (["items", "additionalProperties"].includes(key)) {
        const error = visit(value, location, depth + 1);
        if (error) return error;
      } else if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(value) || !value.length) return `${location}: expected nonempty schema alternatives`;
        for (const [index, child] of value.entries()) {
          const error = visit(child, `${location}[${index}]`, depth + 1);
          if (error) return error;
        }
      } else if (key === "required") {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string") ||
            new Set(value).size !== value.length) return `${location}: expected unique required property names`;
      } else if (key === "enum") {
        if (!Array.isArray(value) || !value.length) return `${location}: expected a nonempty enum`;
      } else if (BOUNDS.has(key) || SIZES.has(key)) {
        if (typeof value !== "number" || !Number.isFinite(value) ||
            (SIZES.has(key) && (!Number.isSafeInteger(value) || value < 0))) return `${location}: invalid schema bound`;
      } else if (key === "nullable") {
        if (typeof value !== "boolean") return `${location}: expected a boolean`;
      } else if (key !== "const") return `${location}: unsupported schema keyword`;
    }
    return undefined;
  };
  return visit(schema, "parameters", 0);
}

/** Arguments come from JSON; a shared budget also bounds branching combinators. */
export function matchesToolSchema(value: unknown, schema: unknown): boolean {
  let remaining = 50000;
  const matches = (data: unknown, node: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 64) return false;
    if (typeof node === "boolean") return node;
    if (!isRecord(node)) return false;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (node.type !== undefined && !(data === null && node.nullable === true) &&
        !types.some((type) => {
          if (type === "null") return data === null;
          if (type === "object") return isRecord(data);
          if (type === "array") return Array.isArray(data);
          if (type === "integer") return Number.isInteger(data);
          return typeof data === type;
        })) return false;
    if (Object.hasOwn(node, "const") && !isDeepStrictEqual(data, node.const)) return false;
    if (Array.isArray(node.enum) && !node.enum.some((entry) => isDeepStrictEqual(data, entry))) return false;
    if (Array.isArray(node.anyOf) && !node.anyOf.some((child) => matches(data, child, depth + 1))) return false;
    if (Array.isArray(node.allOf) && !node.allOf.every((child) => matches(data, child, depth + 1))) return false;
    if (Array.isArray(node.oneOf) && node.oneOf.filter((child) => matches(data, child, depth + 1)).length !== 1) return false;
    if (typeof data === "number") {
      if (!Number.isFinite(data) || (typeof node.minimum === "number" && data < node.minimum) ||
          (typeof node.maximum === "number" && data > node.maximum) ||
          (typeof node.exclusiveMinimum === "number" && data <= node.exclusiveMinimum) ||
          (typeof node.exclusiveMaximum === "number" && data >= node.exclusiveMaximum)) return false;
    }
    if (typeof data === "string") {
      const length = [...data].length;
      if ((typeof node.minLength === "number" && length < node.minLength) ||
          (typeof node.maxLength === "number" && length > node.maxLength)) return false;
    }
    if (Array.isArray(data)) {
      if ((typeof node.minItems === "number" && data.length < node.minItems) ||
          (typeof node.maxItems === "number" && data.length > node.maxItems)) return false;
      if (node.items !== undefined && !data.every((entry) => matches(entry, node.items, depth + 1))) return false;
    }
    if (isRecord(data)) {
      const keys = Object.keys(data);
      if ((typeof node.minProperties === "number" && keys.length < node.minProperties) ||
          (typeof node.maxProperties === "number" && keys.length > node.maxProperties) ||
          (Array.isArray(node.required) && node.required.some((key) => !Object.hasOwn(data, String(key))))) return false;
      const properties = isRecord(node.properties) ? node.properties : {};
      for (const [key, entry] of Object.entries(data)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : node.additionalProperties;
        if (child !== undefined && !matches(entry, child, depth + 1)) return false;
      }
    }
    return remaining >= 0;
  };
  return matches(value, schema, 0);
}
