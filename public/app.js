// client app.js
const $ = (id) => document.getElementById(id);
let currentTimeline = [];
let animationFrameId = null;
let idx = 0;
let p5Sketch = null;

// ✨ --- MAP INITIALIZATION AND LOGIC ---
let map = null;
let marker = null;
const mapModal = $("map-modal");
const latInput = $("lat");
const lonInput = $("lon");

function initMap() {
  if (map) return; // Only initialize once

  map = L.map("map").setView([20, 0], 2); // Center on the world

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Initial marker position from input fields
  const initialLatLng = [
    parseFloat(latInput.value),
    parseFloat(lonInput.value),
  ];
  marker = L.marker(initialLatLng, { draggable: true }).addTo(map);

  // Update inputs when marker is dragged
  marker.on("dragend", function (e) {
    const latLng = e.target.getLatLng();
    updateCoords(latLng.lat, latLng.lng);
  });

  // Move marker to location on map click
  map.on("click", function (e) {
    marker.setLatLng(e.latlng);
    updateCoords(e.latlng.lat, e.latlng.lng);
  });
}

function updateCoords(lat, lon) {
  latInput.value = lat.toFixed(5);
  lonInput.value = lon.toFixed(5);
}

// Modal open/close logic
$("open-map").onclick = () => {
  mapModal.style.display = "flex";
  initMap();
  // Invalidate map size to ensure tiles load correctly after being hidden
  setTimeout(() => map.invalidateSize(), 10);
};

$("close-map").onclick = () => {
  mapModal.style.display = "none";
};
// ✨ --- END OF MAP LOGIC ---

$("geo").onclick = () => {
  if (!navigator.geolocation) return alert("Geolocation not supported");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      updateCoords(lat, lon);
      // Also update the map marker if the map has been initialized
      if (map && marker) {
        const newLatLng = L.latLng(lat, lon);
        marker.setLatLng(newLatLng);
        map.panTo(newLatLng);
      }
    },
    (err) => alert(err.message),
  );
};

// Simple fade-in effect for elements
const reveals = document.querySelectorAll(".reveal, .card, .highlight");
reveals.forEach((element) => {
  element.style.opacity = "1";
  element.style.transform = "translateY(0)";
});

// Dashboard button functionality
$("dashboard-btn").onclick = () => {
  // Scroll to app section
  document.querySelector(".app-section").scrollIntoView({
    behavior: "smooth",
  });
};

