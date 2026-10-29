import * as fs from 'fs';
import * as path from 'path';
import { FormModel, parseChoicesYaml, parseFormYaml, parseTableYaml, parseViewYaml, TableModel, ViewModel } from './formModel';

/**
 * Loads sibling-table data for subgrids from a d365architect export tree
 * (`<root>/<entity>/*.view.yml`, `<entity>.table.yml`), where `<root>` is the parent of the form's folder.
 * Node-only (fs) but has no `vscode` import. Parses are cached per file by mtime so live
 * re-rendering while typing doesn't re-read every view.
 */
interface Entry<T> { mtimeMs: number; value: T | undefined }

const viewCache = new Map<string, Entry<ViewModel>>();
const formCache = new Map<string, Entry<FormModel>>();
const tableCache = new Map<string, Entry<TableModel>>();
const choicesCache = new Map<string, Entry<Map<string, Map<number, string>>>>();

function cachedParse<T>(cache: Map<string, Entry<T>>, file: string, build: (text: string) => T | undefined): T | undefined {
    try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === mtimeMs) { return hit.value; }
        const value = build(fs.readFileSync(file, 'utf8'));
        cache.set(file, { mtimeMs, value });
        return value;
    } catch {
        return undefined;
    }
}

export class SiblingTableLoader {
    constructor(private readonly exportRoot: string) {}

    loadViews(entity: string): ViewModel[] {
        const dir = path.join(this.exportRoot, entity);
        let files: string[];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.view.yml')); } catch { return []; }
        return files
            .map(f => cachedParse(viewCache, path.join(dir, f), text => parseViewYaml(text).model))
            .filter((v): v is ViewModel => !!v);
    }

    /** Forms exported for `entity` (`<root>/<entity>/*.form.yml`), e.g. to find a quick view form by its `formId`. */
    loadForms(entity: string): FormModel[] {
        const dir = path.join(this.exportRoot, entity);
        let files: string[];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.form.yml')); } catch { return []; }
        return files
            .map(f => cachedParse(formCache, path.join(dir, f), text => parseFormYaml(text).model))
            .filter((m): m is FormModel => !!m);
    }

    loadTable(entity: string): TableModel | undefined {
        return cachedParse(tableCache, path.join(this.exportRoot, entity, `${entity}.table.yml`),
            text => parseTableYaml(text).model);
    }

    /** Global choice labels from `<root>/choices.yml` (choice name → value → label); undefined when there's no such file. */
    loadChoices(): Map<string, Map<number, string>> | undefined {
        return cachedParse(choicesCache, path.join(this.exportRoot, 'choices.yml'), text => parseChoicesYaml(text).model);
    }
}
