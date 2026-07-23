// Bundles the React webview apps (src/webview, src/webview-ribbon) into out/webview/*.{js,css}.
// The VS Code extension host itself is still built by `tsc` — this only handles the
// browser-side webview bundles, which tsc can't produce (JSX + bundling).
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Emits the begin/end markers the VS Code background problem matcher in .vscode/tasks.json
// keys on, so the "Run Extension" launch waits for the first build before starting.
const watchLogPlugin = {
  name: 'watch-log',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd(result => {
      for (const e of result.errors) {
        const loc = e.location;
        // Format matches the problemMatcher in .vscode/tasks.json (file:line:col: message).
        console.error(loc ? `✘ ${loc.file}:${loc.line}:${loc.column}: ${e.text}` : `✘ :0:0: ${e.text}`);
      }
      console.log('[watch] build finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [
    { in: 'src/webview/index.tsx', out: 'entityExplorer' },
    { in: 'src/webview-ribbon/index.tsx', out: 'ribbonEditor' },
  ],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  outdir: 'out/webview',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  plugins: watch ? [watchLogPlugin] : [],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching webview…');
} else {
  await esbuild.build(options);
}
