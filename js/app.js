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
    weather: null        // {name, count, points:[{tdbC,w}]} — session only, not persisted
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
     'epw-input', 'epw-status', 'epw-clear'
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
    var pts = state.points.map(function (p) {
      var d = derive(p, state.unit);
      return { id: p.id, label: p.label, tdb: d.tdb, w: d.w };
    });
    PsychChart.render(el['chart-container'], {
      unitSystem: state.unit,
      pressure: pressureInUnit(state.pressurePa, state.unit),
      points: pts,
      processes: resolvedProcessesForChart(),
      weather: state.weather ? state.weather.points.map(function (p) {
        return { tdb: state.unit === IP ? cToF(p.tdbC) : p.tdbC, w: p.w };
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
        return '<div class="seg-row"><span class="seg-label">' + lbl + '</span>' +
          '<select data-proc="' + proc.id + '" data-seg="' + s.index + '">' + options + '</select></div>';
      }).join('');

      return '<div class="proc-item">' +
        '<div class="proc-item-head">' +
          '<span class="proc-item-name"><span class="dot"></span>' + title + '</span>' +
          '<button class="row-del" data-proc="' + proc.id + '" title="Remove">×</button>' +
        '</div>' +
        '<div class="proc-seq hint">' + seq.join(' → ') + '</div>' +
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
      proc.pointIds = proc.pointIds.filter(function (pid) { return pid !== id; });
      proc.paths = {};
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

      psychrolib.SetUnitSystem(psychrolib.SI);
      var pts = [], skipped = 0;
      for (var i = 8; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var f = line.split(',');
        if (f.length < 10) continue;
        var tdb = parseFloat(f[6]), tdp = parseFloat(f[7]);
        var rh = parseFloat(f[8]), pr = parseFloat(f[9]);
        if (!isFinite(tdb) || tdb <= -60 || tdb >= 70) { skipped++; continue; } // EPW missing = 99.9
        var P = (isFinite(pr) && pr >= 30000 && pr <= 120000) ? pr : state.pressurePa;
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
      renderChart();
      renderImport();
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
    renderImport();
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
  }

  // ---- persistence (on-device only) --------------------------------------
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        unit: state.unit, pressurePa: state.pressurePa,
        theme: state.theme, themeExplicit: state.themeExplicit,
        show: state.show, points: state.points, nextId: state.nextId,
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
      if (d.show) Object.assign(state.show, d.show);
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
      });
    });
  }

  // ---- wiring -------------------------------------------------------------
  function init() {
    grab();
    load();

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
    });
    el['proc-clear-staging'].addEventListener('click', function () {
      stagingIds = [];
      el['proc-name'].value = '';
      el['proc-closed'].checked = false;
      el['proc-error'].textContent = '';
      renderProcessBuilder();
    });

    el['clear-all'].addEventListener('click', function () {
      if (state.points.length && !confirm('Remove all points and processes?')) return;
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
