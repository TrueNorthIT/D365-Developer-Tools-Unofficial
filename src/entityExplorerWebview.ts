import * as vscode from 'vscode';
import type { ConnectionManager } from './connectionManager';
import type { DataverseClient } from './dataverseClient';
import { generateInterface, generateEnum, toPascalCase, OPTION_SET_TYPES } from './interfaceGenerator';

export class EntityExplorerWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'd365.entityExplorer';

    private _view: vscode.WebviewView | undefined;

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly client: DataverseClient,
    ) {
        connectionManager.onDidChangeConnection(conn => {
            this.post({ type: 'connectionState', connected: !!conn, restoring: false });
            if (conn) { this.sendEntities(); }
        });
    }

    refresh(): void { this.sendEntities(); }

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true, enableCommandUris: true };
        view.webview.html = buildHtml();
        view.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                vscode.window.showErrorMessage(`D365 webview error: ${errMsg(err)}`);
            }
        });
    }

    // ── Message handling ────────────────────────────────────────────────────

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.post({ type: 'connectionState', connected: this.connectionManager.isConnected, restoring: this.connectionManager.isRestoring });
                if (this.connectionManager.isConnected) { await this.sendEntities(); }
                break;
            case 'connect':
                await this.connectionManager.connect();
                break;
            case 'loadAttributes':
                await this.sendAttributes(msg.entityLogicalName as string);
                break;
            case 'showSolutionPicker':
                await this.showSolutionPicker();
                break;
            case 'makeInterface':
                await this.makeInterface(
                    msg.entityLogicalName as string,
                    msg.entityDisplayName as string,
                );
                break;
            case 'makeEnum':
                await this.makeEnum(
                    msg.entityLogicalName as string,
                    msg.attributeLogicalName as string,
                    msg.attributeDisplayName as string,
                    msg.attributeType as string,
                );
                break;
        }
    }

    private async sendEntities(): Promise<void> {
        this.post({ type: 'entitiesLoading' });
        try {
            const data = await this.client.getEntities();
            this.post({ type: 'entities', data });
        } catch (err) {
            this.post({ type: 'entitiesError', message: errMsg(err) });
        }
    }

    private async sendAttributes(entityLogicalName: string): Promise<void> {
        try {
            const data = await this.client.getAttributes(entityLogicalName);
            this.post({ type: 'attributes', entityLogicalName, data });
        } catch (err) {
            this.post({ type: 'attributesError', entityLogicalName, message: errMsg(err) });
        }
    }

    async makeInterface(entityLogicalName: string, entityDisplayName: string): Promise<void> {
        let attributes;
        try {
            attributes = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Loading fields for '${entityLogicalName}'…`, cancellable: false },
                () => this.client.getAttributes(entityLogicalName),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load fields: ${errMsg(err)}`);
            return;
        }

        const picks = await vscode.window.showQuickPick(
            attributes.map(a => ({
                label: a.displayName || a.logicalName,
                description: a.logicalName,
                detail: [
                    a.attributeType,
                    a.isPrimaryId && 'Primary ID',
                    a.isPrimaryName && 'Primary Name',
                ].filter(Boolean).join('  ·  '),
                picked: a.isPrimaryId || a.isPrimaryName,
                attribute: a,
            })),
            {
                title: `Select fields — ${entityDisplayName} (${entityLogicalName})`,
                placeHolder: 'Choose fields to include in the interface…',
                canPickMany: true,
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );

        if (!picks?.length) { return; }

        const selectedAttrs  = picks.map(p => p.attribute);
        const optionSetAttrs = selectedAttrs.filter(a => OPTION_SET_TYPES.has(a.attributeType));

        // Fetch option values for all selected option set fields
        const enumBlocks: string[] = [];
        const enumNames = new Map<string, string>();

        if (optionSetAttrs.length) {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'D365: Loading option sets…', cancellable: false },
                    async () => {
                        for (const attr of optionSetAttrs) {
                            const options = await this.client.getAttributeOptions(entityLogicalName, attr.logicalName, attr.attributeType);
                            const enumName = toPascalCase(attr.displayName || attr.logicalName);
                            enumNames.set(attr.logicalName, enumName);
                            enumBlocks.push(generateEnum(attr.logicalName, attr.displayName, options));
                        }
                    },
                );
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to load option sets: ${errMsg(err)}`);
                return;
            }
        }

        const parts: string[] = [
            ...enumBlocks,
            generateInterface(entityLogicalName, entityDisplayName, selectedAttrs, enumNames),
        ];

        const doc = await vscode.workspace.openTextDocument({ content: parts.join('\n\n'), language: 'typescript' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    async makeEnum(entityLogicalName: string, attributeLogicalName: string, attributeDisplayName: string, attributeType: string): Promise<void> {
        let options;
        try {
            options = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Loading options for '${attributeDisplayName || attributeLogicalName}'…`, cancellable: false },
                () => this.client.getAttributeOptions(entityLogicalName, attributeLogicalName, attributeType),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load option set: ${errMsg(err)}`);
            return;
        }

        const text = generateEnum(attributeLogicalName, attributeDisplayName, options);
        const doc  = await vscode.workspace.openTextDocument({ content: text, language: 'typescript' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async showSolutionPicker(): Promise<void> {
        let solutions;
        try {
            solutions = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'D365: Loading solutions…', cancellable: false },
                () => this.client.getSolutions(),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load solutions: ${errMsg(err)}`);
            return;
        }

        const pick = await vscode.window.showQuickPick(
            solutions.map(s => ({ label: s.friendlyName, description: s.uniqueName, solution: s })),
            { title: 'D365: Filter by solution', placeHolder: 'Select a solution…', matchOnDescription: true },
        );
        if (!pick) { return; }

        let entityIds;
        try {
            entityIds = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'D365: Loading solution components…', cancellable: false },
                () => this.client.getSolutionEntityIds(pick.solution.solutionId),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load solution components: ${errMsg(err)}`);
            return;
        }

        this.post({ type: 'solutionFilter', name: pick.solution.friendlyName, entityIds: [...entityIds] });
    }

    private post(message: unknown): void {
        this._view?.webview.postMessage(message);
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ── HTML ────────────────────────────────────────────────────────────────────

function buildHtml(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    overflow-x: hidden;
  }

  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 6px 8px;
    display: flex; flex-direction: column; gap: 4px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  }

  .search-wrap { position: relative; display: flex; align-items: center; }
  .search-icon { position: absolute; left: 7px; font-size: 11px; opacity: 0.5; pointer-events: none; }

  input[type=text] {
    width: 100%;
    padding: 4px 8px 4px 24px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    outline: none;
    font-family: inherit; font-size: inherit;
  }
  input[type=text]:focus {
    border-color: var(--vscode-focusBorder);
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  input[type=text]::placeholder { color: var(--vscode-input-placeholderForeground); }

  .solution-row { display: flex; gap: 4px; }

  .chip {
    flex: 1; min-width: 0;
    display: flex; align-items: center; gap: 5px;
    padding: 3px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; cursor: pointer;
    font-family: inherit; font-size: inherit;
    overflow: hidden; text-align: left;
  }
  .chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .chip-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .chip-clear {
    padding: 3px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; cursor: pointer; font-size: 12px;
    font-family: inherit;
  }
  .chip-clear:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .message {
    padding: 12px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .message.error { color: var(--vscode-errorForeground, #f44); }

  .entity-header {
    display: flex; align-items: baseline; gap: 5px;
    padding: 3px 8px;
    cursor: pointer; user-select: none;
  }
  .entity-header:hover { background: var(--vscode-list-hoverBackground); }
  .entity-header.expanded { background: var(--vscode-list-inactiveSelectionBackground); }

  .chevron { font-size: 9px; width: 10px; flex-shrink: 0; opacity: 0.7; }
  .entity-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entity-lname { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }

  .attributes {
    border-left: 2px solid var(--vscode-tree-indentGuidesStroke, var(--vscode-panel-border));
    margin-left: 17px;
  }

  .attr-row {
    display: flex; align-items: baseline; gap: 6px;
    padding: 2px 8px 2px 6px;
  }
  .attr-row:hover { background: var(--vscode-list-hoverBackground); }

  .attr-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .attr-lname { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
  .pk-marker { font-size: 11px; flex-shrink: 0; opacity: 0.8; }

  .type-badge {
    flex-shrink: 0; font-size: 10px; padding: 0 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85;
  }
  .t-str  { background: #1e4a7a; color: #7bc8f6; }
  .t-num  { background: #3d2e00; color: #e5c07b; }
  .t-bool { background: #2d1f4e; color: #c678dd; }
  .t-date { background: #1a3d2e; color: #98c379; }
  .t-lkp  { background: #1a3d3d; color: #56b6c2; }
  .t-opt  { background: #3d2600; color: #d19a66; }
  .t-key  { background: #2d2d2d; color: #abb2bf; }
  .t-def  { background: #2d2d2d; color: #abb2bf; }

  #disconnected { padding: 16px 12px; text-align: center; }
  #disconnected p { color: var(--vscode-descriptionForeground); margin: 0 0 12px; font-size: 12px; }
  #connect-btn {
    display: inline-block;
    padding: 5px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; cursor: pointer;
    font-family: inherit; font-size: inherit;
    text-decoration: none;
  }
  #connect-btn:hover { background: var(--vscode-button-hoverBackground); }

  #restoring { padding: 16px 12px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }


  .spinner {
    display: inline-block; width: 10px; height: 10px;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: transparent; border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle; margin-right: 4px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Context menu ── */
  #ctx-menu {
    display: none; position: fixed; z-index: 1000;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    min-width: 160px; padding: 2px 0;
  }
  #ctx-menu button {
    display: block; width: 100%;
    padding: 6px 16px;
    background: none; border: none;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    text-align: left; cursor: pointer;
    font-family: inherit; font-size: inherit;
    white-space: nowrap;
  }
  #ctx-menu button:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
  }
</style>
</head>
<body>

<div id="ctx-menu">
  <button id="ctx-make-interface">Make Interface</button>
  <button id="ctx-make-enum" style="display:none">Make Enum</button>
</div>

<div id="restoring" style="display:none">
  <span class="spinner"></span>Connecting…
</div>

<div id="disconnected">
  <p>Connect to a D365 environment to browse entities.</p>
  <a href="command:d365.connect" id="connect-btn">Connect</a>
</div>

<div id="main" style="display:none">
  <div class="toolbar">
    <div class="search-wrap">
      <span class="search-icon">⌕</span>
      <input id="search" type="text" placeholder="Search entities…" />
    </div>
    <div class="solution-row">
      <button class="chip" id="solution-btn">
        <span class="chip-label" id="solution-label">All solutions</span>
        <span>&#9662;</span>
      </button>
      <button class="chip-clear" id="solution-clear" style="display:none" title="Clear solution filter">&#x2715;</button>
    </div>
  </div>
  <div id="entity-list"></div>
</div>

<script nonce="${nonce}">
try {

const vscode = acquireVsCodeApi();
const post = (type, data) => vscode.postMessage(data ? { type, ...data } : { type });

let entities   = [];
let attrCache  = {};       // { [logicalName]: { data?, loading?, error? } }
let expanded   = new Set();
let searchFilter  = '';
let solutionFilter = null; // { name, entityIds: Set<string> }

// ── Extension → Webview messages ─────────────────────────────────────────────

window.addEventListener('message', ({ data: m }) => {
  switch (m.type) {
    case 'connectionState': {
      var show = function(id, visible) {
        var el = document.getElementById(id);
        if (el) { el.style.display = visible ? '' : 'none'; }
      };
      show('restoring',   !!m.restoring);
      show('disconnected', !m.connected && !m.restoring);
      show('main',        !!m.connected);
      break;
    }

    case 'entitiesLoading':
      document.getElementById('entity-list').innerHTML =
        '<div class="message"><span class="spinner"></span>Loading entities…</div>';
      break;

    case 'entities':
      entities = m.data;
      attrCache = {}; expanded = new Set();
      renderList();
      break;

    case 'entitiesError':
      document.getElementById('entity-list').innerHTML =
        '<div class="message error">' + esc(m.message) + '</div>';
      break;

    case 'attributes': {
      attrCache[m.entityLogicalName] = { data: m.data };
      const el = document.querySelector('[data-entity="' + CSS.escape(m.entityLogicalName) + '"] .attributes');
      if (el) { el.innerHTML = renderAttrs(m.data); }
      break;
    }

    case 'attributesError': {
      attrCache[m.entityLogicalName] = { error: m.message };
      const el = document.querySelector('[data-entity="' + CSS.escape(m.entityLogicalName) + '"] .attributes');
      if (el) { el.innerHTML = '<div class="message error">' + esc(m.message) + '</div>'; }
      break;
    }

    case 'solutionFilter':
      solutionFilter = { name: m.name, entityIds: new Set(m.entityIds) };
      document.getElementById('solution-label').textContent = m.name;
      document.getElementById('solution-btn').classList.add('active');
      document.getElementById('solution-clear').style.display = '';
      renderList();
      break;
  }
});

// ── Static event listeners ────────────────────────────────────────────────────

// connect and disconnect use command: URIs directly — no click handlers needed

document.getElementById('search').addEventListener('input', function () {
  searchFilter = this.value.trim().toLowerCase();
  renderList();
});

document.getElementById('solution-btn').addEventListener('click', () => post('showSolutionPicker'));

document.getElementById('solution-clear').addEventListener('click', function () {
  solutionFilter = null;
  document.getElementById('solution-label').textContent = 'All solutions';
  document.getElementById('solution-btn').classList.remove('active');
  this.style.display = 'none';
  renderList();
});

// Event delegation for entity rows (handles dynamically rendered content)
document.getElementById('entity-list').addEventListener('click', function (e) {
  const header = e.target.closest('.entity-header');
  if (!header) { return; }
  const item = header.closest('[data-entity]');
  if (item) { toggleEntity(item.getAttribute('data-entity')); }
});

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderList() {
  const filtered = getFiltered();
  const list = document.getElementById('entity-list');

  if (!filtered.length) {
    list.innerHTML = '<div class="message">No entities match the current filters.</div>';
    return;
  }

  list.innerHTML = filtered.map(function (e) {
    const isExp   = expanded.has(e.logicalName);
    const cached  = attrCache[e.logicalName];
    let attrsHtml = '';
    if (isExp) {
      attrsHtml = '<div class="attributes">' + (
        !cached          ? '<div class="message"><span class="spinner"></span>Loading…</div>' :
        cached.error     ? '<div class="message error">' + esc(cached.error) + '</div>' :
                           renderAttrs(cached.data)
      ) + '</div>';
    }
    return '<div data-entity="' + esc(e.logicalName) + '">'
      + '<div class="entity-header' + (isExp ? ' expanded' : '') + '">'
      + '<span class="chevron">' + (isExp ? '&#9660;' : '&#9658;') + '</span>'
      + '<span class="entity-name">' + esc(e.displayName || e.logicalName) + '</span>'
      + '<span class="entity-lname">' + esc(e.logicalName) + '</span>'
      + '</div>'
      + attrsHtml
      + '</div>';
  }).join('');
}

function renderAttrs(attrs) {
  if (!attrs || !attrs.length) { return '<div class="message">No attributes found.</div>'; }
  return attrs.map(function (a) {
    const marker = a.isPrimaryId   ? '<span class="pk-marker" title="Primary ID">⚿</span>'
                 : a.isPrimaryName ? '<span class="pk-marker" title="Primary Name">✎</span>'
                 : '';
    return '<div class="attr-row" data-attr="' + esc(a.logicalName) + '" data-type="' + esc(a.attributeType) + '" data-display="' + esc(a.displayName || a.logicalName) + '">'
      + marker
      + '<span class="attr-name">'  + esc(a.displayName || a.logicalName) + '</span>'
      + '<span class="attr-lname">' + esc(a.logicalName)                  + '</span>'
      + '<span class="type-badge '  + typeClass(a.attributeType) + '">'   + esc(shortType(a.attributeType)) + '</span>'
      + '</div>';
  }).join('');
}

function toggleEntity(logicalName) {
  const item = document.querySelector('[data-entity="' + CSS.escape(logicalName) + '"]');
  if (!item) { return; }

  if (expanded.has(logicalName)) {
    expanded.delete(logicalName);
    item.querySelector('.chevron').innerHTML = '&#9658;';
    item.querySelector('.entity-header').classList.remove('expanded');
    var attrs = item.querySelector('.attributes');
    if (attrs) { attrs.remove(); }
  } else {
    expanded.add(logicalName);
    item.querySelector('.chevron').innerHTML = '&#9660;';
    item.querySelector('.entity-header').classList.add('expanded');

    var div = document.createElement('div');
    div.className = 'attributes';
    var cached = attrCache[logicalName];
    if (!cached) {
      div.innerHTML = '<div class="message"><span class="spinner"></span>Loading…</div>';
      attrCache[logicalName] = { loading: true };
      post('loadAttributes', { entityLogicalName: logicalName });
    } else if (cached.error) {
      div.innerHTML = '<div class="message error">' + esc(cached.error) + '</div>';
    } else {
      div.innerHTML = renderAttrs(cached.data);
    }
    item.appendChild(div);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFiltered() {
  var result = entities;
  if (searchFilter) {
    result = result.filter(function (e) {
      return e.logicalName.indexOf(searchFilter) !== -1 ||
             e.displayName.toLowerCase().indexOf(searchFilter) !== -1;
    });
  }
  if (solutionFilter) {
    result = result.filter(function (e) { return solutionFilter.entityIds.has(e.metadataId); });
  }
  return result;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortType(t) {
  var map = {
    String:'str', Memo:'str', Integer:'int', BigInt:'int',
    Double:'dec', Decimal:'dec', Boolean:'bool', DateTime:'date',
    Money:'$', Lookup:'lkp', Customer:'lkp', Owner:'lkp',
    Picklist:'opt', State:'state', Status:'status',
    Uniqueidentifier:'uid', EntityName:'ent', Virtual:'virt'
  };
  return map[t] || t;
}

function typeClass(t) {
  if (t === 'String' || t === 'Memo' || t === 'EntityName') { return 't-str'; }
  if (t === 'Integer' || t === 'BigInt' || t === 'Double' || t === 'Decimal') { return 't-num'; }
  if (t === 'Boolean')  { return 't-bool'; }
  if (t === 'DateTime') { return 't-date'; }
  if (t === 'Lookup' || t === 'Customer' || t === 'Owner') { return 't-lkp'; }
  if (t === 'Picklist' || t === 'State' || t === 'Status') { return 't-opt'; }
  if (t === 'Uniqueidentifier') { return 't-key'; }
  return 't-def';
}

// ── Context menu ──────────────────────────────────────────────────────────────

var OPTION_SET_TYPES = new Set(['Picklist', 'State', 'Status']);

var ctxLogicalName      = null;
var ctxDisplayName      = null;
var ctxAttrLogicalName  = null;
var ctxAttrDisplayName  = null;
var ctxAttrType         = null;

document.getElementById('entity-list').addEventListener('contextmenu', function (e) {
  var header  = e.target.closest('.entity-header');
  var attrRow = e.target.closest('.attr-row[data-attr]');

  if (header) {
    e.preventDefault();
    var item = header.closest('[data-entity]');
    if (!item) { return; }
    ctxLogicalName = item.getAttribute('data-entity');
    ctxDisplayName = item.querySelector('.entity-name').textContent || ctxLogicalName;
    ctxAttrLogicalName = null;
    document.getElementById('ctx-make-interface').style.display = '';
    document.getElementById('ctx-make-enum').style.display      = 'none';
    showCtx(e.clientX, e.clientY);
  } else if (attrRow) {
    var attrType = attrRow.getAttribute('data-type');
    if (!OPTION_SET_TYPES.has(attrType)) { return; }
    e.preventDefault();
    var entityItem = attrRow.closest('[data-entity]');
    if (!entityItem) { return; }
    ctxLogicalName     = entityItem.getAttribute('data-entity');
    ctxAttrLogicalName = attrRow.getAttribute('data-attr');
    ctxAttrDisplayName = attrRow.getAttribute('data-display');
    ctxAttrType        = attrType;
    document.getElementById('ctx-make-interface').style.display = 'none';
    document.getElementById('ctx-make-enum').style.display      = '';
    showCtx(e.clientX, e.clientY);
  } else {
    hideCtx();
  }
});

document.getElementById('ctx-make-interface').addEventListener('click', function () {
  var logicalName = ctxLogicalName;
  var displayName = ctxDisplayName;
  hideCtx();
  if (logicalName) {
    post('makeInterface', { entityLogicalName: logicalName, entityDisplayName: displayName });
  }
});

document.getElementById('ctx-make-enum').addEventListener('click', function () {
  var entityLogicalName    = ctxLogicalName;
  var attributeLogicalName = ctxAttrLogicalName;
  var attributeDisplayName = ctxAttrDisplayName;
  var attributeType        = ctxAttrType;
  hideCtx();
  if (entityLogicalName && attributeLogicalName) {
    post('makeEnum', { entityLogicalName, attributeLogicalName, attributeDisplayName, attributeType });
  }
});

document.addEventListener('click',   hideCtx);
document.addEventListener('scroll',  hideCtx, true);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideCtx(); } });

function showCtx(x, y) {
  var menu = document.getElementById('ctx-menu');
  menu.style.display = 'block';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  var r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  { menu.style.left = (x - r.width)  + 'px'; }
  if (r.bottom > window.innerHeight) { menu.style.top  = (y - r.height) + 'px'; }
}

function hideCtx() {
  document.getElementById('ctx-menu').style.display = 'none';
  ctxLogicalName     = null;
  ctxDisplayName     = null;
  ctxAttrLogicalName = null;
  ctxAttrDisplayName = null;
  ctxAttrType        = null;
}

post('ready');

} catch (e) {
  document.body.innerHTML = '<div style="padding:12px;color:#f44;font-size:12px;white-space:pre-wrap">Webview script error:\\n' + (e && e.message || String(e)) + '</div>';
}
</script>
</body>
</html>`;
}
