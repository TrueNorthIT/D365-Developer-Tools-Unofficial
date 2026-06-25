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
        const notes: string[] = [];
        if (attr.isPrimaryId)   { notes.push('Primary ID'); }
        if (attr.isPrimaryName) { notes.push('Primary Name'); }
        if (attr.attributeType === 'DateTime') { notes.push('ISO 8601 string'); }
        if (attr.attributeType === 'Lookup' || attr.attributeType === 'Customer' || attr.attributeType === 'Owner') {
            notes.push('lookup — field appears as _logicalname_value in API responses');
        }

        if (notes.length) {
            lines.push(`    /** ${notes.join(' | ')} */`);
        }

        const enumName = OPTION_SET_TYPES.has(attr.attributeType) ? enumNames?.get(attr.logicalName) : undefined;
        lines.push(`    ${attr.logicalName}: ${enumName ?? mapType(attr.attributeType)};`);
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
    return s.split(/[_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function toEnumKey(label: string): string {
    const sanitized = label.replace(/[^a-zA-Z0-9 _]/g, ' ').trim();
    const pascal    = toPascalCase(sanitized || 'Unknown');
    return /^\d/.test(pascal) ? '_' + pascal : pascal;
}
