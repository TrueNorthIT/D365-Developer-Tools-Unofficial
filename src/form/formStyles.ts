/**
 * Dynamics-look CSS for the form preview, scoped under `.d365-form`.
 *
 * Values were read from the real Unified Interface: the live CSS rules (document.styleSheets
 * + Fluent v9 theme tokens) resolved against the DOM of a real record, not guessed. Highlights:
 * label column 180px to the LEFT of the control (control = calc(100% - 184px)), 14px/20px Segoe UI,
 * required marker rgb(188,47,50), #f5f5f5 control surfaces with a 4px radius and 32px min height,
 * white 8px-radius section cards, 16px/28px tab strip, #fafafa page background.
 * Deliberately NOT themed with VS Code variables: the preview should look like Dynamics.
 */
export const FORM_CSS = `
.d365-form{--control-h:32px;--brand:#0f6cbd;--fg1:#242424;--fg2:#424242;--fg3:#616161;--surface:#f5f5f5;--req:rgb(188,47,50);
  font-family:"Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif;
  font-size:14px;line-height:20px;color:var(--fg1);background:#fafafa;padding:8px;min-height:100vh;box-sizing:border-box}
.d365-form *{box-sizing:border-box}
.d365-form .notice{background:#fff4ce;border:1px solid #f2e0a0;border-radius:4px;padding:6px 10px;margin-bottom:8px;font-size:12px}
.d365-form .notice.error{background:#fbeceb;border-color:#e8b4b0;color:var(--req)}

/* header card (one white card): [title block | header fields] row, tab strip underneath */
.d365-form .form-head{background:#fff;border-radius:8px;min-height:51px;margin-top:8px}
.d365-form .head-row{display:flex;flex-wrap:wrap;align-items:flex-start;padding:14px 20px 0}
.d365-form.no-strip .head-row{padding-bottom:10px}
.d365-form .head-title{flex:1 1 360px;margin-right:40px;min-width:0}
/* header fields: bold 14px/20px value over a 12px/16px label, 1px dividers with 6px/12px margins (real header control list) */
.d365-form .head-fields{display:flex;align-items:flex-start}
.d365-form .hf{margin:4px 0 10px;min-width:0;max-width:240px}
.d365-form .hf-val{font-weight:600;line-height:20px;color:var(--fg1);white-space:pre-wrap;overflow:hidden;text-overflow:ellipsis}
.d365-form .hf-val.link{color:#115ea3}
.d365-form .hf-label{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis}
.d365-form .hf-divider{flex:0 0 auto;align-self:stretch;width:1px;margin:6px 12px;background:#e0e0e0}
.d365-form .form-title{display:flex;align-items:baseline;flex-wrap:wrap}
.d365-form .form-title h1{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--fg3);font-style:italic}
.d365-form .form-status{font-size:14px;line-height:28px;padding-left:6px;color:var(--fg3)}
.d365-form .form-entity{font-size:14px;font-weight:600;color:var(--fg2)}
.d365-form .form-meta{font-size:12px;color:var(--fg3);padding-bottom:6px}
.d365-form .tab-strip{display:flex;flex-wrap:wrap;padding:0 21px}
.d365-form .tab-btn{all:unset;cursor:pointer;font-size:16px;line-height:28px;margin-right:20px;padding-bottom:10px;
  max-width:30ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg1);border-bottom:3px solid transparent}
.d365-form .tab-btn:hover{color:var(--brand)}
.d365-form .tab-btn.active{font-weight:600;padding-bottom:7px;border-bottom-color:var(--brand)}

/* footer field strip */
.d365-form .strip{display:flex;flex-wrap:wrap;gap:24px;background:#fff;border-radius:8px;padding:10px 20px;margin-top:8px}
.d365-form .strip-label{font-size:12px;color:var(--fg3)}
.d365-form .strip-val{font-weight:600}

/* tab panel + columns (column gap 8px, padding-top 16px as in the real tab panel) */
.d365-form .tab-panel{display:none;padding:16px 2px 24px 0;container-type:inline-size}
.d365-form .tab-panel.active,.d365-form.no-strip .tab-panel{display:block}
.d365-form .tab-body{display:grid;gap:8px;align-items:start}
.d365-form .tab-col{min-width:0}
@container (max-width:720px){.d365-form .tab-body{grid-template-columns:minmax(0,1fr)!important}}

/* section card */
.d365-form .section{container-type:inline-size;background:#fff;padding:2px 10px 10px;border:1px solid transparent;border-radius:8px;
  box-shadow:rgba(0,0,0,.12) 0 0 2px,rgba(0,0,0,.14) 0 2px 4px;margin-bottom:16px}
.d365-form .section-title{margin:0;padding-top:4px;font-size:14px;line-height:20px;font-weight:600;color:var(--fg1)}
.d365-form .grid{display:grid;column-gap:24px;row-gap:0}
/* column stacks: width 100/n %, 1.5rem gutter on all but the last column, first field 2px tighter (as in the real client) */
.d365-form .cols{display:flex;flex-wrap:wrap}
.d365-form .col{min-width:0;padding-inline-end:1.5rem}
.d365-form .col:last-child{padding-inline-end:0}
.d365-form .col>.field:first-child{padding-top:10px}

/* narrow sections reflow to one column (the real client does the same when the tab column is narrow) */
@container (max-width:680px){.d365-form .cols[data-n="2"]{flex-direction:column}.d365-form .cols[data-n="2"]>.col{width:100%!important;padding-inline-end:0}.d365-form .grid[data-n="2"]{grid-template-columns:minmax(0,1fr)!important}.d365-form .grid[data-n="2"]>.field{grid-column:auto!important;grid-row:auto!important}}
@container (max-width:1020px){.d365-form .cols[data-n="3"]{flex-direction:column}.d365-form .cols[data-n="3"]>.col{width:100%!important;padding-inline-end:0}.d365-form .grid[data-n="3"]{grid-template-columns:minmax(0,1fr)!important}.d365-form .grid[data-n="3"]>.field{grid-column:auto!important;grid-row:auto!important}}
@container (max-width:1360px){.d365-form .cols[data-n="4"]{flex-direction:column}.d365-form .cols[data-n="4"]>.col{width:100%!important;padding-inline-end:0}.d365-form .grid[data-n="4"]{grid-template-columns:minmax(0,1fr)!important}.d365-form .grid[data-n="4"]>.field{grid-column:auto!important;grid-row:auto!important}}

/* field row: 180px label on the left, control fills the rest */
.d365-form .field{display:flex;flex-direction:row;align-items:flex-start;min-width:0;padding:14px 2px 2px 0}
.d365-form .field.unresolved .label::after{content:" ⚠";color:#b58900;font-size:11px}
.d365-form .label{display:flex;gap:4px;flex:0 0 180px;width:180px;min-width:180px;padding-top:2px;margin-right:4px;
  font-size:14px;line-height:20px;color:var(--fg1);overflow-wrap:break-word;word-break:break-word}
.d365-form .label-text{flex:1 1 auto;min-width:0}
.d365-form .req,.d365-form .rec{flex:0 0 8px;text-align:center}
.d365-form .req{color:var(--req)}
.d365-form .rec{color:var(--brand)}
.d365-form .field.nolabel{display:block}
.d365-form .input{flex:1 1 0;min-width:0;max-width:calc(100% - 184px);min-height:var(--control-h);display:flex;align-items:center;
  justify-content:space-between;gap:2px;padding:5px 10px 5px 12px;background:var(--surface);border-radius:4px;
  border:1px solid transparent;color:var(--fg3)}
.d365-form .input:hover{border-bottom-color:var(--fg3)}
.d365-form .input.ro{background:transparent;padding-left:0;color:var(--fg1)}
.d365-form .input.ro:hover{border-bottom-color:transparent}
.d365-form .input.ro::after{content:"🔒";font-size:10px;opacity:.5;margin-left:auto}
.d365-form .ico{display:inline-flex;align-items:center;color:var(--fg3);flex:none}
.d365-form .ico svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
.d365-form .ph-text{color:var(--fg3)}
/* Two Options as a Fluent Switch: 40x20 pill, 1px #616161 border, 14px thumb, "No"/"Yes" label at 4px (real values) */
.d365-form .input.k-toggle{background:transparent;padding:0;border-color:transparent;justify-content:flex-start;gap:0}
.d365-form .input.k-toggle:hover{border-bottom-color:transparent}
.d365-form .sw{position:relative;flex:none;width:40px;height:20px;box-sizing:border-box;border:1px solid #616161;border-radius:10000px;margin-right:8px}
.d365-form .sw::after{content:"";position:absolute;left:3px;top:50%;width:14px;height:14px;margin-top:-7px;border-radius:50%;background:#616161}
.d365-form .sw-label{padding-left:4px;color:var(--fg1);font-size:14px;line-height:20px}
.d365-form .input.k-checkbox{background:transparent;padding:0;border-color:transparent;justify-content:flex-start}
.d365-form .cb{width:16px;height:16px;box-sizing:border-box;border:1px solid #616161;border-radius:2px;background:#fff}
/* date + time: two separate inputs side by side (date shown as a single input for Date Only) */
.d365-form .input.k-datetime{background:transparent;padding:0;border-color:transparent;gap:8px}
.d365-form .dt{display:flex;align-items:center;justify-content:space-between;min-height:var(--control-h);padding:5px 10px 5px 12px;
  background:var(--surface);border-radius:4px;border:1px solid transparent;min-width:0}
.d365-form .dt-date{flex:3 1 0}
.d365-form .dt-time{flex:2 1 0}
.d365-form .k-lookup .val{color:rgb(17,94,163)}
.d365-form .k-multiline{align-items:flex-start;min-height:52px;padding:6px 12px}
.d365-form .toggle{width:36px;height:18px;border-radius:9px;border:1px solid #8a8886;position:relative;background:#fff}
.d365-form .toggle::after{content:"";position:absolute;left:3px;top:3px;width:10px;height:10px;border-radius:50%;background:#8a8886}

/* placeholders (subgrid, notes, quick view, ...) span the full row */
.d365-form .ph{width:100%;min-height:calc(var(--control-h)*4);border:1px dashed #c8c6c4;border-radius:4px;
  background:#fcfcfc;padding:8px 12px;color:var(--fg3)}
.d365-form .ph-title{font-weight:600;color:var(--fg1)}
.d365-form .ph-detail{font-size:12px;margin-bottom:6px}
.d365-form .ph-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;border-top:1.5px solid #efefef;padding:6px 0}
.d365-form .ph-grid div{height:10px;background:#efefef;border-radius:2px}
.d365-form .field.nolabel>.ph{width:100%;max-width:none}

/* subgrid (AG Grid theme-balham with Dynamics overrides) — values read from a live Managers subgrid:
   command bar 44px with 32px buttons, keyword filter 32px (1px #616161 border, 2px radius),
   header 43px / 14px 600 #242424, rows 42px / 14px, cell padding 11px, 44px checkbox column, light row dividers. */
.d365-form .field.nolabel>.sg{width:100%}
.d365-form .sg{background:#fff;width:100%;min-width:0}
.d365-form .sg-title{padding-top:4px;font-weight:600}
.d365-form .sg-cmd{display:flex;align-items:center;gap:4px;height:44px;background:#fff;color:var(--fg1);white-space:nowrap;overflow:hidden}
.d365-form .sg-btn{display:inline-flex;align-items:center;height:32px;padding:0 .857142rem;border-radius:4px;font-size:14px}
.d365-form .sg-btn:hover{background:#f5f5f5}
.d365-form .sg-search{margin-left:auto;display:inline-flex;align-items:center;justify-content:space-between;gap:8px;width:220px;max-width:40%;
  height:32px;padding:1px .285714rem;border:1px solid #616161;border-radius:2px;color:var(--fg3);font-size:14px}
.d365-form .sg-search .ico{margin-left:auto}
.d365-form .sg table{width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0}
.d365-form .sg th,.d365-form .sg td{text-align:left;padding:0 11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.d365-form .sg thead th{height:43px;font-weight:600;color:var(--fg1);background:#fff;padding:0 12px}
.d365-form .sg tbody td{height:42px;color:var(--fg3);border-bottom:1px solid rgba(189,195,199,.58)}
.d365-form .sg tbody tr:hover td{background:#ecf0f1}
.d365-form .sg .sg-chk{width:44px;padding:0}
.d365-form .sg-empty{height:calc(43px + 42px);border-bottom:1px solid rgba(189,195,199,.58)}
.d365-form .sg-meta{padding:6px 0 0;font-size:11px;color:var(--fg3);font-style:italic}
.d365-form .sg-note{margin-top:4px;padding:4px 8px;font-size:11px;color:#8a6d00;background:#fff8e1;border:1px solid #f2e0a0;border-radius:4px}
.d365-form .sg-note.sg-error{color:var(--req);background:#fbeceb;border-color:#e8b4b0;white-space:pre-wrap}
.d365-form .sg td.sg-msg{height:84px;text-align:center;color:var(--fg3);font-style:italic;white-space:normal}
.d365-form .sg tbody tr:hover td.sg-msg{background:transparent}
.d365-form .sg tbody td[title]{color:var(--fg1)}
.d365-form .sg-empty-rows{height:42px;border-bottom:1px solid rgba(189,195,199,.58)}

/* a selected record's values (read-only): text in the primary colour, lookups as links, empty values "---" */
.d365-form .form-title h1.rec{font-style:normal;color:var(--fg1)}
.d365-form .input.filled{color:var(--fg1)}
.d365-form .input.filled .val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d365-form .k-multiline.filled .val{white-space:pre-wrap;overflow-wrap:anywhere}
.d365-form .val.link,.d365-form .strip-val.link{color:#115ea3}
.d365-form .k-lookup .val.empty,.d365-form .val.empty{color:var(--fg3)}
.d365-form .sw.on{background:var(--brand);border-color:var(--brand)}
.d365-form .sw.on::after{left:auto;right:3px;background:#fff}
.d365-form .cb.on{background:var(--brand);border-color:var(--brand);position:relative}
.d365-form .cb.on::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid #fff;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}

/* quick view form: a read-only block of the related record's sections, no tab strip and no section cards */
.d365-form .qv{width:100%;min-width:0}
.d365-form .qv-title{padding-top:4px;font-weight:600}
.d365-form .qv .section{background:transparent;box-shadow:none;border:0;padding:0;margin:0}
.d365-form .qv-msg{padding-top:4px;font-size:12px;color:var(--fg3);font-style:italic}
${[2, 3, 4, 5, 6, 8, 10, 12, 15, 20].map(n => `.d365-form .rows-${n} .ph,.d365-form .rows-${n} .input{min-height:calc(var(--control-h)*${n})}`).join('\n')}
`;
