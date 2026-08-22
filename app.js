(function () {
  'use strict';
  const { jsPDF } = window.jspdf;
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const OSRM_BASE = 'https://router.project-osrm.org';
  const WORLD_TILE_SIZE = 512;
  const MAX_CANVAS_SIDE = 1600;
  const ISO_RAYS = 16;
  const ROAD_LABEL_LAYERS = ['highway-name-path', 'highway-name-minor', 'highway-name-major'];
  const MARGIN_MM = 0, HEADER_MM = 0, FOOTER_MM = 0; // full-bleed: map fills entire page for edge-to-edge taping
  let cancelled = false, renderMap = null;

  function setStatus(msg, type) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.className = type ? 'status-' + type : '';
  }
  function setProgress(pct) {
    var wrap = document.getElementById('progressWrap');
    var bar = document.getElementById('progressBar');
    wrap.style.display = pct >= 0 ? 'block' : 'none';
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function updateLabelScalePreview() {
    var v = parseFloat(document.getElementById('labelScale').value);
    document.getElementById('labelScaleValue').textContent = v.toFixed(2) + 'x';
    var rem = 0.8 + (v - 1.0) * (0.45 / 1.5);
    document.getElementById('labelScaleSample').style.fontSize = rem.toFixed(2) + 'rem';
  }
  function deg2rad(d) { return d * Math.PI / 180; }
  function rad2deg(r) { return r * 180 / Math.PI; }
  function metersPerDegree(lat) {
    var latRad = deg2rad(lat);
    return {
      lat: 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad),
      lon: 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad)
    };
  }
  function travelToMeters(dist, unit) {
    var r = parseFloat(dist);
    return unit === 'mi' ? r * 1609.344 : r * 1000;
  }
  function destinationPoint(lat, lon, distanceM, bearingDeg) {
    var R = 6371000, brng = deg2rad(bearingDeg), lat1 = deg2rad(lat), lon1 = deg2rad(lon), angDist = distanceM / R;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1), Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: rad2deg(lat2), lon: rad2deg(lon2) };
  }
  function haversineM(lat1, lon1, lat2, lon2) {
    var R = 6371000, dLat = deg2rad(lat2 - lat1), dLon = deg2rad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function pointAlongCoords(coords, maxMeters) {
    if (!coords || coords.length < 2) return null;
    var remaining = maxMeters;
    for (var i = 1; i < coords.length; i++) {
      var lon1 = coords[i - 1][0], lat1 = coords[i - 1][1], lon2 = coords[i][0], lat2 = coords[i][1];
      var seg = haversineM(lat1, lon1, lat2, lon2);
      if (seg <= 0) continue;
      if (remaining <= seg) {
        var t = remaining / seg;
        return { lon: lon1 + (lon2 - lon1) * t, lat: lat1 + (lat2 - lat1) * t };
      }
      remaining -= seg;
    }
    var last = coords[coords.length - 1];
    return { lon: last[0], lat: last[1] };
  }
  async function computeTravelCoverage(lon, lat, maxMeters, profile) {
    var rays = ISO_RAYS, probeM = maxMeters * 1.5, tasks = [];
    for (var i = 0; i < rays; i++) {
      (function (bearing) {
        var dest = destinationPoint(lat, lon, probeM, bearing);
        var url = OSRM_BASE + '/route/v1/' + profile + '/' + lon + ',' + lat + ';' + dest.lon + ',' + dest.lat + '?overview=full&geometries=geojson';
        tasks.push(
          fetch(url).then(function (r) { return r.json(); }).then(function (data) {
            if (data.code !== 'Ok' || !data.routes || !data.routes[0]) return destinationPoint(lat, lon, maxMeters, bearing);
            var route = data.routes[0], coords = route.geometry && route.geometry.coordinates;
            if (!coords || coords.length < 2) return destinationPoint(lat, lon, maxMeters, bearing);
            if (route.distance <= maxMeters) { var end = coords[coords.length - 1]; return { lon: end[0], lat: end[1] }; }
            return pointAlongCoords(coords, maxMeters) || destinationPoint(lat, lon, maxMeters, bearing);
          }).catch(function () { return destinationPoint(lat, lon, maxMeters, bearing); })
        );
      })((i / rays) * 360);
    }
    var vertices = await Promise.all(tasks);
    var west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (var v = 0; v < vertices.length; v++) {
      west = Math.min(west, vertices[v].lon); east = Math.max(east, vertices[v].lon);
      south = Math.min(south, vertices[v].lat); north = Math.max(north, vertices[v].lat);
    }
    return { vertices: vertices, method: 'osrm', bbox: { west: west, east: east, south: south, north: north } };
  }
  function paperSizeMm(paper, orient) {
    var w, h; if (paper === 'a4') { w = 210; h = 297; } else { w = 215.9; h = 279.4; }
    return orient === 'landscape' ? { widthMm: h, heightMm: w } : { widthMm: w, heightMm: h };
  }
  function mapAreaMm(paper) {
    return { widthMm: paper.widthMm, heightMm: paper.heightMm, margin: 0, header: 0, footer: 0 };
  }
  function zoomForPage(widthPx, lonSpan) {
    var z = Math.log2((widthPx * 360) / (lonSpan * WORLD_TILE_SIZE));
    return isFinite(z) ? z : 15;
  }
  function buildTravelTiles(place, travelBbox, pageWidthM, pageHeightM, mpd) {
    var cellLon = pageWidthM / mpd.lon;
    var cellLat = pageHeightM / mpd.lat;
    if (!(cellLon > 0) || !(cellLat > 0)) throw new Error('Invalid page size — try a different DPI or map extent.');
    var homeWest = place.lon - cellLon / 2;
    var homeSouth = place.lat - cellLat / 2;
    var minCol = Math.min(0, Math.floor((travelBbox.west - homeWest) / cellLon));
    var maxCol = Math.max(0, Math.ceil((travelBbox.east - homeWest) / cellLon) - 1);
    var minRow = Math.min(0, Math.floor((travelBbox.south - homeSouth) / cellLat));
    var maxRow = Math.max(0, Math.ceil((travelBbox.north - homeSouth) / cellLat) - 1);
    var tiles = [];
    for (var row = minRow; row <= maxRow; row++) {
      for (var col = minCol; col <= maxCol; col++) {
        var west = homeWest + col * cellLon;
        var east = west + cellLon;
        var south = homeSouth + row * cellLat;
        var north = south + cellLat;
        var isHome = (col === 0 && row === 0);
        tiles.push({ col: col, row: row, west: west, east: east, south: south, north: north, isHome: isHome, hasHome: isHome, dist: Math.sqrt(col * col + row * row) });
      }
    }
    return tiles;
  }
  function selectConnectedPages(tiles, maxPages) {
    maxPages = Math.max(1, maxPages);
    var byKey = {};
    for (var i = 0; i < tiles.length; i++) byKey[tiles[i].col + ',' + tiles[i].row] = tiles[i];
    var home = null;
    for (var h = 0; h < tiles.length; h++) if (tiles[h].isHome) { home = tiles[h]; break; }
    if (!home) home = tiles[0];
    var selected = [];
    var chosen = {};
    var heap = [home];
    var inHeap = {};
    inHeap[home.col + ',' + home.row] = true;
    function heapPush(t) {
      if (!t) return;
      var k = t.col + ',' + t.row;
      if (chosen[k] || inHeap[k] || !byKey[k]) return;
      inHeap[k] = true;
      heap.push(t);
    }
    while (heap.length > 0 && selected.length < maxPages) {
      heap.sort(function (a, b) {
        if (a.dist !== b.dist) return a.dist - b.dist;
        var rank = function (t) {
          if (t.col > 0 && t.row === 0) return 0;
          if (t.col === 0 && t.row > 0) return 1;
          if (t.col < 0 && t.row === 0) return 2;
          if (t.col === 0 && t.row < 0) return 3;
          return 4;
        };
        var ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.row !== b.row) return a.row - b.row;
        return a.col - b.col;
      });
      var t = heap.shift();
      var k = t.col + ',' + t.row;
      inHeap[k] = false;
      if (chosen[k]) continue;
      if (selected.length > 0) {
        var touches = false;
        var dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (var d = 0; d < dirs.length; d++) {
          var ck = (t.col + dirs[d][0]) + ',' + (t.row + dirs[d][1]);
          if (chosen[ck]) { touches = true; break; }
        }
        if (!touches) continue;
      }
      chosen[k] = true;
      selected.push(t);
      heapPush(byKey[(t.col + 1) + ',' + t.row]);
      heapPush(byKey[t.col + ',' + (t.row + 1)]);
      heapPush(byKey[(t.col - 1) + ',' + t.row]);
      heapPush(byKey[t.col + ',' + (t.row - 1)]);
    }
    for (var s = 0; s < selected.length; s++) {
      selected[s].pdfIndex = s;
      selected[s].touchesPdf = [];
      var dirs2 = [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'N'], [0, -1, 'S']];
      for (var d2 = 0; d2 < dirs2.length; d2++) {
        var nk2 = (selected[s].col + dirs2[d2][0]) + ',' + (selected[s].row + dirs2[d2][1]);
        for (var s2 = 0; s2 < selected.length; s2++) {
          if (selected[s2].col + ',' + selected[s2].row === nk2) {
            selected[s].touchesPdf.push({ page: s2 + 1, dir: dirs2[d2][2] });
          }
        }
      }
    }
    return selected;
  }
  function addHomeMarker(map, lon, lat) {
    try {
      if (map.getSource('home-pt')) {
        if (map.getLayer('home-label')) map.removeLayer('home-label');
        if (map.getLayer('home-circle')) map.removeLayer('home-circle');
        map.removeSource('home-pt');
      }
    } catch (e) {}
    map.addSource('home-pt', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} } });
    map.addLayer({ id: 'home-circle', type: 'circle', source: 'home-pt', paint: { 'circle-radius': 10, 'circle-color': '#e11d48', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' } });
    map.addLayer({ id: 'home-label', type: 'symbol', source: 'home-pt', layout: { 'text-field': 'HOME', 'text-size': 16, 'text-offset': [0, 1.35], 'text-font': ['Noto Sans Regular'], 'text-anchor': 'top' }, paint: { 'text-color': '#be123c', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
  }
  async function geocode(address) {
    var url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', address); url.searchParams.set('format', 'json'); url.searchParams.set('limit', '1');
    var res = await fetch(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'PrintableMapPDF/4.2 (full-bleed printable map)' } });
    if (!res.ok) throw new Error('Geocoding failed (' + res.status + ').');
    var data = await res.json();
    if (!data || !data.length) throw new Error('Address not found.');
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name };
  }
  function simplifyStyleForPrint(map) {
    var style = map.getStyle(); if (!style || !style.layers) return;
    var hideSubstrings = ['landcover','landuse','park','grass','wood','forest','wetland','glacier','sand','pitch','garden','allotments','cemetery','orchard','vineyard','farmland','farm','water','ocean','river','lake','waterway','basin','reservoir','dock','swimming','building'];
    for (var i = 0; i < style.layers.length; i++) {
      var layer = style.layers[i], id = (layer.id || '').toLowerCase(), type = layer.type;
      if (type === 'fill-extrusion') { try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch (e) {} continue; }
      if (type === 'symbol' || type === 'line') continue;
      if (id.indexOf('boundary') >= 0 || id.indexOf('admin') >= 0 || id.indexOf('border') >= 0) continue;
      if (id.indexOf('road') >= 0 || id.indexOf('highway') >= 0 || id.indexOf('bridge') >= 0 || id.indexOf('tunnel') >= 0) continue;
      var hide = false;
      for (var j = 0; j < hideSubstrings.length; j++) if (id.indexOf(hideSubstrings[j]) >= 0) { hide = true; break; }
      if (!hide && (type === 'fill' || type === 'raster')) hide = true;
      if (hide) try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch (e) {}
    }
    try { if (map.getLayer('background')) { map.setPaintProperty('background', 'background-color', '#ffffff'); map.setLayoutProperty('background', 'visibility', 'visible'); } } catch (e) {}
  }
  function applyRoadLabelScale(map, scale) {
    var minByLayer = { 'highway-name-path': 13, 'highway-name-minor': 13, 'highway-name-major': 12 };
    for (var t = 0; t < ROAD_LABEL_LAYERS.length; t++) {
      var id = ROAD_LABEL_LAYERS[t]; if (!map.getLayer(id)) continue;
      try {
        var minz = minByLayer[id] != null ? minByLayer[id] : 13;
        try { map.setLayerZoomRange(id, minz, 24); } catch (eZ) {}
        map.setLayoutProperty(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 12, 12 * scale, 13, 13 * scale, 14, 14 * scale, 15, 15 * scale, 16, 15 * scale, 18, 14 * scale]);
        map.setLayoutProperty(id, 'text-font', ['Noto Sans Regular']);
        map.setLayoutProperty(id, 'text-padding', 1);
        map.setLayoutProperty(id, 'symbol-spacing', 100);
        map.setLayoutProperty(id, 'visibility', 'visible');
        map.setPaintProperty(id, 'text-color', '#111111');
        map.setPaintProperty(id, 'text-halo-color', '#ffffff');
        map.setPaintProperty(id, 'text-halo-width', Math.min(2.2, 0.55 * scale));
      } catch (e) { console.warn('label scale failed for', id, e); }
    }
  }
  function waitForIdle(map, timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (done) return; done = true; resolve(); }
      var t = setTimeout(finish, timeoutMs);
      map.once('idle', function () { clearTimeout(t); setTimeout(finish, 150); });
    });
  }
  async function createMap(widthPx, heightPx) {
    var container = document.getElementById('mapCapture');
    container.style.width = widthPx + 'px'; container.style.height = heightPx + 'px';
    if (renderMap) { try { renderMap.remove(); } catch (e) {} renderMap = null; }
    renderMap = new maplibregl.Map({ container: 'mapCapture', style: STYLE_URL, center: [0, 0], zoom: 2, interactive: false, attributionControl: false, preserveDrawingBuffer: true, fadeDuration: 0, pixelRatio: 1, maxPitch: 0, maxCanvasSize: [4096, 4096] });
    await new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('Map style load timed out. Try lower DPI or check network.')); }, 25000);
      renderMap.once('load', function () { clearTimeout(t); resolve(); });
      renderMap.once('error', function (e) { clearTimeout(t); reject(e.error || new Error('Map style load failed')); });
    });
    return renderMap;
  }
  async function renderPage(page, widthPx, heightPx, labelScale, homeLon, homeLat) {
    var map = await createMap(widthPx, heightPx);
    map.resize();
    simplifyStyleForPrint(map);
    applyRoadLabelScale(map, labelScale);
    var lonSpan = page.east - page.west;
    var zoom = zoomForPage(widthPx, lonSpan);
    var centerLon = (page.west + page.east) / 2;
    var centerLat = (page.south + page.north) / 2;
    map.jumpTo({ center: [centerLon, centerLat], zoom: zoom, bearing: 0, pitch: 0 });
    applyRoadLabelScale(map, labelScale);
    if (page.hasHome) addHomeMarker(map, homeLon, homeLat);
    await waitForIdle(map, 15000);
    var canvas = map.getCanvas();
    if (!canvas || canvas.width < 10) throw new Error('Map canvas empty — WebGL may be unavailable on this device.');
    var nw = map.project([page.west, page.north]);
    var se = map.project([page.east, page.south]);
    var x0 = Math.max(0, Math.floor(Math.min(nw.x, se.x)));
    var y0 = Math.max(0, Math.floor(Math.min(nw.y, se.y)));
    var x1 = Math.min(canvas.width, Math.ceil(Math.max(nw.x, se.x)));
    var y1 = Math.min(canvas.height, Math.ceil(Math.max(nw.y, se.y)));
    var cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    var out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
    return out;
  }
  function buildPdf(opts) {
    var orient = opts.orient, paper = opts.paper, place = opts.place, grid = opts.grid;
    var pageCanvases = opts.pageCanvases, mapArea = opts.mapArea, paperSize = opts.paperSize;
    var scaleDenom = opts.scaleDenom, travelLabel = opts.travelLabel, clipped = opts.clipped;
    var pdf = new jsPDF({ orientation: orient, unit: 'mm', format: paper === 'a4' ? 'a4' : 'letter' });
    var pageW = paperSize.widthMm, pageH = paperSize.heightMm;
    for (var i = 0; i < pageCanvases.length; i++) {
      if (i > 0) pdf.addPage();
      var item = pageCanvases[i], imgData = item.canvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, pageH);
      var label = (i + 1) + '/' + pageCanvases.length + '  (' + item.page.col + ',' + item.page.row + ')';
      if (item.page.hasHome) label += ' HOME';
      pdf.setFontSize(7);
      pdf.setTextColor(255, 255, 255);
      pdf.text(label, 2.2, 4.2);
      pdf.setTextColor(30);
      pdf.text(label, 2.0, 4.0);
      if (item.page.touchesPdf && item.page.touchesPdf.length) {
        var adj = item.page.touchesPdf.map(function (t) { return t.dir + '->p' + t.page; }).join(' ');
        pdf.setFontSize(6);
        pdf.setTextColor(255, 255, 255);
        pdf.text(adj, 2.2, 7.2);
        pdf.setTextColor(60);
        pdf.text(adj, 2.0, 7.0);
      }
      pdf.setFontSize(5);
      pdf.setTextColor(255, 255, 255);
      var foot = 'OSM/OpenFreeMap  ~1:' + scaleDenom.toLocaleString() + '  print 100% / borderless';
      pdf.text(foot, 2.2, pageH - 2.3);
      pdf.setTextColor(90);
      pdf.text(foot, 2.0, pageH - 2.5);
    }
    return pdf;
  }
  async function generate() {
    cancelled = false;
    var btn = document.getElementById('generateBtn'), cancelBtn = document.getElementById('cancelBtn');
    btn.disabled = true; cancelBtn.style.display = 'block'; setProgress(0);
    document.getElementById('previewWrap').style.display = 'none';
    try {
      var address = document.getElementById('address').value.trim();
      if (!address) throw new Error('Please enter an address.');
      var travelVal = parseFloat(document.getElementById('travelDist').value);
      if (!(travelVal > 0)) throw new Error('Travel distance must be positive.');
      var unit = document.getElementById('unit').value, mode = document.getElementById('mode').value;
      var maxPages = Math.max(1, Math.min(36, parseInt(document.getElementById('maxPages').value, 10) || 9));
      var paper = document.getElementById('paper').value, orient = document.getElementById('orient').value;
      var targetDpi = parseInt(document.getElementById('dpi').value, 10);
      var labelScale = parseFloat(document.getElementById('labelScale').value);
      var planZoom = parseFloat(document.getElementById('mapExtent').value) || 16.2;
      var maxMeters = travelToMeters(travelVal, unit);
      var modeLabel = mode === 'driving' ? 'driving' : mode === 'cycling' ? 'cycling' : 'walking';
      var travelLabel = 'Travel distance: ' + travelVal + ' ' + unit + ' (' + modeLabel + ')';
      setStatus('Geocoding address...');
      var place = await geocode(address);
      if (cancelled) return;
      setStatus('Found: ' + place.display + '\nComputing ' + modeLabel + ' travel area (' + travelVal + ' ' + unit + ')...');
      setProgress(3);
      var coverage = await computeTravelCoverage(place.lon, place.lat, maxMeters, mode);
      if (cancelled) return;
      var travelBbox = {
        west: Math.min(coverage.bbox.west, place.lon),
        east: Math.max(coverage.bbox.east, place.lon),
        south: Math.min(coverage.bbox.south, place.lat),
        north: Math.max(coverage.bbox.north, place.lat)
      };
      var paperSize = paperSizeMm(paper, orient);
      var mapArea = mapAreaMm(paperSize);
      var mapPxW = Math.round((mapArea.widthMm / 25.4) * targetDpi);
      var mapPxH = Math.round((mapArea.heightMm / 25.4) * targetDpi);
      if (mapPxW > MAX_CANVAS_SIDE || mapPxH > MAX_CANVAS_SIDE) {
        var s = Math.min(MAX_CANVAS_SIDE / mapPxW, MAX_CANVAS_SIDE / mapPxH);
        mapPxW = Math.round(mapPxW * s); mapPxH = Math.round(mapPxH * s);
      }
      var mpd = metersPerDegree(place.lat);
      var resEq = 156543.03392 / Math.pow(2, planZoom);
      var mpp = resEq * Math.cos(deg2rad(place.lat));
      var pageWidthM = mapPxW * mpp;
      var pageHeightM = mapPxH * mpp;
      var scaleDenom = Math.round(mpp * targetDpi * 39.3701);
      var allTiles = buildTravelTiles(place, travelBbox, pageWidthM, pageHeightM, mpd);
      var pages = selectConnectedPages(allTiles, maxPages);
      var clipped = pages.length < allTiles.length;
      for (var vi = 1; vi < pages.length; vi++) {
        if (!pages[vi].touchesPdf || !pages[vi].touchesPdf.length) {
          console.warn('Connectivity warning: page', vi + 1, 'has no neighbor in selection');
        }
      }
      setStatus('Center: ' + place.lat.toFixed(5) + ', ' + place.lon.toFixed(5) + '\n' + travelLabel + '\nTiles covering travel area: ' + allTiles.length + ' → printing ' + pages.length + ' (home first, then nearest)\nPage size ~ ' + (pageWidthM / 1609.344).toFixed(2) + ' × ' + (pageHeightM / 1609.344).toFixed(2) + ' mi\n' + (clipped ? 'Stopped at max pages (travel area not fully covered).\n' : 'Travel area fully covered.\n') + 'Rendering...');
      var pageCanvases = [];
      for (var pi = 0; pi < pages.length; pi++) {
        if (cancelled) throw new Error('Cancelled');
        var page = pages[pi];
        setStatus('Rendering page ' + (pi + 1) + ' of ' + pages.length + (page.hasHome ? ' * HOME' : '') + ' (grid col ' + page.col + ', row ' + page.row + ')...\n' + travelLabel);
        setProgress(8 + (pi / pages.length) * 80);
        var canvas = await renderPage(page, mapPxW, mapPxH, labelScale, place.lon, place.lat);
        pageCanvases.push({ canvas: canvas, page: page });
        if (page.hasHome || pi === 0) {
          var preview = document.getElementById('previewCanvas'), pctx = preview.getContext('2d');
          var sc = Math.min(1, 680 / canvas.width);
          preview.width = Math.round(canvas.width * sc); preview.height = Math.round(canvas.height * sc);
          pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
          document.getElementById('previewWrap').style.display = 'block';
        }
      }
      if (cancelled) throw new Error('Cancelled');
      setStatus('Assembling PDF...'); setProgress(90);
      var grid = { rows: pages.length, cols: 1, pages: pages.length };
      var pdf = buildPdf({ orient: orient, paper: paper, place: place, grid: grid, pageCanvases: pageCanvases, mapArea: mapArea, paperSize: paperSize, scaleDenom: scaleDenom, travelLabel: travelLabel, clipped: clipped });
      setProgress(100);
      var fname = 'road-map_' + place.lat.toFixed(4) + '_' + place.lon.toFixed(4) + '_' + pages.length + 'p.pdf';
      pdf.save(fname);
      setStatus('Done! Saved ' + fname + '\n' + pages.length + ' pages · ' + travelLabel + '\nPage 1 is HOME. Map fills each page edge-to-edge.\nPrint at 100% scale (borderless if your printer supports it) and tape edge-to-edge — no margins to trim.' + (clipped ? '\nNote: max pages reached before full travel area was covered.' : ''), clipped ? 'warn' : 'ok');
    } catch (err) {
      if (err.message === 'Cancelled') setStatus('Cancelled.', 'warn');
      else { console.error(err); setStatus('Error: ' + err.message, 'error'); }
    } finally {
      btn.disabled = false; cancelBtn.style.display = 'none';
      if (renderMap) { try { renderMap.remove(); } catch (e) {} renderMap = null; }
      setTimeout(function () { setProgress(-1); }, 1500);
    }
  }
  document.getElementById('labelScale').addEventListener('input', updateLabelScalePreview);
  updateLabelScalePreview();
  document.getElementById('generateBtn').addEventListener('click', generate);
  document.getElementById('cancelBtn').addEventListener('click', function () { cancelled = true; });
})();
