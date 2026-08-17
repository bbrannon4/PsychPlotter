/*
 * PsychChart — renders a psychrometric chart as SVG.
 * Depends on the global `psychrolib` (must have its unit system already set by the caller).
 *
 * Coordinate model:
 *   x-axis  = dry-bulb temperature
 *   y-axis  = humidity ratio (0 at bottom), drawn/labelled on the right edge
 */
(function (global) {
  'use strict';

  // Chart bounds and tick spacing per unit system.
  var CONFIG = {
    IP: {
      tdbMin: 32, tdbMax: 120, tdbStep: 10,
      wMax: 0.028, wStep: 0.004,
      wScale: 1, wDecimals: 3,               // plotted in lb/lb
      tdbTitle: 'Dry-bulb temperature (°F)',
      wTitle: 'Humidity ratio (lbₕ₂ₒ / lbₐ)',
      wbList: [40, 50, 60, 70, 80],
      wbUnit: '°F',
      // enthalpy line values in the native psychrolib unit (Btu/lb),
      // hScale converts to the label value (Btu/lb -> Btu/lb here)
      hList: [15, 20, 25, 30, 35, 40, 45],
      hScale: 1, hDecimals: 0, hUnit: 'Btu/lb',
      tdpList: [40, 50, 60, 70, 80],
      tdpUnit: '°F'
    },
    SI: {
      tdbMin: 0, tdbMax: 50, tdbStep: 5,
      wMax: 0.030, wStep: 0.005,
      wScale: 1000, wDecimals: 0,            // plotted in g/kg
      tdbTitle: 'Dry-bulb temperature (°C)',
      wTitle: 'Humidity ratio (gₕ₂ₒ / kgₐ)',
      wbList: [5, 10, 15, 20, 25, 30],
      wbUnit: '°C',
      // enthalpy values in native psychrolib SI unit (J/kg); label in kJ/kg
      hList: [20000, 40000, 60000, 80000, 100000],
      hScale: 0.001, hDecimals: 0, hUnit: 'kJ/kg',
      tdpList: [5, 10, 15, 20, 25],
      tdpUnit: '°C'
    }
  };

  var RH_LINES = [10, 20, 30, 40, 50, 60, 70, 80, 90];

  // SVG canvas geometry (viewBox units).
  var W = 820, H = 560;
  var M = { top: 26, right: 92, bottom: 56, left: 44 };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmt(n, d) { return n.toFixed(d); }

  function render(container, opts) {
    var cfg = CONFIG[opts.unitSystem];
    var P = opts.pressure;
    var points = opts.points || [];
    var show = Object.assign(
      { dryBulbAxis: true, humidityAxis: true, rh: true, wetbulb: true,
        enthalpy: false, dewpoint: false, grid: false },
      opts.show || {}
    );

    // The grid curves below call psychrolib directly, so pin its unit system
    // to match this chart (pressure `P` is supplied in these same units).
    psychrolib.SetUnitSystem(opts.unitSystem === 'IP' ? psychrolib.IP : psychrolib.SI);

    var plotW = W - M.left - M.right;
    var plotH = H - M.top - M.bottom;
    var x0 = M.left, y0 = M.top;

    function sx(tdb) {
      return x0 + (tdb - cfg.tdbMin) / (cfg.tdbMax - cfg.tdbMin) * plotW;
    }
    function sy(w) {
      return y0 + (1 - w / cfg.wMax) * plotH;
    }

    var svg = [];
    svg.push('<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Psychrometric chart">');
    svg.push('<defs><marker id="proc-arrow" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" class="proc-arrow-head"/></marker></defs>');

    // --- Grid + dry-bulb ticks (vertical) ---
    for (var t = cfg.tdbMin; t <= cfg.tdbMax + 1e-6; t += cfg.tdbStep) {
      var xg = sx(t);
      if (show.grid) svg.push('<line class="grid-line" x1="' + xg + '" y1="' + y0 + '" x2="' + xg + '" y2="' + (y0 + plotH) + '"/>');
      if (show.dryBulbAxis) svg.push('<text class="axis-label" x="' + xg + '" y="' + (y0 + plotH + 16) + '" text-anchor="middle">' + fmt(t, 0) + '</text>');
    }
    // --- Grid + humidity-ratio ticks (horizontal) ---
    for (var w = 0; w <= cfg.wMax + 1e-9; w += cfg.wStep) {
      var yg = sy(w);
      if (show.grid) svg.push('<line class="grid-line" x1="' + x0 + '" y1="' + yg + '" x2="' + (x0 + plotW) + '" y2="' + yg + '"/>');
      if (show.humidityAxis) {
        var wLabel = fmt(w * cfg.wScale, cfg.wDecimals);
        svg.push('<text class="axis-label" x="' + (x0 + plotW + 8) + '" y="' + (yg + 3) + '" text-anchor="start">' + wLabel + '</text>');
      }
    }

    // --- Weather data cloud (drawn under the reference lines) ---
    var weather = opts.weather || [];
    if (weather.length) {
      var dots = [];
      weather.forEach(function (p) {
        if (p.tdb < cfg.tdbMin || p.tdb > cfg.tdbMax || p.w < 0 || p.w > cfg.wMax) return;
        dots.push('<circle cx="' + sx(p.tdb).toFixed(1) + '" cy="' + sy(p.w).toFixed(1) + '" r="1.4"/>');
      });
      svg.push('<g class="wx-layer">' + dots.join('') + '</g>');
    }

    // --- Constant dew-point lines (horizontal, off the saturation curve) ---
    if (show.dewpoint) cfg.tdpList.forEach(function (tdp) {
      if (tdp <= cfg.tdbMin || tdp >= cfg.tdbMax) return;
      var wv = psychrolib.GetSatHumRatio(tdp, P);
      if (wv > cfg.wMax) return;
      var y = sy(wv), xStart = sx(tdp);
      svg.push('<line class="dp-line" x1="' + xStart + '" y1="' + y + '" x2="' + (x0 + plotW) + '" y2="' + y + '"/>');
      svg.push('<text class="dp-label" x="' + (xStart + 3) + '" y="' + (y - 2) + '">' + tdp + cfg.tdpUnit + ' dp</text>');
    });

    // --- Constant enthalpy lines (straight, near-parallel to wet-bulb) ---
    if (show.enthalpy) cfg.hList.forEach(function (h) {
      var pts = [];
      for (var td = cfg.tdbMin; td <= cfg.tdbMax + 1e-6; td += 2) {
        var a = psychrolib.GetMoistAirEnthalpy(td, 0);           // enthalpy at W=0
        var b = psychrolib.GetMoistAirEnthalpy(td, 1) - a;       // slope per unit W
        var wv = (h - a) / b;
        if (wv < 0 || wv > cfg.wMax) continue;
        if (wv > psychrolib.GetSatHumRatio(td, P) + 1e-9) continue; // stay below saturation
        pts.push(sx(td) + ',' + sy(wv));
      }
      if (pts.length > 1) {
        svg.push('<polyline class="enth-line" points="' + pts.join(' ') + '"/>');
        var top = pts[pts.length - 1].split(',');
        svg.push('<text class="enth-label" x="' + (parseFloat(top[0]) - 2) + '" y="' + (parseFloat(top[1]) - 2) + '" text-anchor="end">' +
          fmt(h * cfg.hScale, cfg.hDecimals) + ' ' + cfg.hUnit + '</text>');
      }
    });

    // --- Constant wet-bulb lines (dashed) ---
    if (show.wetbulb) cfg.wbList.forEach(function (twb) {
      if (twb <= cfg.tdbMin || twb >= cfg.tdbMax) return;
      var pts = [];
      for (var td = twb; td <= cfg.tdbMax + 1e-6; td += 1) {
        var wv = psychrolib.GetHumRatioFromTWetBulb(td, twb, P);
        if (wv < 0) wv = 0;
        if (wv > cfg.wMax) continue;
        pts.push(sx(td) + ',' + sy(wv));
      }
      if (pts.length > 1) {
        svg.push('<polyline class="wb-line" points="' + pts.join(' ') + '"/>');
        var first = pts[0].split(',');
        svg.push('<text class="wb-label" x="' + (parseFloat(first[0]) + 2) + '" y="' + (parseFloat(first[1]) - 2) + '">' + twb + cfg.wbUnit + ' wb</text>');
      }
    });

    // --- Relative-humidity curves ---
    if (show.rh) RH_LINES.forEach(function (rh) {
      var frac = rh / 100;
      var pts = [];
      var last = null;
      for (var td = cfg.tdbMin; td <= cfg.tdbMax + 1e-6; td += 1) {
        var wv = psychrolib.GetHumRatioFromRelHum(td, frac, P);
        if (wv > cfg.wMax) break;
        var px = sx(td), py = sy(wv);
        pts.push(px + ',' + py);
        last = { x: px, y: py };
      }
      if (pts.length > 1) {
        svg.push('<polyline class="rh-line" points="' + pts.join(' ') + '"/>');
        if (last) {
          svg.push('<text class="curve-label" x="' + (last.x - 4) + '" y="' + (last.y - 3) + '" text-anchor="end">' + rh + '%</text>');
        }
      }
    });

    // --- Saturation curve (100% RH) ---
    var satPts = [];
    for (var ts = cfg.tdbMin; ts <= cfg.tdbMax + 1e-6; ts += 1) {
      var ws = psychrolib.GetSatHumRatio(ts, P);
      if (ws > cfg.wMax) {
        // interpolate exit point through top edge for a clean end
        satPts.push(sx(ts) + ',' + sy(cfg.wMax));
        break;
      }
      satPts.push(sx(ts) + ',' + sy(ws));
    }
    svg.push('<polyline class="sat-curve" points="' + satPts.join(' ') + '"/>');

    // --- Axis frame ---
    svg.push('<line class="axis-line" x1="' + x0 + '" y1="' + (y0 + plotH) + '" x2="' + (x0 + plotW) + '" y2="' + (y0 + plotH) + '"/>');
    svg.push('<line class="axis-line" x1="' + (x0 + plotW) + '" y1="' + y0 + '" x2="' + (x0 + plotW) + '" y2="' + (y0 + plotH) + '"/>');

    // --- Axis titles ---
    if (show.dryBulbAxis) {
      svg.push('<text class="axis-title" x="' + (x0 + plotW / 2) + '" y="' + (H - 12) + '" text-anchor="middle">' + esc(cfg.tdbTitle) + '</text>');
    }
    if (show.humidityAxis) {
      svg.push('<text class="axis-title" x="' + (W - 6) + '" y="' + (y0 - 10) + '" text-anchor="end">' + esc(cfg.wTitle) + '</text>');
    }

    // --- Process lines (drawn before points so markers sit on top) ---
    // No moist-air state can exceed 100% RH, so W is clamped to the saturation
    // curve (and the chart bounds). A straight chord that would cross saturation
    // therefore rides along it — the realistic cooling/dehumidifying-coil path.
    function clampW(w, tdb) {
      var wsat = psychrolib.GetSatHumRatio(tdb, P);
      var lim = Math.min(wsat, cfg.wMax);
      if (w > lim) w = lim;
      if (w < 0) w = 0;
      return w;
    }
    function sampleSegment(a, b, path) {
      var N = 24, out = [];
      var ref = null;
      if (path === 'wetbulb' || path === 'enthalpy') {
        ref = {
          twb: psychrolib.GetTWetBulbFromHumRatio(a.tdb, a.w, P),
          h: psychrolib.GetMoistAirEnthalpy(a.tdb, a.w)
        };
      }
      for (var i = 0; i <= N; i++) {
        var f = i / N;
        var td = a.tdb + (b.tdb - a.tdb) * f;
        var w;
        if (i === 0) { w = a.w; }            // anchor exactly to the endpoint markers
        else if (i === N) { w = b.w; }
        else if (path === 'saturation') { w = psychrolib.GetSatHumRatio(td, P); }
        else if (path === 'wetbulb') {
          // A constant-wet-bulb line reaches saturation at Tdb = Twb and cannot
          // continue below it (psychrolib rejects Twb > Tdb), so ride saturation there.
          w = (td <= ref.twb) ? psychrolib.GetSatHumRatio(td, P)
                              : psychrolib.GetHumRatioFromTWetBulb(td, ref.twb, P);
        }
        else if (path === 'enthalpy') {
          var a0 = psychrolib.GetMoistAirEnthalpy(td, 0);
          var b0 = psychrolib.GetMoistAirEnthalpy(td, 1) - a0;
          w = (ref.h - a0) / b0;
        } else { w = a.w + (b.w - a.w) * f; } // straight: linear in W
        out.push({ tdb: td, w: clampW(w, td) });
      }
      return out;
    }

    (opts.processes || []).forEach(function (proc) {
      var segs = proc.segments || [];
      segs.forEach(function (seg) {
        var pts = sampleSegment(seg.a, seg.b, seg.path).map(function (q) {
          return sx(q.tdb) + ',' + sy(q.w);
        });
        svg.push('<polyline class="proc-line" points="' + pts.join(' ') + '" marker-end="url(#proc-arrow)"/>');
      });
      if (proc.name && segs.length) {
        var a = segs[0].a, b = segs[0].b;
        var mx = (sx(a.tdb) + sx(b.tdb)) / 2, my = (sy(a.w) + sy(b.w)) / 2;
        svg.push('<text class="proc-label" x="' + mx + '" y="' + (my - 5) + '" text-anchor="middle">' + esc(proc.name) + '</text>');
      }
    });

    // --- Plotted points ---
    points.forEach(function (p) {
      if (typeof p.w !== 'number' || isNaN(p.w)) return;
      if (p.tdb < cfg.tdbMin || p.tdb > cfg.tdbMax || p.w < 0 || p.w > cfg.wMax) return;
      var px = sx(p.tdb), py = sy(p.w);
      svg.push('<circle class="pt-marker" cx="' + px + '" cy="' + py + '" r="5"/>');
      var lbl = p.label ? p.label : ('P' + p.id);   // point labels are always shown
      svg.push('<text class="pt-label" x="' + (px + 8) + '" y="' + (py - 6) + '">' + esc(lbl) + '</text>');
    });

    svg.push('</svg>');
    container.innerHTML = svg.join('');
  }

  global.PsychChart = { render: render, CONFIG: CONFIG };
})(window);