$("run").onclick = async () => {
  const statusEl = $("status");
  try {
    statusEl.textContent = "Fetching…";
    statusEl.style.color = "";
    $("run").disabled = true;

    if (p5Sketch) {
      p5Sketch.remove();
    }

    const lat = parseFloat($("lat").value);
    const lon = parseFloat($("lon").value);
    const crop = $("crop").value;

    const r = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, crop }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Simulation failed");

    // All the KPI and score UI updates are correct and remain the same.
    $("kTemp").textContent = isFinite(data.climate.tempC)
      ? data.climate.tempC.toFixed(1)
      : "—";
    $("kRain").textContent = isFinite(data.climate.annualRainMm)
      ? data.climate.annualRainMm.toFixed(0)
      : "—";
    $("kSolar").textContent = isFinite(data.climate.solarMJm2day)
      ? data.climate.solarMJm2day.toFixed(1)
      : "—";
    $("kRH").textContent = isFinite(data.climate.rhPct)
      ? data.climate.rhPct.toFixed(0)
      : "—";
    $("kWind").textContent = isFinite(data.climate.windMps)
      ? data.climate.windMps.toFixed(1)
      : "—";
    $("kPh").textContent =
      data.soil.ph != null && isFinite(data.soil.ph)
        ? data.soil.ph.toFixed(1)
        : "—";
    $("kClay").textContent =
      data.soil.clay != null && isFinite(data.soil.clay)
        ? data.soil.clay.toFixed(0)
        : "—";
    $("kSilt").textContent =
      data.soil.silt != null && isFinite(data.soil.silt)
        ? data.soil.silt.toFixed(0)
        : "—";
    $("kSand").textContent =
      data.soil.sand != null && isFinite(data.soil.sand)
        ? data.soil.sand.toFixed(0)
        : "—";
    $("srcPower").href = data.sources.power;
    $("srcSoil").href = data.sources.soilgrids;
    const badge = $("badge");
    badge.className = "badge " + data.status;
    badge.textContent = data.status.toUpperCase();
    $("score").textContent = data.score;
    $("bar").style.width = data.score + "%";
    const pct = (v) => (v * 100).toFixed(0) + "%";
    $("fTemp").textContent = pct(data.fits.temperature);
    $("fRain").textContent = pct(data.fits.rainfall);
    $("fSolar").textContent = pct(data.fits.solar);
    $("fSoil").textContent = pct(data.fits.soil);
    const limitsBox = $("limitsBox");
    if (!data.limits || !data.limits.length) {
      limitsBox.style.display = "none";
    } else {
      limitsBox.style.display = "flex";
      $("limits").textContent = data.limits.join("; ");
    }

    // Create the generative art sketch
    const sketch = function (p) {
      let overallFits = data.fits;

      const healthyColor = p.color(122, 182, 136);
      const deadColor = p.color(139, 69, 19, 150);

      p.setup = function () {
        p.createCanvas(300, 200).parent("canvas-container");
        p.angleMode(p.DEGREES);
        p.noLoop();
      };

      p.drawPlant = function (frame) {
        p.clear();
        p.resetMatrix();

        p.translate(p.width / 2, p.height);

        const { biomass, alive } = frame;
        const overallHealth = (overallFits.soil + overallFits.rainfall) / 2;

        const plantColor = alive
          ? p.lerpColor(deadColor, healthyColor, overallHealth)
          : deadColor;
        const angle = 20 + overallFits.solar * 25;
        const trunkLength = 15 + biomass * 50;
        const maxDepth = Math.floor(biomass * 6) + 1;

        p.stroke(plantColor);
        branch(trunkLength, 1);

        function branch(len, depth) {
          if (depth > maxDepth) return;

          p.strokeWeight(Math.max(1, (maxDepth - depth + 1) * 0.8));
          p.line(0, 0, 0, -len);
          p.translate(0, -len);

          p.push();
          p.rotate(angle);
          branch(len * 0.75, depth + 1);
          p.pop();

          p.push();
          p.rotate(-angle);
          branch(len * 0.75, depth + 1);
          p.pop();
        }
      };
    };

    p5Sketch = new p5(sketch);

    currentTimeline = data.timeline || [];
    idx = 0;
    updateFrame();

    statusEl.textContent = "Ready ✅";
  } catch (e) {
    console.error(e);
    const errorMessage = e.message || "An unknown error occurred.";
    statusEl.textContent = `Error: ${errorMessage} ❌`;
    statusEl.style.color = "var(--bad)";
  } finally {
    $("run").disabled = false;
  }
};

function updateFrame() {
  if (!currentTimeline.length || !p5Sketch) return;
  const frame = currentTimeline[idx];
  $("day").textContent = frame.day;
  $("stage").textContent = frame.stage;

  p5Sketch.drawPlant(frame);
}

let lastFrameTime = 0;
const frameInterval = 120; // ms per frame

function animate(timestamp) {
  if (!lastFrameTime) lastFrameTime = timestamp;
  const elapsed = timestamp - lastFrameTime;

  if (elapsed > frameInterval) {
    lastFrameTime = timestamp;
    idx = Math.min(currentTimeline.length - 1, idx + 1);
    updateFrame();
  }

  if (idx < currentTimeline.length - 1) {
    animationFrameId = requestAnimationFrame(animate);
  }
}

$("play").onclick = () => {
  if (!currentTimeline.length) return;
  cancelAnimationFrame(animationFrameId);
  if (idx >= currentTimeline.length - 1) {
    idx = 0;
  }
  lastFrameTime = 0;
  animationFrameId = requestAnimationFrame(animate);
};

$("pause").onclick = () => {
  cancelAnimationFrame(animationFrameId);
};
