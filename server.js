// server.js — Express backend
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// ✨ FIX: In-memory cache to store crop data from Gemini
const cropDataCache = new Map();

// Configuration for simulation parameters
const SIMULATION_CONSTANTS = {
  WEIGHTS: {
    temperature: 0.35,
    rainfall: 0.3,
    solar: 0.15,
    soil: 0.2,
  },
  GROWTH: {
    baseRate: 0.012,
    envFactor: 0.018,
    stressThreshold: 0.6,
    decayFactor: 0.04,
  },
  SOIL: {
    socContributionFactor: 150,
    maxSocBonus: 0.2,
    texturePenalty: 0.2,
  },
};

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// helper: mean of object values
const meanOfObj = (obj = {}) => {
  const vals = Object.values(obj || {});
  if (!vals.length) return NaN;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

// ---------- Climate (NASA POWER) ----------
async function fetchClimate(lat, lon) {
  const base = "https://power.larc.nasa.gov/api/temporal/climatology/point";
  const params = new URLSearchParams({
    parameters: ["T2M", "PRECTOTCORR", "ALLSKY_SFC_SW_DWN", "RH2M", "WS10M"].join(","),
    community: "AG",
    latitude: String(lat),
    longitude: String(lon),
    format: "JSON",
  });

  const url = `${base}?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`POWER fetch failed (${r.status})`);
  const data = await r.json();
  const p = data?.properties?.parameter || {};

  const tempC = meanOfObj(p.T2M || {});
  const rainMmPerDay = meanOfObj(p.PRECTOTCORR || {});
  const solar = meanOfObj(p.ALLSKY_SFC_SW_DWN || {});
  const rh = meanOfObj(p.RH2M || {});
  const wind = meanOfObj(p.WS10M || {});
  const annualRainMm = Math.round((rainMmPerDay || 0) * 365);

  return {
    source: url,
    tempC,
    rainMmPerDay,
    annualRainMm,
    solarMJm2day: solar,
    rhPct: rh,
    windMps: wind,
  };
}

// ---------- Soil (SoilGrids) ----------
async function fetchSoil(lat, lon) {
  const base = "https://rest.isric.org/soilgrids/v2.0/properties/query";
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    property: ["phh2o", "soc", "clay", "silt", "sand"].join(","),
    depth: "sl1",
    value: "mean",
  });
  const url = `${base}?${params.toString()}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const errText = await r.text();
      console.error("SoilGrids error:", errText);
      throw new Error(`SoilGrids fetch failed (${r.status})`);
    }
    const data = await r.json();
    const props = (data?.properties || {}).layers || [];

    const getVal = (key) => {
      const layer = props.find((l) => l.name === key);
      const v = layer?.depths?.[0]?.values?.mean;
      return v != null ? v : null;
    };

    return {
      source: url,
      ph: getVal("phh2o"),
      soc: getVal("soc"),
      clay: getVal("clay"),
      silt: getVal("silt"),
      sand: getVal("sand"),
    };
  } catch (err) {
    console.error("SoilGrids fetch failed:", err.message);
    return { ph: null, soc: null, clay: null, silt: null, sand: null, source: url };
  }
}

// ---------- Gemini helper to fetch all crop data ----------
async function getCropDataFromGemini(cropName) {
  // ✨ FIX: Check the cache first
  if (cropDataCache.has(cropName)) {
    console.log(`CACHE HIT: Reusing data for "${cropName}".`);
    return cropDataCache.get(cropName);
  }
  console.log(`CACHE MISS: Fetching new data for "${cropName}" from Gemini API.`);

  if (!process.env.GEMINI_API_KEY) {
      console.error("Gemini API key is missing.");
      return null;
  }
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = client.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const prompt = `Provide conservative agronomic thresholds for growing ${cropName} as strict JSON ONLY with keys:
{"temperatureC":{"min":..,"max":..,"idealMin":..,"idealMax":..},
 "annualRainfallMm":{"min":..,"max":..,"idealMin":..,"idealMax":..},
 "solarMJm2day":{"min":..,"max":..,"idealMin":..,"idealMax":..},
 "soilPh":{"min":..,"max":..,"idealMin":..,"idealMax":..},
 "soilTexture":{"clayMax":..,"sandMax":..}}.
The response must be only the JSON object, with no markdown formatting, comments, or explanations.`;

    const resp = await model.generateContent(prompt);
    const parsed = JSON.parse(resp.response.text());
    
    if (!parsed.temperatureC || !parsed.soilPh || !parsed.soilTexture) {
        throw new Error("Invalid JSON structure received from Gemini.");
    }
    
    // ✨ FIX: Save the new data to the cache before returning
    cropDataCache.set(cropName, parsed);
    console.log(`CACHE SET: Saved new data for "${cropName}".`);

    return parsed;
  } catch (e) {
    console.error(`Gemini helper error for crop "${cropName}":`, e?.message || e);
    return null;
  }
}

