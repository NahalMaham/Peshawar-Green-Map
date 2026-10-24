/* Peshawar Green Spaces Atlas
   Data: OpenStreetMap via the Overpass API (no API key required).
   Flow: fetch() -> parse JSON -> classify -> draw on Leaflet -> filter / search. */

// ---------- 1. Configuration ----------
// Study-area bounding box: south, west, north, east (Peshawar and surroundings)
const BBOX = [33.93, 71.40, 34.07, 71.67];

// Public Overpass servers; the second is used if the first fails
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const CATEGORIES = {
  park:       { label: "Parks",               color: "#1f6f4a" },
  garden:     { label: "Gardens",             color: "#c77d0a" },
  playground: { label: "Playgrounds",         color: "#c2410c" },
  recreation: { label: "Recreation grounds",  color: "#2563a6" },
  nature:     { label: "Nature reserves",     color: "#0f766e" },
  green:      { label: "Grass and woodland",  color: "#7a9a3a" }
};

// ---------- 2. State and DOM ----------
const state = {
  features: [],                                   // parsed places
  activeCats: new Set(Object.keys(CATEGORIES)),
  query: "",
  namedOnly: false,
  nearPoint: null                                 // {lat, lng} when "near me" is used
};

const $ = (id) => document.getElementById(id);
const el = {
  search: $("search"), chips: $("chips"), named: $("namedOnly"),
  list: $("list"), count: $("statCount"), area: $("statArea"),
  status: $("status"), loader: $("loader"), error: $("error"),
  errorMsg: $("errorMsg"), nearBtn: $("nearBtn")
};

// ---------- 3. Map setup ----------
const map = L.map("map", { zoomControl: true }).setView([34.0, 71.55], 12);

const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics"
});

L.control.layers({ "Street map": osm, "Satellite": satellite }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const placesLayer = L.layerGroup().addTo(map);
let nearMarker = null;

// ---------- 4. Fetching data ----------
function buildQuery() {
  const b = BBOX.join(",");
  return `[out:json][timeout:40];
(
  way["leisure"~"^(park|garden|playground|recreation_ground|nature_reserve)$"](${b});
  way["landuse"~"^(grass|forest|recreation_ground|village_green)$"](${b});
  rel["leisure"~"^(park|garden|nature_reserve)$"](${b});
  node["leisure"~"^(park|garden|playground)$"](${b});
);
out geom tags;`;
}

async function fetchOverpass(query) {
  let lastError;
  for (const url of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });
      if (!res.ok) throw new Error("Server answered with status " + res.status);
      return await res.json();
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// ---------- 5. Parsing ----------
function classify(tags) {
  if (tags.leisure === "park") return "park";
  if (tags.leisure === "garden") return "garden";
  if (tags.leisure === "playground") return "playground";
  if (tags.leisure === "nature_reserve") return "nature";
  if (tags.leisure === "recreation_ground" || tags.landuse === "recreation_ground") return "recreation";
  return "green"; // landuse = grass, forest, village_green
}

// Polygon area in square metres (shoelace formula on a local flat projection)
function polygonArea(latlngs) {
  if (latlngs.length < 3) return 0;
  const lat0 = latlngs[0][0] * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  let sum = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const [la1, lo1] = latlngs[i];
    const [la2, lo2] = latlngs[(i + 1) % latlngs.length];
    sum += (lo1 * kx) * (la2 * ky) - (lo2 * kx) * (la1 * ky);
  }
  return Math.abs(sum) / 2;
}

function parseElements(elements) {
  const out = [];
  for (const e of elements) {
    const tags = e.tags || {};
    const cat = classify(tags);
    let shape = null, center, areaM2 = 0;

    if (e.type === "way" && e.geometry && e.geometry.length > 2) {
      const latlngs = e.geometry.map((g) => [g.lat, g.lon]);
      shape = L.polygon(latlngs);
      areaM2 = polygonArea(latlngs);
      center = shape.getBounds().getCenter();
    } else if (e.type === "node") {
      center = L.latLng(e.lat, e.lon);
      shape = L.circleMarker(center, { radius: 7 });
    } else if (e.type === "relation" && e.bounds) {
      const bnd = L.latLngBounds([e.bounds.minlat, e.bounds.minlon], [e.bounds.maxlat, e.bounds.maxlon]);
      center = bnd.getCenter();
      shape = L.rectangle(bnd);                  // simple outline for multipolygon relations
      areaM2 = 0;                                // not computed for relations
    }
    if (!shape) continue;

    const f = {
      id: e.type + "/" + e.id, osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      name: tags.name || tags["name:en"] || "", cat, tags, areaM2, center, shape
    };
    styleShape(f);
    shape.bindPopup(() => popupHtml(f), { maxWidth: 300 });
    shape.on("mouseover", () => shape.setStyle && shape.setStyle({ weight: 3, fillOpacity: 0.6 }));
    shape.on("mouseout", () => styleShape(f));
    out.push(f);
  }
  return out;
}

function styleShape(f) {
  const color = CATEGORIES[f.cat].color;
  f.shape.setStyle({ color, weight: 1.5, fillColor: color, fillOpacity: 0.4 });
}

