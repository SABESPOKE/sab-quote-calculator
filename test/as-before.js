// Test helper (no tests of its own). The Cutlist change (test/cnc-cut.test.js) moved three things by design:
//   • the Cutlist cut on the board Cutlist supplies (DB.settings.cutlistCut),
//   • edging, no longer charged (EDGEBAND_TYPES rates are 0),
//   • end-panel / shelf / filler bench time (DB.settings.*BenchHrs, endPanelEdgeHrsPerM).
// asBefore(engine, baselineEngine, fn) runs fn with those three put back as they were, so a regression test can still
// say "everything else prices exactly as the baseline". Works for a sync or an async fn.
'use strict';
module.exports = function asBefore(E, OLD, fn) {
  const s = E.DB.settings;
  const keep = { cutlistCut: s.cutlistCut, endPanelBenchHrs: s.endPanelBenchHrs, endPanelEdgeHrsPerM: s.endPanelEdgeHrsPerM, shelfBenchHrs: s.shelfBenchHrs, fillerBenchHrs: s.fillerBenchHrs };
  const tapes = JSON.parse(JSON.stringify(E.EDGEBAND_TYPES));
  Object.assign(s, { cutlistCut: 0, endPanelBenchHrs: 0.5, endPanelEdgeHrsPerM: 0.04, shelfBenchHrs: 0.5, fillerBenchHrs: 0.2 });
  for (const k of Object.keys(tapes)) Object.assign(E.EDGEBAND_TYPES[k], OLD.EDGEBAND_TYPES[k]);
  const undo = () => { Object.assign(s, keep); for (const k of Object.keys(tapes)) Object.assign(E.EDGEBAND_TYPES[k], tapes[k]); };
  let r;
  try { r = fn(); } catch (e) { undo(); throw e; }
  return r && typeof r.then === 'function' ? r.finally(undo) : (undo(), r);
};
