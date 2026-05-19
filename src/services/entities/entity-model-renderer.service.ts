import type {
  EntityKindSchema,
  JSONSchemaProperty,
  RelationsConfig,
} from './entity-schema.service';

export interface RenderOptions {
  schemas: Record<string, EntityKindSchema>;
  relations: RelationsConfig;
  kinds: string[];
}

export function renderEntityModel(options: RenderOptions): string {
  const inScope = new Set(options.kinds);
  const lines: string[] = [];
  lines.push(
    'You have a knowledge base of entities you can read and write. The kinds you can work with on this route:',
  );
  lines.push('');

  for (const kind of options.kinds) {
    const schema = options.schemas[kind];
    if (schema === undefined) {
      lines.push(`### ${kind}`);
      lines.push('No schema declared. Properties are schemaless.');
      lines.push('');
      continue;
    }
    lines.push(`### ${kind}`);
    if (schema.description !== undefined) {
      lines.push(schema.description);
    }
    const required = new Set(schema.required ?? []);
    const propertyEntries = Object.entries(schema.properties);
    if (propertyEntries.length === 0) {
      lines.push('No properties declared.');
    } else {
      lines.push('Properties:');
      for (const [propertyName, propertyDefinition] of propertyEntries) {
        const requiredMarker = required.has(propertyName) ? ' (required)' : '';
        const typeLabel = formatType(propertyDefinition);
        const description = propertyDefinition.description ?? '';
        const enumPart =
          propertyDefinition.enum !== undefined
            ? ` enum: [${propertyDefinition.enum.map((v) => JSON.stringify(v)).join(', ')}]`
            : '';
        const descriptionPart = description === '' ? '' : ` — ${description}`;
        lines.push(
          `- \`${propertyName}\`${requiredMarker}: ${typeLabel}${enumPart}${descriptionPart}`,
        );
      }
    }
    lines.push('');
  }

  lines.push('## Relations');
  const relevantRelations = Object.entries(options.relations).filter(
    ([, declaration]) => inScope.has(declaration.from) && inScope.has(declaration.to),
  );
  if (relevantRelations.length === 0) {
    lines.push('No relations in scope for this route.');
  } else {
    for (const [type, declaration] of relevantRelations) {
      const propertiesPart =
        declaration.properties === undefined
          ? ''
          : ` { ${Object.entries(declaration.properties)
              .map(([propertyName, propertyDefinition]) => {
                const enumLabel =
                  propertyDefinition.enum !== undefined
                    ? `: ${propertyDefinition.enum.map((v) => JSON.stringify(v)).join('|')}`
                    : '';
                return `${propertyName}${enumLabel}`;
              })
              .join(', ')} }`;
      const descriptionPart =
        declaration.description === undefined ? '' : ` — ${declaration.description}`;
      lines.push(
        `- \`${declaration.from}\` --${type}${propertiesPart}--> \`${declaration.to}\`${descriptionPart}`,
      );
    }
  }
  return lines.join('\n');
}

function formatType(property: JSONSchemaProperty): string {
  if (property.type === undefined) return 'any';
  if (Array.isArray(property.type)) return property.type.join('|');
  if (property.type === 'array' && property.items?.type !== undefined) {
    return `${String(property.items.type)}[]`;
  }
  if (property.format !== undefined) return `${property.type} (${property.format})`;
  return property.type;
}
