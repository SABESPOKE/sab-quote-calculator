/**
 * Browser-side fitting time estimator for SAB Quote Calculator.
 *
 * Hours are TOTAL PERSON-HOURS (labour content).
 * labourDays = ceil2(totalPersonHours / 7.5)
 *
 * Multiply labourDays by the per-fitter installDayRate for total labour
 * cost. Crew size is irrelevant to cost — two fitters finish elapsed work
 * faster but bill the same total labour.
 *
 * Mirrors business-api/fitting-estimate.js — keep the two in sync.
 *
 * Exposes window.SAB_FITTING.calculateFittingEstimate(quote)
 */
(function (root) {
  'use strict';

  var FITTING_TIME_CONFIG = {
    cabinets: {
      base: {
        B_STD_1D:    { name: 'Base – 1 Door',              hours: 3.0 },
        B_STD_2D:    { name: 'Base – 2 Door',              hours: 3.0 },
        B_DRW_DOOR:  { name: 'Base – Door & Drawer',       hours: 4.0 },
        B_DRAWER3:   { name: '3-Drawer Stack',             hours: 4.0 },
        B_DRAWER4:   { name: '4-Drawer Stack',             hours: 5.0 },
        B_SINK:      { name: 'Sink Base',                  hours: 4.0 },
        B_CORNER_BL: { name: 'Corner Base – Blind',        hours: 5.0 },
        B_CORNER_CAR:{ name: 'Corner Base – Carousel',     hours: 6.0 },
        B_DW_HSG:    { name: 'Dishwasher Housing',         hours: 3.0 },
        B_DW_DOOR:   { name: 'Dishwasher Door Only',       hours: 1.0 },
        B_WM_HSG:    { name: 'Washing Machine Housing',    hours: 3.0 },
        B_BIN:       { name: 'Bin Pull-Out Cabinet',       hours: 4.0 },
        B_PULLOUT:   { name: 'Pull-Out Base Larder',       hours: 5.0 },
        B_WINE:      { name: 'Wine Rack Base',             hours: 3.0 },
        B_OPEN:      { name: 'Open Base Shelf Unit',       hours: 2.0 },
        B_WIDE:      { name: 'Wide Base Cabinet',          hours: 4.0 }
      },
      tall: {
        T_LARDER:    { name: 'Tall Larder Cabinet',        hours: 6.0 },
        T_LARDER_PO: { name: 'Tall Pull-Out Larder',       hours: 7.0 },
        T_OVEN_S:    { name: 'Single Oven Housing',        hours: 6.0 },
        T_OVEN_D:    { name: 'Double Oven Housing',        hours: 7.0 },
        T_OVEN_MW:   { name: 'Oven & Microwave Tower',     hours: 8.0 },
        T_FRIDGE:    { name: 'Fridge Housing',             hours: 6.0 },
        T_FF:        { name: 'Fridge-Freezer Housing',     hours: 7.0 },
        T_BROOM:     { name: 'Broom / Utility Cupboard',   hours: 6.0 },
        T_OPEN:      { name: 'Open Tall Shelf Unit',       hours: 4.0 },
        T_DRESSER:   { name: 'Dresser Cabinet',            hours: 6.0 },
        T_CORNER:    { name: 'Tall Corner Cabinet',        hours: 7.0 },
        T_STORE:     { name: 'Tall Storage Cabinet',       hours: 6.0 }
      },
      wall: {
        W_STD_1D:    { name: 'Wall – 1 Door',              hours: 2.0 },
        W_STD_2D:    { name: 'Wall – 2 Door',              hours: 2.0 },
        W_TALL_1D:   { name: 'Wall – 1 Door 900h',         hours: 3.0 },
        W_TALL_2D:   { name: 'Wall – 2 Door 900h',         hours: 3.0 },
        W_CORNER:    { name: 'Corner Wall Cabinet',        hours: 4.0 },
        W_GLASS:     { name: 'Wall – Glass Door',          hours: 3.0 },
        W_OPEN:      { name: 'Open Shelf Wall Unit',       hours: 1.5 },
        W_MW:        { name: 'Microwave Housing',          hours: 3.0 },
        W_ABOVE_FF:  { name: 'Above-Fridge Wall Unit',     hours: 2.0 },
        W_XTALL:     { name: 'Wall – Extra Tall 1060h',    hours: 3.0 }
      },
      island: {
        I_ISLAND:     { name: 'Island Base Cabinet',       hours: 8.0 },
        I_PENINSULA:  { name: 'Peninsula Cabinet',         hours: 7.0 },
        I_PLATE_RACK: { name: 'Plate Rack Unit',           hours: 4.0 }
      }
    },
    scribing: {
      SCRIBE_END_PANEL:  { name: 'End panel – scribed to wall',      hours: 2.0, matchKeywords: ['end panel', 'scribed panel', 'scribe panel'] },
      SCRIBE_WALL_PANEL: { name: 'Wall panelling – scribed section', hours: 3.0, matchKeywords: ['wall panel', 'wall panelling', 'panelling'] },
      SCRIBE_FILLER:     { name: 'Filler strip – scribed',           hours: 1.0, matchKeywords: ['filler', 'infill', 'scribe filler'] }
    },
    wardrobes: {
      W_SINGLE: { name: 'Single wardrobe (hinged, up to 600mm)', hours: 4.0 },
      W_DOUBLE: { name: 'Double wardrobe (hinged, 900–1200mm)', hours: 6.0 },
      W_LARGE:  { name: 'Large wardrobe (hinged, 1500mm+)',     hours: 7.0 },
      W_WALKIN: { name: 'Walk-in section (rail / shelf unit)',  hours: null }
    },
    hardware: {
      HW_FIT_RAIL:        { name: 'Hanging rail',                        hours: 0.5, matchKeywords: ['hanging rail', 'wardrobe rail', 'clothes rail'] },
      HW_FIT_DRAWER:      { name: 'Drawer box (runners, front, adjust)', hours: 1.0, matchKeywords: ['drawer box', 'internal drawer', 'wardrobe drawer'] },
      HW_FIT_SHOE:        { name: 'Pull-out shoe rack',                  hours: 1.0, matchKeywords: ['shoe rack', 'shoe pull-out', 'pull out shoe'] },
      HW_FIT_PULLOUT_ACC: { name: 'Pull-out trouser / accessory rack',   hours: 0.5, matchKeywords: ['trouser rack', 'accessory rack', 'pull-out rack', 'pull out rack', 'tie rack', 'belt rack'] },
      HW_FIT_SHELF:       { name: 'Fixed internal shelf',                hours: 0.3, matchKeywords: ['internal shelf', 'wardrobe shelf', 'fixed shelf'] }
    },
    overheads: {
      roomSetupHoursPerRoom: 3.0,
      cleanDownHoursPerDay: 1.0,
      hoursPerPersonPerDay: 7.5
    }
  };

  var CABINET_MATCH_KEYWORDS = [
    ['T_LARDER_PO',  ['pull-out larder', 'pull out larder', 'tall pull-out', 'wire basket']],
    ['T_OVEN_MW',    ['oven & microwave', 'oven and microwave', 'microwave tower']],
    ['T_OVEN_D',     ['double oven housing', 'double oven', 'tall double oven']],
    ['T_OVEN_S',     ['single oven housing', 'single oven']],
    ['T_FF',         ['fridge-freezer', 'fridge freezer']],
    ['T_FRIDGE',     ['fridge housing', 'integrated fridge', 'freezer housing', 'integrated freezer']],
    ['T_LARDER',     ['tall larder', 'larder cabinet', 'pantry larder']],
    ['T_BROOM',      ['broom cupboard', 'utility cupboard']],
    ['T_DRESSER',    ['dresser cabinet', 'dresser shelf', 'open dresser']],
    ['T_CORNER',     ['tall corner']],
    ['T_OPEN',       ['open tall shelf', 'open tall', 'open pantry shelf']],
    ['T_STORE',      ['tall storage', 'pantry doors', 'pantry cabinet']],
    ['I_PLATE_RACK', ['plate rack']],
    ['I_PENINSULA',  ['peninsula', 'peninsular']],
    ['I_ISLAND',     ['island base', 'island cabinet', 'island pan']],
    ['W_XTALL',      ['extra tall', '1060h']],
    ['W_TALL_2D',    ['wall – 2 door 900', 'wall - 2 door 900']],
    ['W_TALL_1D',    ['wall – 1 door 900', 'wall - 1 door 900']],
    ['W_GLASS',      ['glass door', 'wall – glass', 'wall - glass']],
    ['W_CORNER',     ['corner wall']],
    ['W_OPEN',       ['open shelf wall', 'open wall shelf']],
    ['W_MW',         ['microwave housing']],
    ['W_ABOVE_FF',   ['above-fridge', 'above fridge']],
    ['W_STD_2D',     ['wall – 2 door', 'wall - 2 door', 'wall 2 door']],
    ['W_STD_1D',     ['wall – 1 door', 'wall - 1 door', 'wall 1 door']],
    ['B_DW_DOOR',    ['dishwasher door', 'dishwasher – door', 'dishwasher - door']],
    ['B_DW_HSG',     ['dishwasher housing']],
    ['B_WM_HSG',     ['washing machine']],
    ['B_BIN',        ['bin pull-out', 'pull-out bin', 'pull out bin', 'bin cabinet', 'bin pullout']],
    ['B_CORNER_CAR', ['carousel', 'magic corner']],
    ['B_CORNER_BL',  ['corner base – blind', 'corner base - blind', 'blind corner']],
    ['B_PULLOUT',    ['pull-out base larder', 'pull out base larder']],
    ['B_DRAWER4',    ['4-drawer', '4 drawer', 'four drawer']],
    ['B_DRAWER3',    ['3-drawer', '3 drawer', 'three drawer', 'pan drawer', 'drawer stack', '2-drawer', '2 drawer']],
    ['B_DRW_DOOR',   ['door & drawer', 'door and drawer', 'drawer & door']],
    ['B_SINK',       ['sink base', 'sink unit']],
    ['B_WINE',       ['wine rack']],
    ['B_OPEN',       ['open base shelf', 'open shelf unit', 'open base']],
    ['B_STD_2D',     ['base – 2 door', 'base - 2 door', 'double door cupboard', '2-door cupboard']],
    ['B_STD_1D',     ['base – 1 door', 'base - 1 door', 'single door cupboard', '1-door cupboard', 'single door']],
    ['B_WIDE',       ['wide base']]
  ];

  var EXTRA_SCRIBING_KEYWORDS = {
    SCRIBE_END_PANEL: ['pillaster', 'pilaster', 'rear panel', 'side panel']
  };

  function normalise(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‐-―]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function ceilToHalf(n) { return Math.ceil(n * 2) / 2; }
  function round2(n) { return Math.round(n * 100) / 100; }

  var CABINET_LOOKUP = {};
  Object.keys(FITTING_TIME_CONFIG.cabinets).forEach(function (group) {
    var table = FITTING_TIME_CONFIG.cabinets[group];
    Object.keys(table).forEach(function (code) {
      CABINET_LOOKUP[code] = Object.assign({ group: group }, table[code]);
    });
  });

  var WARDROBE_LOOKUP = {};
  Object.keys(FITTING_TIME_CONFIG.wardrobes).forEach(function (code) {
    WARDROBE_LOOKUP[code] = FITTING_TIME_CONFIG.wardrobes[code];
  });

  function buildKeywordIndex(table, extras) {
    var idx = [];
    Object.keys(table).forEach(function (key) {
      var entry = table[key];
      var extra = (extras && extras[key]) || [];
      var keywords = (entry.matchKeywords || []).concat(extra);
      keywords.forEach(function (kw) {
        idx.push({ key: key, hours: entry.hours, name: entry.name, kw: normalise(kw) });
      });
    });
    idx.sort(function (a, b) { return b.kw.length - a.kw.length; });
    return idx;
  }

  var SCRIBING_INDEX = buildKeywordIndex(FITTING_TIME_CONFIG.scribing, EXTRA_SCRIBING_KEYWORDS);
  var HARDWARE_INDEX = buildKeywordIndex(FITTING_TIME_CONFIG.hardware, null);

  var CABINET_KEYWORD_INDEX = (function () {
    var idx = [];
    CABINET_MATCH_KEYWORDS.forEach(function (pair) {
      var code = pair[0];
      var keywords = pair[1];
      var cab = CABINET_LOOKUP[code];
      if (!cab) return;
      keywords.forEach(function (kw) {
        idx.push({ key: code, hours: cab.hours, name: cab.name, kw: normalise(kw) });
      });
    });
    idx.sort(function (a, b) { return b.kw.length - a.kw.length; });
    return idx;
  })();

  function findStructuredKey(item) {
    return item.cabinetTypeKey || (item.params && item.params.cabinetTypeKey) || null;
  }

  function findKeywordMatch(desc, index) {
    for (var i = 0; i < index.length; i++) {
      if (desc.indexOf(index[i].kw) !== -1) return index[i];
    }
    return null;
  }

  function matchItem(item) {
    var desc = normalise(item.description);
    var key = findStructuredKey(item);
    if (key && WARDROBE_LOOKUP[key]) {
      return { category: 'wardrobe', key: key, name: WARDROBE_LOOKUP[key].name, hours: WARDROBE_LOOKUP[key].hours };
    }
    if (key && CABINET_LOOKUP[key]) {
      return { category: 'cabinet', key: key, name: CABINET_LOOKUP[key].name, hours: CABINET_LOOKUP[key].hours };
    }
    var s = findKeywordMatch(desc, SCRIBING_INDEX);
    if (s) return { category: 'scribing', key: s.key, name: s.name, hours: s.hours };
    var h = findKeywordMatch(desc, HARDWARE_INDEX);
    if (h) return { category: 'hardware', key: h.key, name: h.name, hours: h.hours };
    var c = findKeywordMatch(desc, CABINET_KEYWORD_INDEX);
    if (c) return { category: 'cabinet', key: c.key, name: c.name, hours: c.hours };
    return null;
  }

  function calculateFittingEstimate(quote) {
    var hoursPerPersonPerDay = FITTING_TIME_CONFIG.overheads.hoursPerPersonPerDay;
    var roomSetupPersonHrs = FITTING_TIME_CONFIG.overheads.roomSetupHoursPerRoom;

    var rooms = (quote && quote.rooms) || {};
    var roomNames = Object.keys(rooms);
    var byRoom = {};
    var unresolved = [];
    var unmatched = [];
    var cabinetHours = 0, scribingHours = 0, hardwareHours = 0;

    roomNames.forEach(function (roomName) {
      var room = rooms[roomName] || {};
      var items = Array.isArray(room.items) ? room.items : [];
      var roomEntry = {
        cabinetHours: 0, scribingHours: 0, hardwareHours: 0,
        setupHours: roomSetupPersonHrs,
        items: []
      };

      items.forEach(function (item) {
        var qty = Number(item.qty) || 0;
        if (qty <= 0) return;
        var description = item.description || '';
        var match = matchItem(item);
        if (!match) { unmatched.push({ room: roomName, description: description, qty: qty }); return; }
        if (match.hours == null) {
          unresolved.push({ room: roomName, description: description, qty: qty, matchedAs: match.key, reason: match.name + ' — fitting time TBC' });
          return;
        }
        var totalHours = qty * match.hours;
        roomEntry.items.push({
          description: description, qty: qty, hoursPerUnit: match.hours,
          totalHours: round2(totalHours), matchedAs: match.key, category: match.category
        });
        if (match.category === 'scribing') { roomEntry.scribingHours += totalHours; scribingHours += totalHours; }
        else if (match.category === 'hardware') { roomEntry.hardwareHours += totalHours; hardwareHours += totalHours; }
        else { roomEntry.cabinetHours += totalHours; cabinetHours += totalHours; }

        // ── Filler scribing — applies to cabinets that carry a fillerCount field ──
        // Each filler adds one SCRIBE_FILLER worth of on-site labour per cabinet.
        var fillerCount = Number(item.fillerCount || (item.params && item.params.fillerCount)) || 0;
        var totalFillers = fillerCount * qty;
        if (totalFillers > 0) {
          var fillerEntry = FITTING_TIME_CONFIG.scribing.SCRIBE_FILLER;
          var fillerHours = totalFillers * fillerEntry.hours;
          roomEntry.items.push({
            description: '↳ ' + fillerCount + ' filler' + (fillerCount === 1 ? '' : 's') + ' on ' + (description || 'cabinet'),
            qty: totalFillers,
            hoursPerUnit: fillerEntry.hours,
            totalHours: round2(fillerHours),
            matchedAs: 'SCRIBE_FILLER',
            category: 'scribing'
          });
          roomEntry.scribingHours += fillerHours;
          scribingHours += fillerHours;
        }
      });

      roomEntry.cabinetHours = round2(roomEntry.cabinetHours);
      roomEntry.scribingHours = round2(roomEntry.scribingHours);
      roomEntry.hardwareHours = round2(roomEntry.hardwareHours);
      byRoom[roomName] = roomEntry;
    });

    var roomSetupHours = roomNames.length * roomSetupPersonHrs;
    var totalPersonHours = cabinetHours + scribingHours + hardwareHours + roomSetupHours;
    var rawDays = hoursPerPersonPerDay > 0 ? totalPersonHours / hoursPerPersonPerDay : 0;

    return {
      estimatedDays: ceilToHalf(rawDays),
      rawDays: round2(rawDays),
      totalPersonHours: round2(totalPersonHours),
      hoursPerPersonPerDay: hoursPerPersonPerDay,
      breakdown: {
        cabinetHours: round2(cabinetHours),
        scribingHours: round2(scribingHours),
        hardwareHours: round2(hardwareHours),
        roomSetupHours: round2(roomSetupHours)
      },
      byRoom: byRoom,
      unresolved: unresolved,
      unmatched: unmatched
    };
  }

  root.SAB_FITTING = { calculateFittingEstimate: calculateFittingEstimate, FITTING_TIME_CONFIG: FITTING_TIME_CONFIG };
})(typeof window !== 'undefined' ? window : globalThis);