// ---------- 6. Popup ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function popupHtml(f) {
  const c = CATEGORIES[f.cat];
  const rows = [];
  if (f.areaM2) rows.push(["Area", formatArea(f.areaM2)]);
  if (f.tags.access) rows.push(["Access", f.tags.access]);
  if (f.tags.opening_hours) rows.push(["Opening hours", f.tags.opening_hours]);
  if (f.tags.operator) rows.push(["Operator", f.tags.operator]);
  if (f.tags.leisure || f.tags.landuse) rows.push(["OSM tag", f.tags.leisure ? "leisure=" + f.tags.leisure : "landuse=" + f.tags.landuse]);
  if (state.nearPoint) rows.push(["Distance from you", (map.distance(state.nearPoint, f.center) / 1000).toFixed(2) + " km"]);

  return `<div class="pop">
    <h3>${esc(f.name || "Unnamed " + c.label.toLowerCase())}</h3>
    <span class="tag" style="background:${c.color}">${esc(c.label)}</span>
    <table>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join("")}</table>
    <p style="margin:8px 0 0"><a href="${f.osmUrl}" target="_blank" rel="noopener">View on OpenStreetMap</a></p>
  </div>`;
}

function formatArea(m2) {
  return m2 >= 10000 ? (m2 / 10000).toFixed(2) + " ha" : Math.round(m2).toLocaleString() + " m\u00b2";
}

// ---------- 7. Filtering and rendering ----------
function visibleFeatures() {
  const q = state.query.trim().toLowerCase();
  let list = state.features.filter((f) =>
    state.activeCats.has(f.cat) &&
    (!state.namedOnly || f.name) &&
    (!q || f.name.toLowerCase().includes(q))
  );
  if (state.nearPoint) {
    list = list
      .map((f) => ({ f, d: map.distance(state.nearPoint, f.center) }))
      .filter((x) => x.d <= 3000)               // within 3 km of the user
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f);
  } else {
    list.sort((a, b) => b.areaM2 - a.areaM2);
  }
  return list;
}

function render() {
  const shown = visibleFeatures();
  placesLayer.clearLayers();
  shown.forEach((f) => placesLayer.addLayer(f.shape));

  el.count.textContent = shown.length.toLocaleString();
  el.area.textContent = (shown.reduce((s, f) => s + f.areaM2, 0) / 10000).toFixed(1);

  el.list.innerHTML = "";
  if (!shown.length) {
    el.list.innerHTML = '<li class="empty">No places match. Try a different name or turn on more types.</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  shown.slice(0, 150).forEach((f) => {
    const c = CATEGORIES[f.cat];
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<span class="dot" style="background:${c.color}"></span>
      <span><span class="name">${esc(f.name || "Unnamed " + c.label.toLowerCase())}</span>
      <span class="meta">${esc(c.label)}${f.areaM2 ? " \u2022 " + formatArea(f.areaM2) : ""}</span></span>`;
    btn.addEventListener("click", () => focusFeature(f));
    li.appendChild(btn);
    frag.appendChild(li);
  });
  el.list.appendChild(frag);
  if (shown.length > 150) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `Showing the first 150 of ${shown.length}. Use search or filters to narrow down.`;
    el.list.appendChild(li);
  }
}

function focusFeature(f) {
  if (f.shape.getBounds && f.areaM2) map.fitBounds(f.shape.getBounds(), { maxZoom: 17, padding: [40, 40] });
  else map.setView(f.center, 17);
  f.shape.openPopup(f.center);
}

// ---------- 8. UI wiring ----------
function buildChips() {
  Object.entries(CATEGORIES).forEach(([key, c]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("aria-pressed", "true");
    b.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.label}`;
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      on ? state.activeCats.add(key) : state.activeCats.delete(key);
      render();
    });
    el.chips.appendChild(b);
  });
}

el.search.addEventListener("input", () => { state.query = el.search.value; render(); });
el.named.addEventListener("change", () => { state.namedOnly = el.named.checked; render(); });

el.nearBtn.addEventListener("click", () => {
  if (!navigator.geolocation) { el.status.textContent = "Your browser does not support location."; return; }
  el.status.textContent = "Finding your location...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.nearPoint = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (nearMarker) map.removeLayer(nearMarker);
      nearMarker = L.marker(state.nearPoint).addTo(map).bindPopup("You are here");
      map.setView(state.nearPoint, 14);
      el.status.textContent = "Showing places within 3 km of you, nearest first.";
      render();
    },
    () => { el.status.textContent = "Location was blocked. Allow location access in the browser and try again."; },
    { timeout: 10000 }
  );
});

$("resetBtn").addEventListener("click", () => {
  state.activeCats = new Set(Object.keys(CATEGORIES));
  state.query = ""; state.namedOnly = false; state.nearPoint = null;
  el.search.value = ""; el.named.checked = false;
  el.chips.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", "true"));
  if (nearMarker) { map.removeLayer(nearMarker); nearMarker = null; }
  el.status.textContent = "";
  render();
  const all = L.featureGroup(state.features.map((f) => f.shape));
  if (state.features.length) map.fitBounds(all.getBounds(), { padding: [30, 30] });
});

$("retryBtn").addEventListener("click", loadData);

// ---------- 9. Load data (with loading + error states) ----------
async function loadData() {
  el.error.hidden = true;
  el.loader.hidden = false;
  try {
    const json = await fetchOverpass(buildQuery());
    if (!json.elements) throw new Error("The API response had no data.");
    state.features = parseElements(json.elements);
    if (!state.features.length) throw new Error("No green spaces were returned for this area.");
    el.status.textContent = `Loaded ${state.features.length} places from OpenStreetMap.`;
    render();
  } catch (err) {
    el.errorMsg.textContent = "Could not load data from the Overpass API (" +
      (err.name === "AbortError" ? "request timed out" : err.message) +
      "). Check your connection and try again.";
    el.error.hidden = false;
  } finally {
    el.loader.hidden = true;
  }
}

buildChips();
loadData();