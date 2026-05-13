/**
 * Subset of JSON Schema we use to describe webhook payload shapes.
 * Intentionally narrow — only the keywords the audit's condition-path
 * walker and the editor's typeahead need. Adding more keywords (`oneOf`,
 * `$ref`, `enum`, ...) is fine when a real consumer needs them.
 */

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  /**
   * Allows the schema author to mark a node as "anything under here" —
   * the audit treats this as accepting any deeper path. Equivalent to
   * `additionalProperties: true` at this level, more explicit at the
   * use site.
   */
  readonly passthrough?: boolean;
}
