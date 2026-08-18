/*
 * PsychPlotter — app controller.
 *
 * Canonical (unit-independent) state:
 *   pressurePa  barometric pressure in Pa (the single source of truth;
 *               elevation and the pressure field are both derived from it)
 * Per point:
 *   tdbC        dry-bulb temperature in °C
 *   w           humidity ratio in kg/kg (== lb/lb; a dimensionless mass ratio)
 *   pressurePa  pressure at which the point was defined, in Pa
 * Everything shown to the user is derived from these at display time, so the
 * IP/SI toggle never mutates the underlying physics.
 */
(function () {
  'use strict';

  var IP = 'IP', SI = 'SI';
  var STORAGE_KEY = 'psychplotter.v1';
  var PA_PER_PSI = 6894.757293168;
  var P0 = 101325;            // standard sea-level pressure, Pa
  var ATM_K = 2.25577e-5, ATM_E = 5.2559; // standard-atmosphere constants
  var M3S_PER_CFM = 0.0004719474;         // ft³/min -> m³/s
  var W_PER_BTUH = 0.29307107;            // Btu/h -> W  (1/3.412142)

  var state = {
    unit: IP,
    pressurePa: P0,
    theme: 'light',
    themeExplicit: false,   // becomes true only when the user picks a theme
    show: {
      dryBulbAxis: true, humidityAxis: true, rh: true, wetbulb: true,
      enthalpy: false, dewpoint: false, grid: false
    },
    points: [],
    nextId: 1,
    processes: [],       // {id, name, pointIds:[], closed, paths:{segIndex:type}}
    nextProcessId: 1,
    weather: null,       // {name, count, points:[{tdbC,w}]} — session only, not persisted
    activeTab: 'points', // which tab's data the chart shows ('points' | 'import')
    zones: { comfort: false, dcRec: false, dcA1: false, dcA2: false } // overlay toggles (EPW tab)
  };

  var stagingIds = [];   // point ids being assembled into a new process
  var PATH_TYPES = ['straight', 'saturation', 'wetbulb', 'enthalpy'];
  var PATH_LABELS = {
    straight: 'Straight', saturation: 'Along saturation',
    wetbulb: 'Along wet-bulb', enthalpy: 'Along enthalpy'
  };

  // ---- unit helpers -------------------------------------------------------
  function cToF(c) { return c * 9 / 5 + 32; }
  function fToC(f) { return (f - 32) * 5 / 9; }
  function ftToM(ft) { return ft * 0.3048; }
  function mToFt(m) { return m / 0.3048; }

  function setPsyUnit(unit) {
    psychrolib.SetUnitSystem(unit === IP ? psychrolib.IP : psychrolib.SI);
  }

  // Pressure (Pa) at a given elevation in metres, via the standard atmosphere.
  function pressurePaFromElevationM(elevM) {
    psychrolib.SetUnitSystem(psychrolib.SI); // SI gives a clean Pa result
    return psychrolib.GetStandardAtmPressure(elevM);
  }
  // Inverse of the standard-atmosphere formula: elevation (m) for a pressure (Pa).
  function elevMFromPressurePa(pa) {
    return (1 - Math.pow(pa / P0, 1 / ATM_E)) / ATM_K;
  }

  // Pressure in the units psychrolib expects for a system: psi [IP] or Pa [SI].
  function pressureInUnit(pa, unit) {
    return unit === IP ? pa / PA_PER_PSI : pa;
  }

  // ---- derived properties for display ------------------------------------
  function derive(point, unit) {
    setPsyUnit(unit);
    var tdb = unit === IP ? cToF(point.tdbC) : point.tdbC;
    var P = pressureInUnit(point.pressurePa, unit);
    var w = point.w;
    return {
      tdb: tdb,
      w: w,
      rh: psychrolib.GetRelHumFromHumRatio(tdb, w, P) * 100,
      twb: psychrolib.GetTWetBulbFromHumRatio(tdb, w, P),
      tdp: psychrolib.GetTDewPointFromHumRatio(tdb, w, P),
      h: psychrolib.GetMoistAirEnthalpy(tdb, w),
      v: psychrolib.GetMoistAirVolume(tdb, w, P)
    };
  }

  // ---- unit-dependent labels ----------------------------------------------
  var UNITS = {
    IP: { temp: '°F', elev: 'ft', press: 'psia', w: 'lb/lb', h: 'Btu/lb', v: 'ft³/lb' },
    SI: { temp: '°C', elev: 'm', press: 'kPa', w: 'g/kg', h: 'kJ/kg', v: 'm³/kg' }
  };

  function wDisplay(w, unit) {
    return unit === IP ? w.toFixed(4) : (w * 1000).toFixed(1);
  }
  function hDisplay(h, unit) {
    return unit === IP ? h.toFixed(1) : (h / 1000).toFixed(1); // SI is J/kg -> kJ/kg
  }

  // ---- DOM refs -----------------------------------------------------------
  var el = {};
  function grab() {
    ['unit-ip', 'unit-si', 'theme-dark', 'theme-light',
     'elevation', 'elevation-unit', 'pressure', 'pressure-unit',
     'point-form', 'pt-label', 'pt-tdb', 'pt-prop2', 'pt-prop2val',
     'lbl-tdb-unit', 'lbl-prop2-name', 'lbl-prop2-unit', 'form-error',
     'points-table-wrap', 'clear-all', 'chart-container',
     'opt-tdb-axis', 'opt-w-axis', 'opt-rh', 'opt-wb', 'opt-enth', 'opt-dp', 'opt-grid',
     'proc-name', 'proc-add-point', 'proc-staging', 'proc-closed', 'proc-add',
     'proc-clear-staging', 'proc-error', 'processes-wrap',
     'epw-input', 'epw-status', 'epw-clear',
     'export-png', 'export-pdf', 'proj-export', 'proj-import-btn', 'proj-import', 'proj-status',
     'mix-a', 'mix-b', 'mix-a-flow', 'mix-b-flow', 'mix-label', 'mix-add', 'mix-error',
     'shr-from', 'shr-value', 'shr-tdb', 'shr-tdb-unit', 'shr-label', 'shr-add', 'shr-error',
     'zone-comfort', 'zone-dc-rec', 'zone-dc-a1', 'zone-dc-a2', 'zone-stats'
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  var PROP2_META = {
    rh:  { name: 'Relative humidity', unit: '%', needsTemp: false },
    twb: { name: 'Wet-bulb temperature', unit: 'TEMP', needsTemp: true },
    tdp: { name: 'Dew-point temperature', unit: 'TEMP', needsTemp: true }
  };

  // ---- rendering ----------------------------------------------------------
  function refreshUnitLabels() {
    var u = UNITS[state.unit];
    el['lbl-tdb-unit'].textContent = '(' + u.temp + ')';
    el['elevation-unit'].textContent = u.elev;
    el['pressure-unit'].textContent = u.press;
    var meta = PROP2_META[el['pt-prop2'].value];
    el['lbl-prop2-name'].textContent = meta.name + ' ';
    el['lbl-prop2-unit'].textContent = '(' + (meta.unit === 'TEMP' ? u.temp : meta.unit) + ')';
    el['pt-tdb'].placeholder = state.unit === IP ? '75' : '24';
    var flowUnit = state.unit === IP ? 'CFM' : 'L/s';
    Array.prototype.forEach.call(document.querySelectorAll('.mix-unit'), function (sp) { sp.textContent = flowUnit; });
    el['shr-tdb-unit'].textContent = '(' + u.temp + ')';
  }

  // Populate both the elevation and pressure fields from canonical pressurePa.
  function refreshPressureFields() {
    var pa = state.pressurePa;
    var elevM = elevMFromPressurePa(pa);
    el['elevation'].value = Math.round(state.unit === IP ? mToFt(elevM) : elevM);
    el['pressure'].value = state.unit === IP
      ? (pa / PA_PER_PSI).toFixed(3)
      : (pa / 1000).toFixed(2);
  }

  function renderChart() {
    // Points/processes and weather are kept on separate tabs; the chart shows
    // only the active tab's data (the reference lines are always drawn).
    var onPoints = state.activeTab === 'points';
    var onImport = state.activeTab === 'import';
    var pts = onPoints ? state.points.map(function (p) {
      var d = derive(p, state.unit);
      return { id: p.id, label: p.label, tdb: d.tdb, w: d.w };
    }) : [];
    PsychChart.render(el['chart-container'], {
      unitSystem: state.unit,
      pressure: pressureInUnit(state.pressurePa, state.unit),
      points: pts,
      processes: onPoints ? resolvedProcessesForChart() : [],
      weather: (onImport && state.weather) ? state.weather.points.map(function (p) {
        return { tdb: state.unit === IP ? cToF(p.tdbC) : p.tdbC, w: p.w };
      }) : [],
      zones: onImport ? activeZones().map(function (z) {
        return { cls: z.cls, points: z.si.map(function (pt) {
          return { tdb: state.unit === IP ? cToF(pt.c) : pt.c, w: pt.w };
        }) };
      }) : [],
      show: state.show
    });
  }

  // ---- processes ----------------------------------------------------------
  function pointById(id) {
    for (var i = 0; i < state.points.length; i++) {
      if (state.points[i].id === id) return state.points[i];
    }
    return null;
  }
  function ptTdb(p) { return state.unit === IP ? cToF(p.tdbC) : p.tdbC; }
  function pointName(p) { return p.label ? ('P' + p.id + ' ' + p.label) : ('P' + p.id); }
  function pointShort(p) { return 'P' + p.id; }

  // Ordered segment descriptors for a process (handles the closing segment).
  function segmentsOf(proc) {
    var ids = proc.pointIds, n = ids.length;
    var count = proc.closed ? n : n - 1;
    var segs = [];
    for (var i = 0; i < count; i++) {
      segs.push({
        index: i, aId: ids[i], bId: ids[(i + 1) % n],
        path: (proc.paths && proc.paths[i]) || 'straight'
      });
    }
    return segs;
  }

  function resolvedProcessesForChart() {
    return state.processes.map(function (proc) {
      var segs = segmentsOf(proc).map(function (s) {
        var pa = pointById(s.aId), pb = pointById(s.bId);
        if (!pa || !pb) return null;
        return { a: { tdb: ptTdb(pa), w: pa.w }, b: { tdb: ptTdb(pb), w: pb.w }, path: s.path };
      }).filter(Boolean);
      return { name: proc.name, segments: segs };
    }).filter(function (p) { return p.segments.length; });
  }

  // Per-segment load breakdown. SHR needs no airflow; absolute loads (W) need it.
  // Sensible = enthalpy change from the temperature move at the entering W;
  // latent = the remaining enthalpy change from the humidity move. Loads use the
  // ACTUAL specific volume at the process's first point (correct at any altitude,
  // unlike the sea-level 1.08 / 0.68 / 4.5 rules of thumb).
  function segmentLoads(proc, s) {
    var pa = pointById(s.aId), pb = pointById(s.bId);
    if (!pa || !pb) return null;
    psychrolib.SetUnitSystem(psychrolib.SI);
    var ha = psychrolib.GetMoistAirEnthalpy(pa.tdbC, pa.w);   // J/kg dry air
    var hMid = psychrolib.GetMoistAirEnthalpy(pb.tdbC, pa.w); // temperature move at Wa
    var hb = psychrolib.GetMoistAirEnthalpy(pb.tdbC, pb.w);
    var sensible = hMid - ha, latent = hb - hMid, total = hb - ha; // J/kg
    var res = { shr: total !== 0 ? sensible / total : null };
    if (proc.airflowM3s > 0) {
      var ref = pointById(proc.pointIds[0]) || pa;
      var v = psychrolib.GetMoistAirVolume(ref.tdbC, ref.w, ref.pressurePa); // m³/kg dry air
      var mda = proc.airflowM3s / v;                                          // kg dry air / s
      res.sensibleW = mda * sensible;
      res.latentW = mda * latent;
      res.totalW = mda * total;
    }
    return res;
  }

  function fmtLoad(watts) {
    return state.unit === IP
      ? Math.round(watts / W_PER_BTUH).toLocaleString() + ' Btu/h'
      : (watts / 1000).toFixed(2) + ' kW';
  }

  // Apparatus dew point + bypass factor for a cooling segment. The ADP is where
  // the straight entering->leaving line, extended, meets the saturation curve;
  // the bypass factor is the fraction of air that "misses" the coil surface.
  // Returns { adpTdb (current unit), bf } or null when it doesn't apply.
  function coilADP(s) {
    var pa = pointById(s.aId), pb = pointById(s.bId);
    if (!pa || !pb) return null;
    if (pb.tdbC >= pa.tdbC - 1e-6) return null;   // must be cooling
    if (pb.w > pa.w + 1e-9) return null;          // must not be humidifying
    psychrolib.SetUnitSystem(psychrolib.SI);
    var P = pa.pressurePa;
    var Ta = pa.tdbC, Wa = pa.w, Tb = pb.tdbC;
    var slope = (Wa - pb.w) / (Ta - Tb);          // dW/dT along the process line
    function f(T) { return (Wa + slope * (T - Ta)) - psychrolib.GetSatHumRatio(T, P); }
    // A chord can cross the convex saturation curve twice; the ADP is the FIRST
    // (upper) crossing below the leaving temp. Scan down from Tb until f turns +.
    if (f(Tb) > 1e-9) return null;                 // leaving state already supersaturated
    var step = 0.25, prev = Tb, prevF = f(Tb), adpC = null;
    for (var T = Tb - step; T > Tb - 40; T -= step) {
      var cur = f(T);
      if (prevF <= 0 && cur > 0) {                 // crossing between T and prev
        var lo = T, hi = prev;                     // f(lo) > 0, f(hi) <= 0
        for (var i = 0; i < 60; i++) {
          var mid = (lo + hi) / 2;
          if (f(mid) > 0) lo = mid; else hi = mid;
        }
        adpC = (lo + hi) / 2;
        break;
      }
      prev = T; prevF = cur;
    }
    if (adpC === null) return null;
    var bf = (Tb - adpC) / (Ta - adpC);            // dry-bulb bypass factor
    if (!(bf >= 0) || bf > 1) return null;
    return { adpTdb: state.unit === IP ? cToF(adpC) : adpC, bf: bf };
  }

  function airflowToDisplay(m3s) {
    if (!(m3s > 0)) return '';
    return state.unit === IP ? Math.round(m3s / M3S_PER_CFM) : Math.round(m3s * 1000);
  }
  function airflowFromDisplay(v) {
    return state.unit === IP ? v * M3S_PER_CFM : v / 1000;
  }

  // ---- overlay zones (#19): comfort + datacenter envelopes -----------------
  // Each zone is a polygon in (°C, humidity ratio) built at the chart pressure.
  function zoneEnvelope(P, tMin, tMax, lowerRH, lowerDP, upperRH, upperDP) {
    psychrolib.SetUnitSystem(psychrolib.SI);
    var wLoDP = lowerDP != null ? psychrolib.GetSatHumRatio(lowerDP, P) : 0;
    var wUpDP = upperDP != null ? psychrolib.GetSatHumRatio(upperDP, P) : Infinity;
    var bot = [], top = [];
    for (var T = tMin; T <= tMax + 1e-6; T += 0.5) {
      var lo = Math.max(lowerRH != null ? psychrolib.GetHumRatioFromRelHum(T, lowerRH, P) : 0, wLoDP);
      var up = Math.min(upperRH != null ? psychrolib.GetHumRatioFromRelHum(T, upperRH, P) : Infinity, wUpDP);
      bot.push({ c: T, w: lo }); top.push({ c: T, w: up });
    }
    return bot.concat(top.reverse());   // closed polygon: lower edge then upper edge back
  }
  var ZONE_DEFS = {
    // Legend/stats order; drawn back-to-front so the smaller envelopes stay visible.
    comfort: { name: 'Comfort (ASHRAE 55, approx.)', cls: 'zone-comfort',
      build: function () { return [{ c: 20, w: 0.004 }, { c: 26.5, w: 0.004 }, { c: 25, w: 0.012 }, { c: 18.5, w: 0.012 }]; } },
    dcRec: { name: 'Datacenter — recommended', cls: 'zone-dc-rec',
      build: function (P) { return zoneEnvelope(P, 18, 27, null, 5.5, 0.6, 15); } },
    dcA1: { name: 'Datacenter — allowable A1', cls: 'zone-dc-a1',
      build: function (P) { return zoneEnvelope(P, 15, 32, 0.08, -12, 0.8, 17); } },
    dcA2: { name: 'Datacenter — allowable A2', cls: 'zone-dc-a2',
      build: function (P) { return zoneEnvelope(P, 10, 35, 0.08, -12, 0.8, 21); } }
  };
  function activeZones() {
    var P = state.pressurePa;
    return Object.keys(ZONE_DEFS).filter(function (k) { return state.zones[k]; }).map(function (k) {
      return { key: k, name: ZONE_DEFS[k].name, cls: ZONE_DEFS[k].cls, si: ZONE_DEFS[k].build(P) };
    });
  }
  function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].c, yi = poly[i].w, xj = poly[j].c, yj = poly[j].w;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function renderZones() {
    if (!el['zone-stats']) return;
    if (!state.weather) { el['zone-stats'].innerHTML = ''; return; }
    var zones = activeZones();
    if (!zones.length) { el['zone-stats'].innerHTML = ''; return; }
    var total = state.weather.points.length;
    el['zone-stats'].innerHTML = zones.map(function (z) {
      var inside = 0;
      state.weather.points.forEach(function (p) { if (pointInPolygon(p.tdbC, p.w, z.si)) inside++; });
      return '<div class="zone-stat"><span class="zone-swatch ' + z.cls + '"></span>' +
        escapeHtml(z.name) + ' — <strong>' + (inside / total * 100).toFixed(0) + '%</strong> (' +
        inside.toLocaleString() + ' h)</div>';
    }).join('');
  }

  function pointOptionsHtml() {
    var opts = ['<option value="">Select…</option>'];
    state.points.forEach(function (p) {
      opts.push('<option value="' + p.id + '">' + escapeHtml(pointName(p)) + '</option>');
    });
    return opts.join('');
  }

  // ---- mixing (#7): blend two airstreams by dry-air mass into a new point ----
  function renderMixBuilder() {
    var aSel = el['mix-a'].value, bSel = el['mix-b'].value;
    el['mix-a'].innerHTML = pointOptionsHtml();
    el['mix-b'].innerHTML = pointOptionsHtml();
    el['mix-a'].value = aSel; el['mix-b'].value = bSel;
    var few = state.points.length < 2;
    el['mix-a'].disabled = el['mix-b'].disabled = few;
    updateMixButton();
  }
  function updateMixButton() {
    var a = parseInt(el['mix-a'].value, 10), b = parseInt(el['mix-b'].value, 10);
    var fa = parseFloat(el['mix-a-flow'].value), fb = parseFloat(el['mix-b-flow'].value);
    el['mix-add'].disabled = !(a && b && a !== b && fa > 0 && fb > 0);
  }
  function addMixedPoint() {
    el['mix-error'].textContent = '';
    var pa = pointById(parseInt(el['mix-a'].value, 10));
    var pb = pointById(parseInt(el['mix-b'].value, 10));
    var fa = parseFloat(el['mix-a-flow'].value), fb = parseFloat(el['mix-b-flow'].value);
    if (!pa || !pb || pa === pb || !(fa > 0) || !(fb > 0)) {
      el['mix-error'].textContent = 'Pick two different points and positive flows.'; return;
    }
    psychrolib.SetUnitSystem(psychrolib.SI);
    var mda = airflowFromDisplay(fa) / psychrolib.GetMoistAirVolume(pa.tdbC, pa.w, pa.pressurePa);
    var mdb = airflowFromDisplay(fb) / psychrolib.GetMoistAirVolume(pb.tdbC, pb.w, pb.pressurePa);
    var tot = mda + mdb;
    var Wmix = (mda * pa.w + mdb * pb.w) / tot;
    var hmix = (mda * psychrolib.GetMoistAirEnthalpy(pa.tdbC, pa.w) +
                mdb * psychrolib.GetMoistAirEnthalpy(pb.tdbC, pb.w)) / tot;
    var Tmix = psychrolib.GetTDryBulbFromEnthalpyAndHumRatio(hmix, Wmix);
    state.points.push({ id: state.nextId++, label: el['mix-label'].value.trim(),
      tdbC: Tmix, w: Wmix, pressurePa: pa.pressurePa });
    el['mix-a-flow'].value = ''; el['mix-b-flow'].value = ''; el['mix-label'].value = '';
    save(); renderAll();
  }

  // ---- SHR line (#8): from a point at a target SHR to a supply dry-bulb ----
  function renderShrBuilder() {
    var sel = el['shr-from'].value;
    el['shr-from'].innerHTML = pointOptionsHtml();
    el['shr-from'].value = sel;
    el['shr-from'].disabled = state.points.length < 1;
    updateShrButton();
  }
  function updateShrButton() {
    var from = parseInt(el['shr-from'].value, 10);
    el['shr-add'].disabled = !(from && isFinite(parseFloat(el['shr-value'].value)) &&
      isFinite(parseFloat(el['shr-tdb'].value)));
  }
  function addShrProcess() {
    el['shr-error'].textContent = '';
    var pa = pointById(parseInt(el['shr-from'].value, 10));
    var shr = parseFloat(el['shr-value'].value);
    var TbDisp = parseFloat(el['shr-tdb'].value);
    if (!pa || !(shr > 0) || shr > 1 || !isFinite(TbDisp)) {
      el['shr-error'].textContent = 'Enter an SHR in 0–1 and a supply dry-bulb.'; return;
    }
    psychrolib.SetUnitSystem(psychrolib.SI);
    var Ta = pa.tdbC, Wa = pa.w, Tb = state.unit === IP ? fToC(TbDisp) : TbDisp;
    var hTbWa = psychrolib.GetMoistAirEnthalpy(Tb, Wa);
    var sensible = hTbWa - psychrolib.GetMoistAirEnthalpy(Ta, Wa);
    if (Math.abs(sensible) < 1e-6) {
      el['shr-error'].textContent = 'Supply dry-bulb must differ from the start point.'; return;
    }
    var latent = sensible / shr - sensible;                    // total = sensible/shr
    var a0 = psychrolib.GetMoistAirEnthalpy(Tb, 0), b0 = psychrolib.GetMoistAirEnthalpy(Tb, 1) - a0;
    var Wb = (hTbWa + latent - a0) / b0;
    if (!(Wb >= 0) || !isFinite(Wb)) { el['shr-error'].textContent = 'That SHR/supply gives an invalid state.'; return; }
    if (Wb > psychrolib.GetSatHumRatio(Tb, pa.pressurePa) + 1e-9) {
      el['shr-error'].textContent = 'That target is above saturation (100% RH).'; return;
    }
    var endId = state.nextId++;
    var lbl = el['shr-label'].value.trim();
    state.points.push({ id: endId, label: lbl, tdbC: Tb, w: Wb, pressurePa: pa.pressurePa });
    state.processes.push({ id: state.nextProcessId++, name: lbl || ('SHR ' + shr),
      pointIds: [pa.id, endId], closed: false, paths: {} });
    el['shr-value'].value = ''; el['shr-tdb'].value = ''; el['shr-label'].value = '';
    save(); renderAll();
  }

  function renderProcessBuilder() {
    // point picker
    var opts = ['<option value="">Add point…</option>'];
    state.points.forEach(function (p) {
      opts.push('<option value="' + p.id + '">' + escapeHtml(pointName(p)) + '</option>');
    });
    el['proc-add-point'].innerHTML = opts.join('');
    el['proc-add-point'].disabled = state.points.length === 0;

    // staging sequence
    if (stagingIds.length === 0) {
      el['proc-staging'].innerHTML = '<span class="hint">No points added yet.</span>';
    } else {
      var chips = stagingIds.map(function (id, i) {
        var p = pointById(id);
        var name = p ? escapeHtml(pointShort(p)) : ('#' + id);
        return (i > 0 ? '<span class="proc-sep">→</span>' : '') +
          '<span class="proc-chip">' + name +
          '<span class="x" data-idx="' + i + '" title="Remove">×</span></span>';
      }).join('');
      el['proc-staging'].innerHTML = chips;
      Array.prototype.forEach.call(el['proc-staging'].querySelectorAll('.x'), function (x) {
        x.addEventListener('click', function () {
          stagingIds.splice(parseInt(x.getAttribute('data-idx'), 10), 1);
          renderProcessBuilder();
        });
      });
    }
    el['proc-add'].disabled = stagingIds.length < 2;
  }

  function renderProcessList() {
    var wrap = el['processes-wrap'];
    if (state.processes.length === 0) {
      wrap.innerHTML = '<p class="hint">No processes yet.</p>';
      return;
    }
    var html = state.processes.map(function (proc) {
      var seq = proc.pointIds.map(function (id) {
        var p = pointById(id); return p ? escapeHtml(pointShort(p)) : ('#' + id);
      });
      if (proc.closed && seq.length) seq = seq.concat([seq[0]]);
      var title = proc.name ? escapeHtml(proc.name) : ('Process ' + proc.id);

      var segRows = segmentsOf(proc).map(function (s) {
        var pa = pointById(s.aId), pb = pointById(s.bId);
        var lbl = (pa ? pointShort(pa) : '?') + ' → ' + (pb ? pointShort(pb) : '?');
        var options = PATH_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (t === s.path ? ' selected' : '') + '>' + PATH_LABELS[t] + '</option>';
        }).join('');
        var loads = segmentLoads(proc, s), loadLine = '';
        if (loads) {
          var parts = ['SHR ' + (loads.shr !== null ? loads.shr.toFixed(2) : '—')];
          if (loads.totalW !== undefined) {
            parts.push('S ' + fmtLoad(loads.sensibleW));
            parts.push('L ' + fmtLoad(loads.latentW));
            var t = 'Total ' + fmtLoad(loads.totalW);
            if (state.unit === IP) t += ' (' + (Math.abs(loads.totalW) / W_PER_BTUH / 12000).toFixed(1) + ' ton)';
            parts.push(t);
          }
          var coil = coilADP(s);
          var adpHtml = coil
            ? '<div class="seg-loads"><span class="adp">ADP ' + coil.adpTdb.toFixed(1) + UNITS[state.unit].temp +
              ' · BF ' + coil.bf.toFixed(2) + '</span></div>'
            : '';
          loadLine = '<div class="seg-loads">' + parts.join(' · ') + '</div>' + adpHtml;
        }
        return '<div class="seg-row"><span class="seg-label">' + lbl + '</span>' +
          '<select data-proc="' + proc.id + '" data-seg="' + s.index + '">' + options + '</select></div>' + loadLine;
      }).join('');

      var airflowUnit = state.unit === IP ? 'CFM' : 'L/s';
      var airflowRow = '<div class="proc-airflow">Airflow ' +
        '<input type="number" class="airflow-input" data-proc="' + proc.id + '" min="0" step="any" placeholder="—" value="' + airflowToDisplay(proc.airflowM3s) + '" /> ' +
        airflowUnit + '</div>';

      return '<div class="proc-item">' +
        '<div class="proc-item-head">' +
          '<span class="proc-item-name"><span class="dot"></span>' + title + '</span>' +
          '<button class="row-del" data-proc="' + proc.id + '" title="Remove">×</button>' +
        '</div>' +
        '<div class="proc-seq hint">' + seq.join(' → ') + '</div>' +
        airflowRow +
        segRows +
      '</div>';
    }).join('');
    wrap.innerHTML = html;

    Array.prototype.forEach.call(wrap.querySelectorAll('.row-del'), function (b) {
      b.addEventListener('click', function () {
        var id = parseInt(b.getAttribute('data-proc'), 10);
        state.processes = state.processes.filter(function (p) { return p.id !== id; });
        save(); renderProcessList(); renderChart();
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('select[data-seg]'), function (sel) {
      sel.addEventListener('change', function () {
        var pid = parseInt(sel.getAttribute('data-proc'), 10);
        var idx = parseInt(sel.getAttribute('data-seg'), 10);
        var proc = state.processes.filter(function (p) { return p.id === pid; })[0];
        if (!proc) return;
        if (!proc.paths) proc.paths = {};
        proc.paths[idx] = sel.value;
        save(); renderChart();
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.airflow-input'), function (inp) {
      inp.addEventListener('change', function () {
        var pid = parseInt(inp.getAttribute('data-proc'), 10);
        var proc = state.processes.filter(function (p) { return p.id === pid; })[0];
        if (!proc) return;
        var v = parseFloat(inp.value);
        proc.airflowM3s = (isFinite(v) && v > 0) ? airflowFromDisplay(v) : null;
        save();
        renderProcessList();   // recompute the load lines
      });
    });
  }

  function addProcess() {
    el['proc-error'].textContent = '';
    if (stagingIds.length < 2) {
      el['proc-error'].textContent = 'Add at least two points to form a process.';
      return;
    }
    state.processes.push({
      id: state.nextProcessId++,
      name: el['proc-name'].value.trim(),
      pointIds: stagingIds.slice(),
      closed: el['proc-closed'].checked,
      paths: {}
    });
    stagingIds = [];
    el['proc-name'].value = '';
    el['proc-closed'].checked = false;
    save();
    renderProcessBuilder();
    renderProcessList();
    renderChart();
  }

  // Remove a point and any process references to it (paths reset on structural change).
  function removePoint(id) {
    state.points = state.points.filter(function (p) { return p.id !== id; });
    stagingIds = stagingIds.filter(function (sid) { return sid !== id; });
    state.processes = state.processes.map(function (proc) {
      if (proc.pointIds.indexOf(id) === -1) return proc;   // unaffected — keep its path types
      proc.pointIds = proc.pointIds.filter(function (pid) { return pid !== id; });
      proc.paths = {};   // segment indices shifted — reset this process's paths
      return proc;
    }).filter(function (proc) { return proc.pointIds.length >= 2; });
    save();
    renderAll();
  }

  // ---- EPW weather import (parsed locally; never uploaded, never persisted) ----
  // EPW = comma-delimited: 8 header lines, then 8760 hourly rows. Data columns:
  //   6 dry-bulb °C, 7 dew-point °C, 8 RH %, 9 station pressure Pa.
  function parseEPW(text, filename) {
    try {
      var lines = text.split(/\r?\n/);
      if (!lines.length || lines[0].slice(0, 8).toUpperCase() !== 'LOCATION') {
        setImportError('This doesn’t look like an EPW file (missing LOCATION header).');
        return;
      }
      var loc = lines[0].split(',');
      var city = (loc[1] || '').trim() || 'Weather file';

      // Compute every hour AND draw the chart at the site's own pressure (from the
      // LOCATION elevation, field 9), so humid high-altitude hours can't plot above
      // the 100% boundary — a state at RH<=100% never exceeds saturation at that
      // same pressure. This also auto-sets the chart's elevation to the site.
      psychrolib.SetUnitSystem(psychrolib.SI);
      var elevM = parseFloat(loc[9]);
      if (isFinite(elevM) && elevM > -500 && elevM < 6000) {
        state.pressurePa = psychrolib.GetStandardAtmPressure(elevM);
      }
      var P = state.pressurePa;

      var pts = [], skipped = 0;
      for (var i = 8; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var f = line.split(',');
        if (f.length < 10) continue;
        var tdb = parseFloat(f[6]), tdp = parseFloat(f[7]), rh = parseFloat(f[8]);
        if (!isFinite(tdb) || tdb <= -60 || tdb >= 70) { skipped++; continue; } // EPW missing = 99.9
        var w = null;
        try {
          if (isFinite(rh) && rh > 0 && rh <= 100) {
            w = psychrolib.GetHumRatioFromRelHum(tdb, rh / 100, P);
          } else if (isFinite(tdp) && tdp > -60 && tdp <= tdb) {
            w = psychrolib.GetHumRatioFromTDewPoint(tdp, P);
          }
        } catch (e) { w = null; }
        if (w !== null && isFinite(w) && w >= 0) pts.push({ tdbC: tdb, w: w });
        else skipped++;
      }

      if (!pts.length) { setImportError('No valid hourly data found in this file.'); return; }
      state.weather = { name: city, count: pts.length, points: pts };
      save();       // persist the pressure change
      renderAll();  // update the elevation/pressure fields + chart consistently
    } catch (e) {
      setImportError('Could not read this file.');
    }
  }

  function renderImport() {
    if (state.weather) {
      el['epw-status'].innerHTML = '<div class="epw-loaded"><span class="dot"></span>' +
        '<strong>' + escapeHtml(state.weather.name) + '</strong> — ' +
        state.weather.count.toLocaleString() + ' hours plotted</div>';
      el['epw-clear'].hidden = false;
    } else {
      el['epw-status'].innerHTML = '';
      el['epw-clear'].hidden = true;
    }
  }
  function setImportError(msg) {
    el['epw-status'].innerHTML = '<div class="epw-error">' + escapeHtml(msg) + '</div>';
    el['epw-clear'].hidden = !state.weather;
  }

  // ---- chart image export (PNG / PDF) — works on any tab ------------------
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // The chart's colours come from CSS classes/variables, which don't travel
  // with a serialized SVG, so inline the computed styles onto a clone first.
  function inlineChartStyles(srcSvg, cloneSvg) {
    var props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity',
                 'font-size', 'font-family', 'font-weight', 'text-anchor', 'paint-order'];
    var wxColor = getComputedStyle(document.documentElement).getPropertyValue('--wx').trim();
    var procColor = getComputedStyle(document.documentElement).getPropertyValue('--proc').trim();
    var srcAll = srcSvg.querySelectorAll('*');
    var clAll = cloneSvg.querySelectorAll('*');
    for (var i = 0; i < srcAll.length && i < clAll.length; i++) {
      var s = srcAll[i], c = clAll[i];
      var cls = s.getAttribute('class') || '';
      // Weather dots (thousands) inherit fill from their group — style the group only.
      var parentCls = (s.parentNode && s.parentNode.getAttribute && s.parentNode.getAttribute('class')) || '';
      if (s.tagName.toLowerCase() === 'circle' && parentCls.indexOf('wx-layer') >= 0) continue;
      var cs = getComputedStyle(s);
      var decl = '';
      for (var j = 0; j < props.length; j++) {
        var v = cs.getPropertyValue(props[j]);
        if (v) decl += props[j] + ':' + v + ';';
      }
      if (cls.indexOf('wx-layer') >= 0) decl += 'fill:' + wxColor + ';';        // dots inherit this
      if (cls.indexOf('proc-arrow-head') >= 0) decl += 'fill:' + procColor + ';'; // marker in <defs>
      c.setAttribute('style', decl);
    }
  }

  function exportChartImage(type) {
    var srcSvg = el['chart-container'].querySelector('svg');
    if (!srcSvg) return;
    var vb = srcSvg.viewBox.baseVal;
    var scale = 2.5, w = Math.round(vb.width * scale), h = Math.round(vb.height * scale);
    var clone = srcSvg.cloneNode(true);
    inlineChartStyles(srcSvg, clone);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    var xml = new XMLSerializer().serializeToString(clone);
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = (getComputedStyle(document.documentElement).getPropertyValue('--chart-bg') || '#ffffff').trim();
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      if (type === 'pdf') {
        downloadBlob(jpegToPdf(canvas.toDataURL('image/jpeg', 0.92), w, h), 'psychrometric-chart.pdf');
      } else {
        canvas.toBlob(function (blob) { downloadBlob(blob, 'psychrometric-chart.png'); }, 'image/png');
      }
    };
    img.onerror = function () { alert('Chart export failed.'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }

  // Minimal single-page PDF embedding the chart as a JPEG (no dependencies).
  function jpegToPdf(dataUrl, w, h) {
    var jpg = atob(dataUrl.split(',')[1]);
    var maxDim = 1400, sc = Math.min(1, maxDim / Math.max(w, h));
    var pw = (w * sc).toFixed(2), ph = (h * sc).toFixed(2);
    var content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
    var objs = [null,
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] ' +
        '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n' + jpg + '\nendstream',
      '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'];
    var pdf = '%PDF-1.4\n', offsets = [];
    for (var i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    var xref = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (var k = 1; k <= 5; k++) pdf += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
    pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    var bytes = new Uint8Array(pdf.length);
    for (var b = 0; b < pdf.length; b++) bytes[b] = pdf.charCodeAt(b) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  // ---- project export / import (points + processes) ----------------------
  function exportProject() {
    var data = {
      app: 'PsychPlotter', version: 1,
      pressurePa: state.pressurePa,
      points: state.points, nextId: state.nextId,
      processes: state.processes, nextProcessId: state.nextProcessId
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      'psychplotter-project.json');
  }

  function importProject(text) {
    el['proj-status'].textContent = '';
    var d;
    try { d = JSON.parse(text); } catch (e) { el['proj-status'].textContent = 'Not a valid project file.'; return; }
    if (!d || d.app !== 'PsychPlotter' || !Array.isArray(d.points)) {
      el['proj-status'].textContent = 'This isn’t a PsychPlotter project file.';
      return;
    }
    // Keep only well-formed points so a corrupt/edited file can't break rendering.
    var points = d.points.filter(function (p) {
      return p && typeof p.id === 'number' && typeof p.tdbC === 'number' &&
        typeof p.w === 'number' && isFinite(p.tdbC) && isFinite(p.w);
    });
    var maxId = points.reduce(function (m, p) { return Math.max(m, p.id); }, 0);
    state.points = points;
    state.processes = Array.isArray(d.processes) ? d.processes : [];
    state.nextId = typeof d.nextId === 'number' && d.nextId > maxId ? d.nextId : maxId + 1;
    state.nextProcessId = typeof d.nextProcessId === 'number' ? d.nextProcessId : (state.processes.length + 1);
    if (typeof d.pressurePa === 'number' && d.pressurePa > 0) state.pressurePa = d.pressurePa;
    stagingIds = [];
    renderAll();  // render first so a bad point can't persist a broken state
    save();
  }

  function renderTable() {
    var wrap = el['points-table-wrap'];
    if (state.points.length === 0) {
      wrap.innerHTML = '<p class="hint">No points yet.</p>';
      return;
    }
    var u = UNITS[state.unit];
    var rows = state.points.map(function (p) {
      var d = derive(p, state.unit);
      var name = p.label ? p.label : ('P' + p.id);
      return '<tr>' +
        '<td class="label-cell"><span class="swatch"></span>' + escapeHtml(name) + '</td>' +
        '<td>' + d.tdb.toFixed(1) + '</td>' +
        '<td>' + d.twb.toFixed(1) + '</td>' +
        '<td>' + d.tdp.toFixed(1) + '</td>' +
        '<td>' + d.rh.toFixed(1) + '</td>' +
        '<td>' + wDisplay(d.w, state.unit) + '</td>' +
        '<td>' + hDisplay(d.h, state.unit) + '</td>' +
        '<td>' + d.v.toFixed(state.unit === IP ? 2 : 3) + '</td>' +
        '<td><button class="row-del" data-id="' + p.id + '" title="Remove">×</button></td>' +
        '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table class="points"><thead><tr>' +
      '<th class="label-cell">Point</th>' +
      '<th>Tdb<br>' + u.temp + '</th>' +
      '<th>Twb<br>' + u.temp + '</th>' +
      '<th>Tdp<br>' + u.temp + '</th>' +
      '<th>RH<br>%</th>' +
      '<th>W<br>' + u.w + '</th>' +
      '<th>h<br>' + u.h + '</th>' +
      '<th>v<br>' + u.v + '</th>' +
      '<th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    Array.prototype.forEach.call(wrap.querySelectorAll('.row-del'), function (b) {
      b.addEventListener('click', function () {
        removePoint(parseInt(b.getAttribute('data-id'), 10));
      });
    });
  }

  function renderAll() {
    refreshUnitLabels();
    refreshPressureFields();
    renderChart();
    renderTable();
    renderProcessBuilder();
    renderProcessList();
    renderMixBuilder();
    renderShrBuilder();
    renderImport();
    renderZones();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- point creation -----------------------------------------------------
  function addPoint(ev) {
    ev.preventDefault();
    el['form-error'].textContent = '';

    var tdb = parseFloat(el['pt-tdb'].value);
    var prop2 = el['pt-prop2'].value;
    var val = parseFloat(el['pt-prop2val'].value);
    if (isNaN(tdb) || isNaN(val)) {
      el['form-error'].textContent = 'Enter numeric values for both properties.';
      return;
    }

    var P = pressureInUnit(state.pressurePa, state.unit);
    setPsyUnit(state.unit); // pin units AFTER any pressure math
    var w;
    try {
      if (prop2 === 'rh') {
        if (val < 0 || val > 100) throw new Error('Relative humidity must be between 0 and 100%.');
        w = psychrolib.GetHumRatioFromRelHum(tdb, val / 100, P);
      } else if (prop2 === 'twb') {
        if (val > tdb + 1e-6) throw new Error('Wet-bulb cannot exceed dry-bulb temperature.');
        w = psychrolib.GetHumRatioFromTWetBulb(tdb, val, P);
      } else { // tdp
        if (val > tdb + 1e-6) throw new Error('Dew-point cannot exceed dry-bulb temperature.');
        w = psychrolib.GetHumRatioFromTDewPoint(val, P);
      }
    } catch (e) {
      el['form-error'].textContent = e.message || 'Could not compute this state.';
      return;
    }

    if (!(w >= 0) || !isFinite(w)) {
      el['form-error'].textContent = 'Resulting state is not physically valid.';
      return;
    }

    state.points.push({
      id: state.nextId++,
      label: el['pt-label'].value.trim(),        // optional; blank falls back to P#
      tdbC: state.unit === IP ? fToC(tdb) : tdb,
      w: w,
      pressurePa: state.pressurePa
    });

    el['pt-label'].value = '';
    el['pt-tdb'].value = '';
    el['pt-prop2val'].value = '';
    el['pt-tdb'].focus();
    save();
    renderChart();
    renderTable();
    renderProcessBuilder();
    renderMixBuilder();
    renderShrBuilder();
  }

  // ---- persistence (on-device only) --------------------------------------
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        unit: state.unit, pressurePa: state.pressurePa,
        theme: state.theme, themeExplicit: state.themeExplicit,
        points: state.points, nextId: state.nextId,
        processes: state.processes, nextProcessId: state.nextProcessId
      }));
    } catch (e) { /* storage unavailable — ignore */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d.unit === IP || d.unit === SI) state.unit = d.unit;
      if (typeof d.pressurePa === 'number' && d.pressurePa > 0) state.pressurePa = d.pressurePa;
      // Only honor a saved theme the user explicitly chose; otherwise keep the
      // light default (so an old auto-saved "dark" doesn't override it).
      if (d.themeExplicit && (d.theme === 'dark' || d.theme === 'light')) {
        state.theme = d.theme;
        state.themeExplicit = true;
      }
      // Chart display toggles are intentionally not restored — they always start
      // from the defaults (grid/enthalpy/dew-point off, the rest on).
      if (Array.isArray(d.points)) state.points = d.points;
      if (typeof d.nextId === 'number') state.nextId = d.nextId;
      if (Array.isArray(d.processes)) state.processes = d.processes;
      if (typeof d.nextProcessId === 'number') state.nextProcessId = d.nextProcessId;
    } catch (e) { /* ignore corrupt storage */ }
  }

  // ---- unit / theme toggles ----------------------------------------------
  function applyUnit(newUnit) {
    if (newUnit === state.unit) return;
    state.unit = newUnit;                    // pressurePa unchanged (physical)
    el['unit-ip'].classList.toggle('active', newUnit === IP);
    el['unit-si'].classList.toggle('active', newUnit === SI);
    save();
    renderAll();
  }

  function applyTheme(theme, explicit) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    el['theme-dark'].classList.toggle('active', theme === 'dark');
    el['theme-light'].classList.toggle('active', theme === 'light');
    if (explicit) { state.themeExplicit = true; save(); }
  }

  // ---- pressure / elevation inputs ---------------------------------------
  function onElevationChange() {
    var v = parseFloat(el['elevation'].value);
    if (isNaN(v)) return;
    var elevM = state.unit === IP ? ftToM(v) : v;
    state.pressurePa = pressurePaFromElevationM(elevM);
    save();
    renderAll();
  }
  function onPressureChange() {
    var v = parseFloat(el['pressure'].value);
    if (isNaN(v) || v <= 0) return;
    state.pressurePa = state.unit === IP ? v * PA_PER_PSI : v * 1000;
    save();
    renderAll();
  }

  // ---- display options ----------------------------------------------------
  function syncOptionInputs() {
    el['opt-tdb-axis'].checked = state.show.dryBulbAxis;
    el['opt-w-axis'].checked = state.show.humidityAxis;
    el['opt-rh'].checked = state.show.rh;
    el['opt-wb'].checked = state.show.wetbulb;
    el['opt-enth'].checked = state.show.enthalpy;
    el['opt-dp'].checked = state.show.dewpoint;
    el['opt-grid'].checked = state.show.grid;
  }
  function wireOption(id, key) {
    el[id].addEventListener('change', function () {
      state.show[key] = el[id].checked;
      save();
      renderChart();
    });
  }

  // ---- tabs ---------------------------------------------------------------
  function wireTabs() {
    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-tab');
        Array.prototype.forEach.call(tabs, function (t) {
          t.classList.toggle('active', t === tab);
        });
        ['points', 'import'].forEach(function (n) {
          document.getElementById('tab-' + n).classList.toggle('hidden', n !== name);
        });
        state.activeTab = name;
        renderChart();
      });
    });
  }

  // Keep the sticky chart's top offset in sync with the (wrapping) header height.
  function syncHeaderHeight() {
    var h = document.querySelector('.app-header');
    if (h) document.documentElement.style.setProperty('--header-h', h.offsetHeight + 'px');
  }

  // ---- wiring -------------------------------------------------------------
  function init() {
    grab();
    load();
    syncHeaderHeight();
    window.addEventListener('resize', syncHeaderHeight);

    el['unit-ip'].addEventListener('click', function () { applyUnit(IP); });
    el['unit-si'].addEventListener('click', function () { applyUnit(SI); });
    el['theme-dark'].addEventListener('click', function () { applyTheme('dark', true); });
    el['theme-light'].addEventListener('click', function () { applyTheme('light', true); });

    el['elevation'].addEventListener('change', onElevationChange);
    el['pressure'].addEventListener('change', onPressureChange);

    el['pt-prop2'].addEventListener('change', refreshUnitLabels);
    el['point-form'].addEventListener('submit', addPoint);

    el['proc-add-point'].addEventListener('change', function () {
      var v = parseInt(el['proc-add-point'].value, 10);
      if (!isNaN(v)) stagingIds.push(v);
      el['proc-add-point'].value = '';
      el['proc-error'].textContent = '';
      renderProcessBuilder();
    });
    el['proc-add'].addEventListener('click', addProcess);

    el['mix-a'].addEventListener('change', updateMixButton);
    el['mix-b'].addEventListener('change', updateMixButton);
    el['mix-a-flow'].addEventListener('input', updateMixButton);
    el['mix-b-flow'].addEventListener('input', updateMixButton);
    el['mix-add'].addEventListener('click', addMixedPoint);

    el['shr-from'].addEventListener('change', updateShrButton);
    el['shr-value'].addEventListener('input', updateShrButton);
    el['shr-tdb'].addEventListener('input', updateShrButton);
    el['shr-add'].addEventListener('click', addShrProcess);

    el['epw-input'].addEventListener('change', function () {
      var file = el['epw-input'].files[0];
      if (!file) return;
      el['epw-status'].innerHTML = '<div class="hint">Reading ' + escapeHtml(file.name) + '…</div>';
      var reader = new FileReader();
      reader.onload = function (ev) { parseEPW(ev.target.result, file.name); el['epw-input'].value = ''; };
      reader.onerror = function () { setImportError('Could not read this file.'); };
      reader.readAsText(file);
    });
    el['epw-clear'].addEventListener('click', function () {
      state.weather = null;
      renderChart();
      renderImport();
      renderZones();
    });

    [['zone-comfort', 'comfort'], ['zone-dc-rec', 'dcRec'], ['zone-dc-a1', 'dcA1'], ['zone-dc-a2', 'dcA2']]
      .forEach(function (pair) {
        el[pair[0]].addEventListener('change', function () {
          state.zones[pair[1]] = el[pair[0]].checked;
          renderChart();
          renderZones();
        });
      });

    el['export-png'].addEventListener('click', function () { exportChartImage('png'); });
    el['export-pdf'].addEventListener('click', function () { exportChartImage('pdf'); });

    el['proj-export'].addEventListener('click', exportProject);
    el['proj-import-btn'].addEventListener('click', function () { el['proj-import'].click(); });
    el['proj-import'].addEventListener('change', function () {
      var file = el['proj-import'].files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) { importProject(ev.target.result); el['proj-import'].value = ''; };
      reader.onerror = function () { el['proj-status'].textContent = 'Could not read this file.'; };
      reader.readAsText(file);
    });
    el['proc-clear-staging'].addEventListener('click', function () {
      stagingIds = [];
      el['proc-name'].value = '';
      el['proc-closed'].checked = false;
      el['proc-error'].textContent = '';
      renderProcessBuilder();
    });

    el['clear-all'].addEventListener('click', function () {
      state.points = [];
      state.processes = [];
      stagingIds = [];
      save();
      renderAll();
    });

    wireOption('opt-tdb-axis', 'dryBulbAxis');
    wireOption('opt-w-axis', 'humidityAxis');
    wireOption('opt-rh', 'rh');
    wireOption('opt-wb', 'wetbulb');
    wireOption('opt-enth', 'enthalpy');
    wireOption('opt-dp', 'dewpoint');
    wireOption('opt-grid', 'grid');
    wireTabs();

    // reflect loaded state into the UI
    el['unit-ip'].classList.toggle('active', state.unit === IP);
    el['unit-si'].classList.toggle('active', state.unit === SI);
    applyTheme(state.theme, false);
    syncOptionInputs();

    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
