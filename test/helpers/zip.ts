// Shared by decompressRibbon.test.ts (unit-level), ribbonIntegration.test.ts (full pipeline), and
// solutionPackage.test.ts -- the real implementation now lives in src/ribbon/zip.ts (also used by
// production code to build Dataverse solution packages), so fixtures stay consistent with real
// payload shape without a second copy or an archive library dependency.
export { buildZip } from '../../src/ribbon/zip';
