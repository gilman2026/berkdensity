'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const number = new Intl.NumberFormat('en-US');
  const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const acre = 4046.8564224;
  const colors = ['#ebe6d5', '#ded5af', '#cfb478', '#c58e4b', '#b76538', '#943d28'];
  const metrics = {
    people: { field: 'POP100', bands: [0, 5, 10, 20, 40, 80], unit: 'people', legend: 'Residents per land acre', max: 100 },
    housing: { field: 'HU100', bands: [0, 2, 5, 10, 20, 40], unit: 'homes', legend: 'Housing units per land acre', max: 50 }
  };
  let map;
  let blocksLayer;
  let selectionLayer;
  let streetLayer;
  let metric = 'people';
  let selected = null;
  let data;
  let blocks;
  let streets;
  let cityAcres;
  let basemap = 'map';
  let showDensity = true;
  let basemaps;

  const dialog = byId('method-dialog');
  byId('method-open').addEventListener('click', () => dialog.showModal());
  byId('method-footer').addEventListener('click', () => dialog.showModal());
  byId('method-close').addEventListener('click', () => dialog.close());
  byId('retry').addEventListener('click', () => location.reload());

  function reportError(error) {
    console.error('Berkeley atlas:', error);
    byId('loading').hidden = true;
    byId('error-message').textContent = error instanceof Error ? error.message : String(error);
    byId('error-panel').hidden = false;
  }

  function density(feature) {
    return feature.properties.AREALAND > 0 ? feature.properties[metrics[metric].field] * acre / feature.properties.AREALAND : null;
  }

  function bandIndex(value) {
    const bands = metrics[metric].bands;
    for (let i = bands.length - 1; i >= 0; i--) {
      if (value >= bands[i]) return i;
    }
    return 0;
  }

  function blockStyle(feature) {
    const value = density(feature);
    const faint = value !== null && value < Number(byId('threshold').value);
    return {
      stroke: false,
      fillColor: value === null ? '#d6dedc' : colors[bandIndex(value)],
      fillOpacity: faint ? 0.05 : value === null ? 0 : basemap === 'satellite' ? 0.35 : 0.6
    };
  }

  function bandLabel(index) {
    const bands = metrics[metric].bands;
    return index === bands.length - 1 ? `${bands[index]}+` : `${bands[index]}-${bands[index + 1]}`;
  }

  function renderLegend() {
    byId('legend-title').textContent = metrics[metric].legend;
    byId('legend-bands').replaceChildren();
    metrics[metric].bands.forEach((start, index) => {
      const band = document.createElement('div');
      band.className = 'legend-band';
      const swatch = document.createElement('i');
      swatch.style.background = colors[index];
      const label = document.createElement('span');
      label.textContent = index === 5 ? `${start}+` : String(start);
      band.append(swatch, label);
      byId('legend-bands').append(band);
    });
    const landBlocks = blocks.filter(feature => feature.properties.AREALAND > 0);
    const counts = Array(6).fill(0);
    landBlocks.forEach(feature => counts[bandIndex(density(feature))]++);
    byId('distribution-chart').replaceChildren();
    counts.forEach((count, index) => {
      const row = document.createElement('div');
      row.className = 'hist-row';
      const label = document.createElement('span');
      label.textContent = bandLabel(index);
      const track = document.createElement('div');
      track.className = 'hist-track';
      const bar = document.createElement('div');
      bar.className = 'hist-fill';
      bar.style.background = colors[index];
      bar.style.width = `${count / landBlocks.length * 100}%`;
      track.append(bar);
      const share = document.createElement('span');
      share.textContent = `${decimal.format(count / landBlocks.length * 100)}%`;
      row.append(label, track, share);
      row.title = `${count} blocks; ${bandLabel(index)} ${metrics[metric].unit} per acre`;
      byId('distribution-chart').append(row);
    });
    byId('distribution-unit').textContent = `${metrics[metric].unit.toUpperCase()} / ACRE`;
  }

  function detailStat(value, label) {
    const stat = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = value;
    const caption = document.createElement('span');
    caption.textContent = label;
    stat.append(strong, caption);
    return stat;
  }

  function renderSelection() {
    const target = byId('selection-detail');
    target.replaceChildren();
    byId('clear-selection').hidden = !selected;
    if (!selected) {
      const paragraph = document.createElement('p');
      paragraph.className = 'empty-detail';
      paragraph.textContent = 'Click a colored block to meet the numbers behind it, or search for a street above.';
      target.append(paragraph);
      return;
    }
    const population = selected.blocks.reduce((sum, block) => sum + block.properties.POP100, 0);
    const housing = selected.blocks.reduce((sum, block) => sum + block.properties.HU100, 0);
    const acres = selected.blocks.reduce((sum, block) => sum + block.properties.AREALAND / acre, 0);
    const value = acres > 0 ? (metric === 'people' ? population : housing) / acres : null;
    const average = data.metadata[metric === 'people' ? 'population' : 'housing'] / cityAcres;
    const kind = document.createElement('p');
    kind.className = 'detail-kind';
    kind.textContent = selected.type === 'block' ? '2020 CENSUS BLOCK' : 'NEARBY-BLOCK STREET PROFILE';
    const title = document.createElement('h3');
    title.className = 'detail-title';
    title.textContent = selected.name;
    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    grid.append(
      detailStat(value === null ? 'N/A' : decimal.format(value), `${metrics[metric].unit} / land acre`),
      detailStat(number.format(population), selected.type === 'street' ? 'residents in nearby blocks' : 'resident population'),
      detailStat(number.format(housing), 'housing units (incl. vacant)'),
      detailStat(decimal.format(acres), 'land acres')
    );
    const benchmark = document.createElement('p');
    benchmark.className = 'benchmark';
    benchmark.textContent = value === null
      ? 'No land area: density cannot be calculated.'
      : `${decimal.format(value / average)}x the citywide density of ${decimal.format(average)} ${metrics[metric].unit} per land acre.`;
    const note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = selected.type === 'street'
      ? `${selected.blocks.length} whole Berkeley blocks intersect a 30-meter street buffer. This is not the street's population. Blocks may appear in other street profiles.`
      : `GEOID ${selected.blocks[0].properties.GEOID}. Population includes group quarters; housing units do not include dormitory beds.`;
    target.append(kind, title, grid, benchmark, note);
    if (selected.type === 'block' && population > housing * 8 && population > 100) {
      const caution = document.createElement('p');
      caution.className = 'benchmark';
      caution.textContent = 'Many residents, relatively few housing units. Group quarters may be part of this story; this ratio alone cannot identify a dormitory.';
      target.append(caution);
    }
  }

  function clearSelection() {
    selected = null;
    selectionLayer.clearLayers();
    streetLayer.clearLayers();
    byId('map-caption').textContent = 'Every polygon is a Census block.';
    renderSelection();
  }

  function selectBlock(feature) {
    clearSelection();
    selected = { type: 'block', name: `Block ${feature.properties.GEOID.slice(-4)}`, blocks: [feature] };
    selectionLayer.addData(feature);
    renderSelection();
    byId('map-caption').textContent = `Selected block ${feature.properties.GEOID}`;
  }

  function overlaps(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  function streetName(name) {
    return name.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
  }

  function selectStreet(name) {
    const features = streets.get(name);
    if (!features) throw new Error(`Street "${name}" was not found in the city dataset.`);
    const lines = turf.multiLineString(features.flatMap(feature => feature.geometry.coordinates));
    const buffer = turf.buffer(lines, 30, { units: 'meters', steps: 4 });
    if (!buffer) throw new Error(`Could not construct a street buffer for ${name}.`);
    const bounds = turf.bbox(buffer);
    const nearby = blocks.filter(feature => overlaps(feature.bbox, bounds) && turf.booleanIntersects(feature, buffer));
    if (!nearby.length) throw new Error(`No Berkeley Census blocks were found near ${name}.`);
    clearSelection();
    selected = { type: 'street', name: streetName(name), blocks: nearby };
    selectionLayer.addData(turf.featureCollection(nearby));
    streetLayer.addData(lines);
    byId('street-search').value = streetName(name);
    byId('search-results').replaceChildren();
    renderSelection();
    byId('map-caption').textContent = `${streetName(name)} / ${nearby.length} nearby Census blocks`;
    map.fitBounds(selectionLayer.getBounds(), { padding: [65, 65], maxZoom: 16, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches });
  }

  function runStreetSelection(name) {
    try { selectStreet(name); } catch (error) { reportError(error); }
  }

  function renderSearch() {
    const query = byId('street-search').value.trim().toLowerCase();
    const results = byId('search-results');
    results.replaceChildren();
    if (!query) return;
    const names = [...streets.keys()].filter(name => name.toLowerCase().includes(query)).sort();
    if (!names.length) {
      const message = document.createElement('p');
      message.textContent = 'No matching street. Try a shorter name, such as "Telegraph".';
      results.append(message);
      return;
    }

    names.slice(0, 8).forEach(name => {
      const button = document.createElement('button');
      button.type = 'button';
      const label = document.createElement('span');
      label.textContent = streetName(name);
      const hint = document.createElement('small');
      hint.textContent = 'Explore';
      button.append(label, hint);
      button.addEventListener('click', () => runStreetSelection(name));
      results.append(button);
    });
    if (names.length > 8) {
      const hint = document.createElement('p');
      hint.textContent = `${names.length} matches. Keep typing to narrow the list.`;
      results.append(hint);
    }
  }

  function setBasemap(next) {
    map.removeLayer(basemaps[basemap]);
    basemap = next;
    byId('basemap-status').hidden = true;
    basemaps[next].addTo(map);
    byId('map-mode').setAttribute('aria-pressed', String(next === 'map'));
    byId('satellite-mode').setAttribute('aria-pressed', String(next === 'satellite'));
    blocksLayer.setStyle(blockStyle);
  }

  function setDensityVisibility() {
    showDensity = byId('density-visible').checked;
    if (showDensity) {
      blocksLayer.addTo(map);
      selectionLayer.bringToFront();
      streetLayer.bringToFront();
    } else {
      map.removeLayer(blocksLayer);
    }
    byId('map-legend').hidden = !showDensity;
    byId('density-hidden-note').hidden = showDensity;
  }

  function setMetric(next) {
    metric = next;
    byId('people-mode').setAttribute('aria-pressed', String(next === 'people'));
    byId('housing-mode').setAttribute('aria-pressed', String(next === 'housing'));
    byId('metric-description').textContent = next === 'people'
      ? "Residents divided by the block's land area. Not people walking on the street."
      : "Housing units, including vacant units, divided by land area. Dormitory beds are not housing units.";
    byId('threshold').max = String(metrics[next].max);
    byId('threshold').value = '0';
    byId('threshold-value').textContent = 'Show all';
    byId('threshold-max').textContent = `${metrics[next].max}+ ${metrics[next].unit}/acre`;
    blocksLayer.setStyle(blockStyle);
    renderLegend();
    renderSelection();
  }

  function initialize() {
    if (!window.L || !window.turf) throw new Error('The mapping libraries could not load. Check your internet connection and reload.');
    data = window.BERKELEY_DATA;
    if (!data?.blocks?.features?.length || !data?.city?.features?.length || !data?.streets?.features?.length) {
      throw new Error('The local data file is missing or incomplete. Keep data.js alongside index.html.');
    }
    blocks = data.blocks.features;
    const population = blocks.reduce((sum, feature) => sum + feature.properties.POP100, 0);
    const housing = blocks.reduce((sum, feature) => sum + feature.properties.HU100, 0);
    const city = data.city.features[0];
    if (population !== city.properties.POP100 || housing !== city.properties.HU100 ||
        population !== data.metadata.population || housing !== data.metadata.housing ||
        blocks.length !== data.metadata.blockCount || new Set(blocks.map(feature => feature.properties.GEOID)).size !== blocks.length) {
      throw new Error('Data integrity check failed: block totals or identifiers do not match the city.');
    }
    if (blocks.some(feature => !Number.isFinite(feature.properties.POP100) || !Number.isFinite(feature.properties.HU100) ||
        !Number.isFinite(feature.properties.AREALAND) || feature.properties.POP100 < 0 ||
        feature.properties.HU100 < 0 || feature.properties.AREALAND < 0)) {
      throw new Error('Invalid population, housing, or land area in a Census block.');
    }
    cityAcres = city.properties.AREALAND / acre;
    if (!(cityAcres > 0)) throw new Error('The city land area must be positive.');
    blocks.forEach(feature => { feature.bbox = turf.bbox(feature); });
    streets = new Map();
    data.streets.features.forEach(feature => {
      const name = feature.properties.FULLNAME;
      if (!name || feature.geometry?.type !== 'MultiLineString') throw new Error('Invalid street geometry or name.');
      if (!streets.has(name)) streets.set(name, []);
      streets.get(name).push(feature);
    });
    byId('city-pop').textContent = number.format(population);
    byId('city-blocks').textContent = number.format(blocks.length);
    byId('integrity-note').textContent = `Retrieved ${data.metadata.retrievedAt}. All ${number.format(blocks.length)} Berkeley blocks total ${number.format(population)} residents and ${number.format(housing)} housing units, exactly matching the 2020 city totals.`;
    map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 11, maxZoom: 19 });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ position: 'bottomright', imperial: true, metric: false }).addTo(map);
    map.attributionControl.addAttribution('U.S. Census Bureau / City of Berkeley GIS');
    map.createPane('labels');
    map.getPane('labels').style.zIndex = '450';
    map.getPane('labels').style.pointerEvents = 'none';
    const tileRoot = 'https://services.arcgisonline.com/ArcGIS/rest/services/';
    const tileLayer = (service, attribution, options = {}) => {
      const layer = L.tileLayer(`${tileRoot}${service}/MapServer/tile/{z}/{y}/{x}`, {
        attribution, maxZoom: 19, maxNativeZoom: 16, ...options
      });
      layer.on('tileerror', event => {
        console.error('Berkeley atlas: basemap tile failed', event.tile.src);
        if (!map.hasLayer(layer)) return;
        byId('basemap-status').textContent = 'Some basemap tiles could not load. Check your connection or switch Map / Satellite. Census data remains available.';
        byId('basemap-status').hidden = false;
      });
      return layer;
    };
    const mapAttribution = 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors, GIS User Community';
    basemaps = {
      map: L.layerGroup([
        tileLayer('Canvas/World_Light_Gray_Base', mapAttribution),
        tileLayer('Canvas/World_Light_Gray_Reference', mapAttribution, { pane: 'labels' })
      ]),
      satellite: tileLayer('World_Imagery', 'Esri, Vantor, Earthstar Geographics, GIS User Community', { maxNativeZoom: 19 })
    };
    basemaps[basemap].addTo(map);
    blocksLayer = L.geoJSON(data.blocks, {
      style: blockStyle,
      onEachFeature(feature, layer) {
        layer.bindTooltip(() => {
          const value = density(feature);
          const box = document.createElement('div');
          box.textContent = `${number.format(feature.properties.POP100)} residents / ${value === null ? 'no land area' : `${decimal.format(value)} ${metrics[metric].unit} per acre`}`;
          return box;
        }, { sticky: true });
        layer.on('click', () => selectBlock(feature));
      }
    }).addTo(map);
    const boundary = L.geoJSON(data.city, { interactive: false, style: { color: '#244b43', weight: 1.5, dashArray: '5 5', fill: false, opacity: 0.65 } }).addTo(map);
    selectionLayer = L.geoJSON(null, { interactive: false, style: { color: '#244b43', weight: 2, fillColor: '#244b43', fillOpacity: 0.08 } }).addTo(map);
    streetLayer = L.geoJSON(null, { interactive: false, style: { color: '#244b43', weight: 4, opacity: 1 } }).addTo(map);
    const landBounds = L.latLngBounds([]);
    blocks.filter(feature => feature.properties.AREALAND > 0).forEach(feature => {
      landBounds.extend([[feature.bbox[1], feature.bbox[0]], [feature.bbox[3], feature.bbox[2]]]);
    });
    const cityView = () => map.fitBounds(landBounds, { paddingTopLeft: [40, 100], paddingBottomRight: [40, 100], animate: false });
    cityView();
    byId('reset-map').addEventListener('click', () => { clearSelection(); cityView(); });
    byId('clear-selection').addEventListener('click', clearSelection);
    byId('people-mode').addEventListener('click', () => setMetric('people'));
    byId('housing-mode').addEventListener('click', () => setMetric('housing'));
    byId('map-mode').addEventListener('click', () => setBasemap('map'));
    byId('satellite-mode').addEventListener('click', () => setBasemap('satellite'));
    byId('density-visible').addEventListener('change', setDensityVisibility);
    byId('street-search').addEventListener('input', renderSearch);
    byId('street-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const first = byId('search-results').querySelector('button');
        if (first) first.click();
      }
      if (event.key === 'Escape') {
        byId('street-search').value = '';
        renderSearch();
      }
    });
    byId('threshold').addEventListener('input', () => {
      const value = Number(byId('threshold').value);
      byId('threshold-value').textContent = value === 0 ? 'Show all' : `${value}+ ${metrics[metric].unit}/acre`;
      blocksLayer.setStyle(blockStyle);
    });
    document.querySelectorAll('[data-street]').forEach(button => {
      button.addEventListener('click', () => {
        runStreetSelection(button.dataset.street);
        if (matchMedia('(max-width: 800px)').matches) byId('map').scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    });
    renderLegend();
    byId('loading').hidden = true;
  }

  try { initialize(); } catch (error) { reportError(error); }
})();
