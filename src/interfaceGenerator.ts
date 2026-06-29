import type { AttributeDefinition, OptionValue } from './dataverseClient';

export const OPTION_SET_TYPES = new Set(['Picklist', 'State', 'Status']);

export function generateEnum(
    attributeLogicalName: string,
    attributeDisplayName: string,
    options: OptionValue[],
): string {
    const enumName = toPascalCase(attributeDisplayName || attributeLogicalName);
    const members  = options.map(o => `    ${toEnumKey(o.label)} = ${o.value},`).join('\n');
    return `export const enum ${enumName} {\n${members}\n}`;
}

export function generateInterface(
    entityLogicalName: string,
    entityDisplayName: string,
    attributes: AttributeDefinition[],
    enumNames?: Map<string, string>, // logicalName → enum type name
): string {
    const interfaceName = toPascalCase(entityLogicalName);
    const lines: string[] = [
        `// ${entityDisplayName} (${entityLogicalName})`,
        `export interface ${interfaceName} {`,
    ];

    for (const attr of attributes) {
        const isLookup = attr.attributeType === 'Lookup' || attr.attributeType === 'Customer' || attr.attributeType === 'Owner';
        const fieldName = isLookup ? `_${attr.logicalName}_value` : attr.logicalName;

        const notes: string[] = [];
        if (attr.isPrimaryId)   { notes.push('Primary ID'); }
        if (attr.isPrimaryName) { notes.push('Primary Name'); }
        if (attr.attributeType === 'DateTime') { notes.push('ISO 8601 string'); }

        if (notes.length) {
            lines.push(`    /** ${notes.join(' | ')} */`);
        }

        const enumName = OPTION_SET_TYPES.has(attr.attributeType) ? enumNames?.get(attr.logicalName) : undefined;
        lines.push(`    ${fieldName}: ${enumName ?? mapType(attr.attributeType)};`);

        if (isLookup) {
            lines.push(`    /** Display name of the related record. Only present when annotations are requested: Prefer: odata.include-annotations="OData.Community.Display.V1.FormattedValue" */`);
            lines.push(`    '${fieldName}@OData.Community.Display.V1.FormattedValue'?: string;`);
        }
    }

    lines.push('}');
    return lines.join('\n');
}

function mapType(type: string): string {
    switch (type) {
        case 'String':
        case 'Memo':
        case 'EntityName':
        case 'DateTime':          // ISO 8601 from Web API
        case 'Uniqueidentifier':  return 'string';
        case 'Integer':
        case 'BigInt':
        case 'Double':
        case 'Decimal':
        case 'Money':
        case 'Picklist':
        case 'State':
        case 'Status':            return 'number';
        case 'Boolean':           return 'boolean';
        case 'Lookup':
        case 'Customer':
        case 'Owner':             return 'string | null';
        default:                  return 'unknown';
    }
}

export function toPascalCase(s: string): string {
    const sanitized = s.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
    const pascal = sanitized
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
    return /^\d/.test(pascal) ? '_' + pascal : pascal;
}

function toEnumKey(label: string): string {
    const sanitized = label.replace(/[^a-zA-Z0-9 _]/g, ' ').trim();
    const pascal    = toPascalCase(sanitized || 'Unknown');
    return /^\d/.test(pascal) ? '_' + pascal : pascal;
}
