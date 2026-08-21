(function () {
  'use strict';
  const { jsPDF } = window.jspdf;
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const OSRM_BASE = 'https://router.project-osrm.org';
  const WORLD_TILE_SIZE = 512;
  const MAX_CANVAS_SIDE = 1600;
  const ISO_RAYS = 16;
  const ROAD_LABEL_LAYERS = ['highway-name-path', 'highway-name-minor', 'highway-name-major'];
  const MARGIN_MM = 12, HEADER_MM = 16, FOOTER_MM = 18;
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
    return { widthMm: paper.widthMm - 2 * MARGIN_MM, heightMm: paper.heightMm - MARGIN_MM - HEADER_MM - FOOTER_MM, margin: MARGIN_MM, header: HEADER_MM, footer: FOOTER_MM };
  }
  function chooseGrid(maxPages) {
    var maxSide = Math.ceil(Math.sqrt(maxPages)), best = { rows: 1, cols: 1, pages: 1 };
    for (var r = 1; r <= maxSide; r++) for (var c = 1; c <= maxSide; c++) {
      var p = r * c; if (p > maxPages) continue;
      if (p > best.pages || (p === best.pages && Math.abs(r - c) < Math.abs(best.rows - best.cols))) best = { rows: r, cols: c, pages: p };
    }
    return best;
  }
  function buildPageGrid(coverBbox, grid) {
    var lonSpan = (coverBbox.east - coverBbox.west) / grid.cols, latSpan = (coverBbox.north - coverBbox.south) / grid.rows, pages = [];
    for (var row = 0; row < grid.rows; row++) for (var col = 0; col < grid.cols; col++) {
      var north = coverBbox.north - row * latSpan, south = north - latSpan, west = coverBbox.west + col * lonSpan, east = west + lonSpan;
      pages.push({ row: row, col: col, index: pages.length, north: north, south: south, west: west, east: east });
    }
    return pages;
  }
  function zoomForPage(widthPx, heightPx, lonSpan, latSpan) {
    var zLon = Math.log2((widthPx * 360) / (lonSpan * WORLD_TILE_SIZE));
    var zLat = Math.log2((heightPx * 360) / (latSpan * WORLD_TILE_SIZE));
    var z = Math.max(zLon, zLat);
    return isFinite(z) ? z : 15;
  }
  function pageContainsPoint(page, lon, lat, grid) {
    var lastCol = grid ? page.col === grid.cols - 1 : true;
    var lastRow = grid ? page.row === grid.rows - 1 : true;
    var inLon = lon >= page.west && (lastCol ? lon <= page.east : lon < page.east);
    var inLat = lat >= page.south && (lastRow ? lat <= page.north : lat < page.north);
    return inLon && inLat;
  }
  function assignHomePageIndex(pages, lon, lat, grid) {
    for (var i = 0; i < pages.length; i++) {
      if (pageContainsPoint(pages[i], lon, lat, grid)) return i;
    }
    var best = 0, bestD = Infinity;
    for (var j = 0; j < pages.length; j++) {
      var p = pages[j];
      var cx = (p.west + p.east) / 2, cy = (p.south + p.north) / 2;
      var d = (cx - lon) * (cx - lon) + (cy - lat) * (cy - lat);
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  }
  function addHomeMarker(map, lon, lat) {
    try {
      if (map.getSource('home-pt')) {
        if (map.getLayer('home-label')) map.removeLayer('home-label');
        if (map.getLayer('home-circle')) map.removeLayer('home-circle');
        map.removeSource('home-pt');
      }
    } catch (e) {}
    map.addSource('home-pt', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }
    });
    map.addLayer({
      id: 'home-circle', type: 'circle', source: 'home-pt',
      paint: { 'circle-radius': 10, 'circle-color': '#e11d48', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' }
    });
    map.addLayer({
      id: 'home-label', type: 'symbol', source: 'home-pt',
      layout: { 'text-field': 'HOME', 'text-size': 16, 'text-offset': [0, 1.35], 'text-font': ['Noto Sans Regular'], 'text-anchor': 'top' },
      paint: { 'text-color': '#be123c', 'text-halo-color': '#ffffff', 'text-halo-width': 2 }
    });
  }
  async function geocode(address) {
    var url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', address); url.searchParams.set('format', 'json'); url.searchParams.set('limit', '1');
    var res = await fetch(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'PrintableMapPDF/3.2 (travel-distance printable map)' } });
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
    var centerLon = (page.west + page.east) / 2;
    var centerLat = (page.south + page.north) / 2;
    var lonSpan = page.east - page.west;
    var latSpan = page.north - page.south;
    var zoom = zoomForPage(widthPx, heightPx, lonSpan, latSpan);
    map.jumpTo({ center: [centerLon, centerLat], zoom: zoom });
    applyRoadLabelScale(map, labelScale);
    if (page.hasHome) {
      addHomeMarker(map, homeLon, homeLat);
    }
    await waitForIdle(map, 15000);
    var canvas = map.getCanvas();
    if (!canvas || canvas.width < 10) throw new Error('Map canvas empty — WebGL may be unavailable on this device.');
    var nw = map.project([page.west, page.north]);
    var se = map.project([page.east, page.south]);
    var x0 = Math.max(0, Math.floor(Math.min(nw.x, se.x)));
    var y0 = Math.max(0, Math.floor(Math.min(nw.y, se.y)));
    var x1 = Math.min(canvas.width, Math.ceil(Math.max(nw.x, se.x)));
    var y1 = Math.min(canvas.height, Math.ceil(Math.max(nw.y, se.y)));
    var cw = Math.max(1, x1 - x0);
    var ch = Math.max(1, y1 - y0);
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
    var pageH = paperSize.heightMm, mapX = mapArea.margin, mapY = mapArea.margin + mapArea.header;
    for (var i = 0; i < pageCanvases.length; i++) {
      if (i > 0) pdf.addPage();
      var item = pageCanvases[i], imgData = item.canvas.toDataURL('image/jpeg', 0.92);
      pdf.setFontSize(9); pdf.setTextColor(40);
      pdf.text('Road Map - ' + place.display.split(',').slice(0, 2).join(','), mapX, mapArea.margin + 5);
      pdf.setFontSize(8); pdf.setTextColor(100);
      var pageLabel = 'Page ' + (i + 1) + ' of ' + pageCanvases.length + '  |  Row ' + (item.page.row + 1) + '/' + grid.rows + '  Col ' + (item.page.col + 1) + '/' + grid.cols;
      if (item.page.hasHome) pageLabel += '  |  * HOME';
      pdf.text(pageLabel, mapX, mapArea.margin + 10);
      if (item.page.hasHome) {
        pdf.setFontSize(9); pdf.setTextColor(190, 18, 60);
        pdf.text('* Home / start address is on this page', mapX, mapArea.margin + 14);
      }
      pdf.addImage(imgData, 'JPEG', mapX, mapY, mapArea.widthMm, mapArea.heightMm);
      pdf.setDrawColor(180); pdf.setLineWidth(0.2); pdf.rect(mapX, mapY, mapArea.widthMm, mapArea.heightMm);
      pdf.setDrawColor(0); pdf.setLineWidth(0.3);
      var mark = 3, w = mapArea.widthMm, h = mapArea.heightMm;
      pdf.line(mapX - 1, mapY, mapX - 1 - mark, mapY); pdf.line(mapX, mapY - 1, mapX, mapY - 1 - mark);
      pdf.line(mapX + w + 1, mapY, mapX + w + 1 + mark, mapY); pdf.line(mapX + w, mapY - 1, mapX + w, mapY - 1 - mark);
      pdf.line(mapX - 1, mapY + h, mapX - 1 - mark, mapY + h); pdf.line(mapX, mapY + h + 1, mapX, mapY + h + 1 + mark);
      pdf.line(mapX + w + 1, mapY + h, mapX + w + 1 + mark, mapY + h); pdf.line(mapX + w, mapY + h + 1, mapX + w, mapY + h + 1 + mark);
      var footerY = pageH - mapArea.margin - 4;
      pdf.setFontSize(7); pdf.setTextColor(90);
      pdf.text('(c) OpenStreetMap / OpenFreeMap / OSRM  |  Center ' + place.lat.toFixed(5) + ', ' + place.lon.toFixed(5) + '  |  ~1:' + scaleDenom.toLocaleString() + '  |  Print at 100%', mapX, footerY);
      pdf.text(travelLabel + (clipped ? ' (coverage clipped to max pages)' : ''), mapX, footerY + 3.5);
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
      var targetDpi = parseInt(document.getElementById('dpi').value, 10), labelScale = parseFloat(document.getElementById('labelScale').value);
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
      var paperSize = paperSizeMm(paper, orient), mapArea = mapAreaMm(paperSize), grid = chooseGrid(maxPages);
      var mapPxW = Math.round((mapArea.widthMm / 25.4) * targetDpi), mapPxH = Math.round((mapArea.heightMm / 25.4) * targetDpi);
      if (mapPxW > MAX_CANVAS_SIDE || mapPxH > MAX_CANVAS_SIDE) {
        var s = Math.min(MAX_CANVAS_SIDE / mapPxW, MAX_CANVAS_SIDE / mapPxH);
        mapPxW = Math.round(mapPxW * s); mapPxH = Math.round(mapPxH * s);
      }
      var mpd = metersPerDegree(place.lat);
      var resEq = 156543.03392 / Math.pow(2, planZoom);
      var mpp = resEq * Math.cos(deg2rad(place.lat));
      var pageWidthM = mapPxW * mpp, pageHeightM = mapPxH * mpp;
      var totalW = pageWidthM * grid.cols, totalH = pageHeightM * grid.rows;
      var travelW = (coverage.bbox.east - coverage.bbox.west) * mpd.lon;
      var travelH = (coverage.bbox.north - coverage.bbox.south) * mpd.lat;
      var coverW = Math.min(Math.max(travelW, pageWidthM), totalW);
      var coverH = Math.min(Math.max(travelH, pageHeightM), totalH);
      coverW = Math.max(coverW, pageWidthM);
      coverH = Math.max(coverH, pageHeightM);
      var clipped = coverW < travelW * 0.98 || coverH < travelH * 0.98;
      var coverBbox = {
        west: place.lon - (coverW / 2) / mpd.lon, east: place.lon + (coverW / 2) / mpd.lon,
        south: place.lat - (coverH / 2) / mpd.lat, north: place.lat + (coverH / 2) / mpd.lat
      };
      var scaleDenom = Math.round(mpp * targetDpi * 39.3701);
      var pages = buildPageGrid(coverBbox, grid);
      var homeIdx = assignHomePageIndex(pages, place.lon, place.lat, grid);
      for (var hi = 0; hi < pages.length; hi++) pages[hi].hasHome = (hi === homeIdx);
      var homePageNums = [homeIdx + 1];
      setStatus('Center: ' + place.lat.toFixed(5) + ', ' + place.lon.toFixed(5) + '\n' + travelLabel + '\nGrid: ' + grid.rows + 'x' + grid.cols + ' = ' + grid.pages + ' pages\nHome is on page: ' + homePageNums[0] + '\nCoverage: ' + (coverW / 1609.344).toFixed(2) + ' mi x ' + (coverH / 1609.344).toFixed(2) + ' mi' + (clipped ? '\nCoverage clipped to fit max pages.' : '') + '\nRendering...');
      var pageCanvases = [];
      for (var pi = 0; pi < pages.length; pi++) {
        if (cancelled) throw new Error('Cancelled');
        var page = pages[pi];
        setStatus('Rendering page ' + (pi + 1) + ' of ' + pages.length + ' (row ' + (page.row + 1) + ', col ' + (page.col + 1) + ')...\n' + travelLabel + (page.hasHome ? '\n(This page contains HOME)' : ''));
        setProgress(8 + (pi / pages.length) * 80);
        var canvas = await renderPage(page, mapPxW, mapPxH, labelScale, place.lon, place.lat);
        pageCanvases.push({ canvas: canvas, page: page });
        if (pi === 0 || page.hasHome) {
          var preview = document.getElementById('previewCanvas'), pctx = preview.getContext('2d');
          var sc = Math.min(1, 680 / canvas.width);
          preview.width = Math.round(canvas.width * sc); preview.height = Math.round(canvas.height * sc);
          pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
          document.getElementById('previewWrap').style.display = 'block';
        }
      }
      if (cancelled) throw new Error('Cancelled');
      setStatus('Assembling PDF...'); setProgress(90);
      var pdf = buildPdf({ orient: orient, paper: paper, place: place, grid: grid, pageCanvases: pageCanvases, mapArea: mapArea, paperSize: paperSize, scaleDenom: scaleDenom, travelLabel: travelLabel, clipped: clipped });
      setProgress(100);
      var fname = 'road-map_' + place.lat.toFixed(4) + '_' + place.lon.toFixed(4) + '_' + grid.rows + 'x' + grid.cols + '.pdf';
      pdf.save(fname);
      setStatus('Done! Saved ' + fname + '\n' + pageCanvases.length + ' pages · ' + travelLabel + '\nHome is on page: ' + homePageNums[0] + ' (look for red HOME marker)\nPrint at 100% scale and tape together using the row/col labels.' + (clipped ? '\nNote: coverage was reduced to fit the page limit.' : ''), clipped ? 'warn' : 'ok');
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