// ---------- Simulation endpoint ----------
app.post("/api/simulate", async (req, res) => {
  try {
    const { lat, lon, crop } = req.body || {};
    if (!isFinite(lat) || !isFinite(lon) || !crop)
      return res.status(400).json({ error: "lat, lon, and crop are required" });

    const reqs = await getCropDataFromGemini(crop);
    if (!reqs) {
      return res.status(404).json({ error: `Could not find agronomic data for "${crop}". Please check the spelling or try another crop.` });
    }

    const [climR, soilR] = await Promise.all([fetchClimate(lat, lon), fetchSoil(lat, lon)]);

    const ph = soilR?.ph ?? NaN;
    const clay = soilR?.clay ?? NaN;
    const sand = soilR?.sand ?? NaN;
    const silt = soilR?.silt ?? NaN;
    const soc = soilR?.soc ?? NaN;

    function rangeFit(val, r) {
      if (!isFinite(val) || !r) return 0.5;
      if (val < r.min || val > r.max) return 0;
      if (val >= r.idealMin && val <= r.idealMax) return 1;
      const dist = val < r.idealMin ? r.idealMin - val : val - r.idealMax;
      const span = val < r.idealMin ? r.idealMin - r.min : r.max - r.idealMax;
      const penalty = Math.min(1, dist / span);
      return 1 - 0.6 * penalty;
    }

    const tFit = rangeFit(climR.tempC, reqs.temperatureC);
    const rFit = rangeFit(climR.annualRainMm, reqs.annualRainfallMm);
    const sFit = rangeFit(climR.solarMJm2day, reqs.solarMJm2day);

    const texturePenalty = () => {
      let p = 0;
      if (isFinite(clay) && clay > reqs.soilTexture.clayMax) p += SIMULATION_CONSTANTS.SOIL.texturePenalty;
      if (isFinite(sand) && sand > reqs.soilTexture.sandMax) p += SIMULATION_CONSTANTS.SOIL.texturePenalty;
      return p;
    };

    const phFit = rangeFit(ph, reqs.soilPh);
    const socBonus = isFinite(soc) ? Math.min(SIMULATION_CONSTANTS.SOIL.maxSocBonus, soc / SIMULATION_CONSTANTS.SOIL.socContributionFactor) : 0;
    const soilQuality = Math.max(0, Math.min(1, phFit - texturePenalty() + socBonus));

    // timeline simulation
    const days = 120;
    const stageMarkers = { germination: 7, vegetative: 45, flowering: 80, grainfill: 110 };

    const w = SIMULATION_CONSTANTS.WEIGHTS;
    const envScore = tFit * w.temperature + rFit * w.rainfall + sFit * w.solar + soilQuality * w.soil;
    const stress = 1 - envScore;

    const timeline = [];
    let biomass = 0;
    let alive = true;
    for (let d = 1; d <= days; d++) {
      const g = SIMULATION_CONSTANTS.GROWTH;
      const growthRate = g.baseRate + g.envFactor * envScore;
      const decay = stress > g.stressThreshold ? (stress - g.stressThreshold) * g.decayFactor : 0;
      biomass = Math.max(0, Math.min(1, biomass + growthRate - decay));

      const minRain = reqs.annualRainfallMm?.min ?? 400;
      const shock = climR.annualRainMm < minRain ? 0.003 : 0;
      biomass = Math.max(0, biomass - shock);

      if (biomass === 0 && d > 20 && stress > 0.7) alive = false;

      const stage =
        d < stageMarkers.germination
          ? "pre-germination"
          : d < stageMarkers.vegetative
          ? "germination"
          : d < stageMarkers.flowering
          ? "flowering"
          : "maturity";

      timeline.push({ day: d, biomass: Number(biomass.toFixed(3)), stage, alive });
    }

    const finalScore = Math.round(envScore * 100);
    const status =
      !alive && timeline[days - 1].biomass < 0.2
        ? "fail"
        : finalScore < 60
        ? "struggle"
        : finalScore < 80
        ? "good"
        : "great";

    const limits = [];
    if (tFit < 0.4) limits.push("Temperature outside comfortable range");
    if (rFit < 0.4) limits.push("Insufficient or excessive rainfall");
    if (sFit < 0.4) limits.push("Suboptimal solar radiation");
    if (phFit < 0.5) limits.push("Soil pH unsuitable");
    if (isFinite(clay) && clay > reqs.soilTexture.clayMax) limits.push("Soil too clayey (poor drainage)");
    if (isFinite(sand) && sand > reqs.soilTexture.sandMax) limits.push("Soil too sandy (low water retention)");

        res.json({
      score: finalScore,
      status,
      timeline,
      fits: {
        temperature: tFit,
        rainfall: rFit,
        solar: sFit,
        soil: soilQuality,
      },
      limits,
      climate: climR,
      soil: soilR,
      sources: {
        power: climR.source,
        soilgrids: soilR.source,
      },
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Simulation failed" });
  }
});

// serve
app.listen(PORT, () => console.log(`⚡ SDG15 Crop Sim running on http://localhost:${PORT}`));
