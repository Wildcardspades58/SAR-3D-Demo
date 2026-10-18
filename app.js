import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------
const state = {
  mode: "xray", // "optical" | "sar" | "xray"
  wipeNormalized: 0.5, // 0..1 across [-10, +10] world X
  cursorWipeEnabled: false,
  vectorsVisible: true,
  categoryVisible: {
    aircraft_sector: true,
    aircraft_component: true,
    hangar: true,
    infrastructure: true,
  },
  worldSizeX: 20.0,
  worldSizeZ: 20.0,
  manifest: null,
  vectorsData: null,
  activeAnnotationIndex: 0,
  hoveredVectorEntry: null,
  selectedVectorEntry: null,
  tourActive: false,
  tourPaused: false,
  tourStepIndex: 0,
  cameraTransition: null,
};

const VECTOR_COLORS = {
  aircraft_sector: {
    hex: 0xff9900,
    hoverHex: 0xffe066,
    css: "#ff9900",
    label: "INDIVIDUAL AIRFRAME",
    badgeClass: "vec-aircraft-badge",
    baseOpacity: 0.14,
    hoverOpacity: 0.42,
    lineWidth: 1.85,
    extrudeHeight: 0.035,
  },
  aircraft_component: {
    hex: 0xc084fc,
    hoverHex: 0xf0abfc,
    css: "#c084fc",
    label: "AIRCRAFT COMPONENT",
    badgeClass: "vec-hangar-badge",
    baseOpacity: 0.22,
    hoverOpacity: 0.55,
    lineWidth: 2.1,
    extrudeHeight: 0.048,
  },
  hangar: {
    hex: 0x00e5ff,
    hoverHex: 0x7df9ff,
    css: "#00e5ff",
    label: "HANGAR / FACILITY",
    badgeClass: "vec-hangar-badge",
    baseOpacity: 0.10,
    hoverOpacity: 0.34,
    lineWidth: 1.8,
    extrudeHeight: 0.055,
  },
  infrastructure: {
    hex: 0x8899a6,
    hoverHex: 0xcbd5e1,
    css: "#8899a6",
    label: "INFRASTRUCTURE / TARMAC",
    badgeClass: "vec-infra-badge",
    baseOpacity: 0.05,
    hoverOpacity: 0.22,
    lineWidth: 1.35,
    extrudeHeight: 0.02,
  },
};

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const canvas = document.getElementById("webgl-canvas");
const css2dContainer = document.getElementById("css2d-layer");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingBar = document.getElementById("loading-bar");
const loadingStatus = document.getElementById("loading-status");

const xrayControls = document.getElementById("xray-controls");
const wipeSlider = document.getElementById("wipe-slider");
const cursorWipeCheckbox = document.getElementById("cursor-wipe-checkbox");

const inspectorCard = document.getElementById("inspector-card");
const inspCode = document.getElementById("insp-code");
const inspTitle = document.getElementById("insp-title");
const inspSubtitle = document.getElementById("insp-subtitle");
const inspDesc = document.getElementById("insp-desc");
const inspMetrics = document.getElementById("insp-metrics");

const vectorTooltip = document.getElementById("vector-tooltip");
const ttCatDot = document.getElementById("tt-cat-dot");
const ttCategory = document.getElementById("tt-category");
const ttName = document.getElementById("tt-name");
const ttSub = document.getElementById("tt-sub");

const aboutModalBackdrop = document.getElementById("about-modal-backdrop");

const tourBanner = document.getElementById("tour-banner");
const tourStepBadge = document.getElementById("tour-step-index");
const tourStepTitle = document.getElementById("tour-step-title");
const tourStepCaption = document.getElementById("tour-step-caption");
const tourPauseBtn = document.getElementById("tour-pause");

const cursorCoordsEl = document.getElementById("cursor-coords");
const fpsCounterEl = document.getElementById("fps-counter");

function setProgress(pct, message) {
  if (loadingBar) loadingBar.style.width = `${pct}%`;
  if (loadingStatus) loadingStatus.textContent = message;
}

// ---------------------------------------------------------------------------
// Scene, Camera, WebGLRenderer, CSS2DRenderer & Post-Processing
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d14);
scene.fog = new THREE.FogExp2(0x0a0d14, 0.022);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0.0, 9.5, 13.5);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;

const labelRenderer = new CSS2DRenderer({ element: css2dContainer });
labelRenderer.setSize(window.innerWidth, window.innerHeight);

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,
  0.35,
  0.68
);
composer.addPass(bloomPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.485;
controls.minDistance = 1.2;
controls.maxDistance = 36.0;
controls.target.set(0, 0, 0);

controls.addEventListener("start", () => {
  if (state.tourActive) {
    stopGuidedTour();
  }
});

// ---------------------------------------------------------------------------
// Aerospace Grid Reference & Solar Lighting
// ---------------------------------------------------------------------------
const gridHelper = new THREE.GridHelper(28, 28, 0x1e3a5f, 0x111c2d);
gridHelper.position.y = -0.32;
scene.add(gridHelper);

const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.85);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff7ed, 2.15);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 45;
const d = 12;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
scene.add(sunLight);

function updateSunElevation(elevDeg, azimuthDeg = 152) {
  const phi = THREE.MathUtils.degToRad(90 - elevDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  const r = 18;
  sunLight.position.set(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}
updateSunElevation(38);

// ---------------------------------------------------------------------------
// Spatial Clipping Planes & Glowing X-Ray Laser Divider
// ---------------------------------------------------------------------------
const opticalClipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.0);
const sarClipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.0);

const wipeDividerGroup = new THREE.Group();
const wipeLineGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, -0.3, -10.0),
  new THREE.Vector3(0, 0.45, -10.0),
  new THREE.Vector3(0, 0.45, 10.0),
  new THREE.Vector3(0, -0.3, 10.0),
]);
const wipeLineMat = new THREE.LineBasicMaterial({
  color: 0x38bdf8,
  transparent: true,
  opacity: 0.9,
});
const wipeLaserLine = new THREE.Line(wipeLineGeo, wipeLineMat);
wipeDividerGroup.add(wipeLaserLine);

const wipePlaneGeo = new THREE.PlaneGeometry(20.0, 1.1);
wipePlaneGeo.rotateY(Math.PI / 2);
const wipePlaneMat = new THREE.MeshBasicMaterial({
  color: 0x2dd4bf,
  transparent: true,
  opacity: 0.09,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const wipeCurtain = new THREE.Mesh(wipePlaneGeo, wipePlaneMat);
wipeCurtain.position.y = 0.15;
wipeDividerGroup.add(wipeCurtain);
scene.add(wipeDividerGroup);

// ---------------------------------------------------------------------------
// Layer References
// ---------------------------------------------------------------------------
let sarPointCloud = null;
let sarPointsMaterial = null;
let terrainMeshGroup = null;
let terrainMeshForRaycast = null;

const vectorOverlayGroup = new THREE.Group();
vectorOverlayGroup.name = "VectorOverlays";
scene.add(vectorOverlayGroup);

const vectorCategoryGroups = {
  aircraft_sector: new THREE.Group(),
  aircraft_component: new THREE.Group(),
  hangar: new THREE.Group(),
  infrastructure: new THREE.Group(),
};
Object.values(vectorCategoryGroups).forEach((g) => vectorOverlayGroup.add(g));

const vectorPickableMeshes = [];
const vectorEntriesByMeshUuid = new Map();
const allLine2Materials = [];
const pinElements = [];

function createRadarSpriteTexture() {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(255, 255, 255, 1.0)");
  grad.addColorStop(0.35, "rgba(180, 245, 255, 0.85)");
  grad.addColorStop(0.7, "rgba(56, 189, 248, 0.25)");
  grad.addColorStop(1.0, "rgba(0, 0, 0, 0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// 3D Vector Overlay Builder (THREE.Line2 + Extruded/Draped Fill Meshes)
// ---------------------------------------------------------------------------
function buildVectorOverlays(vectorsPayload) {
  const features = vectorsPayload.features || [];
  const acCount = vectorsPayload.detected_aircraft_count || features.filter((f) => f.category === "aircraft_sector").length;
  const compCount = vectorsPayload.detected_component_count || features.filter((f) => f.category === "aircraft_component").length;
  const hgCount = vectorsPayload.hangar_count || features.filter((f) => f.category === "hangar").length;

  const countBadge = document.getElementById("vec-count-badge");
  if (countBadge) countBadge.textContent = String(acCount);
  const elAc = document.getElementById("inv-aircraft-count");
  if (elAc) elAc.textContent = String(acCount);
  const elComp = document.getElementById("inv-comp-count");
  if (elComp) elComp.textContent = String(compCount);
  const elHg = document.getElementById("inv-hangar-count");
  if (elHg) elHg.textContent = String(hgCount);

  const viewportResolution = new THREE.Vector2(window.innerWidth, window.innerHeight);

  features.forEach((feat) => {
    const cat = feat.category in VECTOR_COLORS ? feat.category : "infrastructure";
    const style = VECTOR_COLORS[cat];
    const coords = feat.coordinates || [];
    if (coords.length < 4) return;

    const catGroup = vectorCategoryGroups[cat];
    const featGroup = new THREE.Group();

    // 1. Primary Terrain-Draped Neon Boundary using THREE.Line2
    const flatPositions = [];
    for (let i = 0; i < coords.length; i++) {
      flatPositions.push(coords[i][0], coords[i][1], coords[i][2]);
    }

    const lineGeo = new LineGeometry();
    lineGeo.setPositions(flatPositions);

    const lineMat = new LineMaterial({
      color: style.hex,
      linewidth: style.lineWidth,
      transparent: true,
      opacity: cat === "infrastructure" ? 0.65 : 0.92,
      resolution: viewportResolution,
      dashed: false,
    });
    allLine2Materials.push(lineMat);

    const boundaryLine = new Line2(lineGeo, lineMat);
    boundaryLine.computeLineDistances();
    boundaryLine.renderOrder = 12;
    featGroup.add(boundaryLine);

    // 2. Subtle 3D Extruded Top Rim + Vertical Corner Struts for Aircraft Sectors & Hangars
    let strutLine = null;
    if (cat === "aircraft_sector" || cat === "hangar") {
      const h = style.extrudeHeight;
      const strutPositions = [];
      for (let i = 0; i < coords.length - 1; i++) {
        const [x0, y0, z0] = coords[i];
        const [x1, y1, z1] = coords[i + 1];
        // Upper rim segment
        strutPositions.push(x0, y0 + h, z0, x1, y1 + h, z1);
        // Vertical post every few vertices
        if (i % 3 === 0) {
          strutPositions.push(x0, y0, z0, x0, y0 + h, z0);
        }
      }
      const strutGeo = new THREE.BufferGeometry();
      strutGeo.setAttribute("position", new THREE.Float32BufferAttribute(strutPositions, 3));
      const strutMat = new THREE.LineBasicMaterial({
        color: style.hex,
        transparent: true,
        opacity: 0.35,
      });
      strutLine = new THREE.LineSegments(strutGeo, strutMat);
      strutLine.renderOrder = 11;
      featGroup.add(strutLine);
    }

    // 3. Semi-Transparent Terrain-Draped Polygon Fill Mesh for Raycasting & Hover Highlight
    // Use unique ring points (excluding closing duplicate point)
    const ringPts = coords.slice(0, coords.length - 1);
    if (ringPts.length >= 3) {
      const contour2D = ringPts.map((pt) => new THREE.Vector2(pt[0], pt[2]));
      const triangles = THREE.ShapeUtils.triangulateShape(contour2D, []);

      if (triangles && triangles.length > 0) {
        const fillVerts = new Float32Array(ringPts.length * 3);
        for (let i = 0; i < ringPts.length; i++) {
          fillVerts[i * 3] = ringPts[i][0];
          fillVerts[i * 3 + 1] = ringPts[i][1] + 0.004;
          fillVerts[i * 3 + 2] = ringPts[i][2];
        }
        const fillIndices = [];
        for (let t = 0; t < triangles.length; t++) {
          fillIndices.push(triangles[t][0], triangles[t][1], triangles[t][2]);
        }

        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute("position", new THREE.BufferAttribute(fillVerts, 3));
        fillGeo.setIndex(fillIndices);
        fillGeo.computeVertexNormals();

        const fillMat = new THREE.MeshBasicMaterial({
          color: style.hex,
          transparent: true,
          opacity: style.baseOpacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        });

        const fillMesh = new THREE.Mesh(fillGeo, fillMat);
        fillMesh.renderOrder = 10;
        featGroup.add(fillMesh);

        const entry = {
          feature: feat,
          category: cat,
          style,
          lineMat,
          strutLine,
          fillMat,
          fillMesh,
        };
        vectorPickableMeshes.push(fillMesh);
        vectorEntriesByMeshUuid.set(fillMesh.uuid, entry);
      }
    }

    catGroup.add(featGroup);
  });
}

function setVectorEntryHighlight(entry, isHovered, isSelected) {
  if (!entry) return;
  const active = isHovered || isSelected;
  entry.lineMat.color.setHex(active ? entry.style.hoverHex : entry.style.hex);
  entry.lineMat.linewidth = active ? entry.style.lineWidth * 1.65 : entry.style.lineWidth;
  entry.lineMat.opacity = active ? 1.0 : entry.category === "infrastructure" ? 0.65 : 0.92;
  entry.fillMat.opacity = isSelected
    ? entry.style.hoverOpacity * 1.25
    : isHovered
    ? entry.style.hoverOpacity
    : entry.style.baseOpacity;
  if (entry.strutLine) {
    entry.strutLine.material.opacity = active ? 0.78 : 0.35;
  }
}

function inspectVectorFeature(entry, flyTo = false) {
  if (!entry) return;

  if (state.selectedVectorEntry && state.selectedVectorEntry !== entry) {
    setVectorEntryHighlight(state.selectedVectorEntry, false, false);
  }
  state.selectedVectorEntry = entry;
  setVectorEntryHighlight(entry, false, true);

  // Clear active state on CSS2D pins
  pinElements.forEach((item) => {
    item.pinEl.classList.remove("active");
    item.jumpBtn.classList.remove("active");
  });

  const feat = entry.feature;
  const details = feat.details || {};
  inspCode.textContent = entry.style.label;
  inspCode.className = `insp-badge ${entry.style.badgeClass}`;
  inspTitle.textContent = feat.name;
  inspSubtitle.textContent = details.airframe_type || "AMARG Sector / Facility";
  inspDesc.textContent = details.historical_function || "";

  inspMetrics.innerHTML = "";
  const rows = [
    ["Category", entry.style.label],
    ["Airframe / System", details.airframe_type || "—"],
    ["Primary Role", details.role || "—"],
    ["Capacity / Metric", details.estimated_count || "—"],
  ];
  rows.forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "metric-row";
    row.innerHTML = `<span class="metric-key">${k}</span><span class="metric-val">${v}</span>`;
    inspMetrics.appendChild(row);
  });

  inspectorCard.classList.remove("hidden");

  if (flyTo && feat.centroid) {
    const [cx, cy, cz] = feat.centroid;
    const dist = entry.category === "aircraft_sector" ? 3.2 : 2.2;
    animateCameraTo(
      new THREE.Vector3(cx + dist, cy + dist * 0.72, cz + dist),
      new THREE.Vector3(cx, cy, cz),
      1400
    );
  }
}

// ---------------------------------------------------------------------------
// Asset Loading Pipeline
// ---------------------------------------------------------------------------
async function loadSceneAssets() {
  try {
    setProgress(12, "Loading site_manifest.json...");
    const manifestResp = await fetch("./site_manifest.json");
    if (!manifestResp.ok) throw new Error(`HTTP ${manifestResp.status} loading site_manifest.json`);
    const manifest = await manifestResp.json();
    state.manifest = manifest;
    state.worldSizeX = manifest.world_scale?.world_units_x || 20.0;
    state.worldSizeZ = manifest.world_scale?.world_units_z || 20.0;

    populateTelemetryHUD(manifest);
    buildAnnotationPins(manifest.annotations || []);

    // Load Layer A: SAR Point Cloud (davis_monthan_cloud.bin)
    setProgress(30, "Loading davis_monthan_cloud.bin (220,000 SAR scatterers)...");
    const cloudResp = await fetch("./davis_monthan_cloud.bin");
    if (!cloudResp.ok) throw new Error(`HTTP ${cloudResp.status} loading davis_monthan_cloud.bin`);
    const cloudBuffer = await cloudResp.arrayBuffer();
    const rawFloats = new Float32Array(cloudBuffer);

    const stride = 6; // [x, y, z, r, g, b]
    const numPoints = Math.floor(rawFloats.length / stride);
    const positions = new Float32Array(numPoints * 3);
    const colors = new Float32Array(numPoints * 3);

    for (let i = 0; i < numPoints; i++) {
      const base = i * stride;
      const out = i * 3;
      positions[out] = rawFloats[base];
      positions[out + 1] = rawFloats[base + 1];
      positions[out + 2] = rawFloats[base + 2];

      colors[out] = rawFloats[base + 3];
      colors[out + 1] = rawFloats[base + 4];
      colors[out + 2] = rawFloats[base + 5];
    }

    const cloudGeo = new THREE.BufferGeometry();
    cloudGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    cloudGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    cloudGeo.computeBoundingSphere();

    sarPointsMaterial = new THREE.PointsMaterial({
      size: 0.04,
      map: createRadarSpriteTexture(),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.92,
      sizeAttenuation: true,
      clippingPlanes: [sarClipPlane],
    });

    sarPointCloud = new THREE.Points(cloudGeo, sarPointsMaterial);
    sarPointCloud.name = "SAR_PointCloud";
    scene.add(sarPointCloud);

    // Load Layer B: PBR Optical & SAR-Roughness Textures + GLB Terrain Mesh
    setProgress(58, "Loading optical_diffuse.webp & sar_roughness.webp...");
    const texLoader = new THREE.TextureLoader();
    const [diffuseTex, roughnessTex] = await Promise.all([
      texLoader.loadAsync("./optical_diffuse.webp"),
      texLoader.loadAsync("./sar_roughness.webp"),
    ]);

    diffuseTex.flipY = false;
    diffuseTex.colorSpace = THREE.SRGBColorSpace;
    diffuseTex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    roughnessTex.flipY = false;
    roughnessTex.colorSpace = THREE.NoColorSpace;
    roughnessTex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

    setProgress(76, "Loading 3D terrain mesh davis_monthan_terrain.glb...");
    const gltfLoader = new GLTFLoader();
    const gltf = await gltfLoader.loadAsync("./davis_monthan_terrain.glb");

    const pbrMaterial = new THREE.MeshStandardMaterial({
      map: diffuseTex,
      roughnessMap: roughnessTex,
      metalnessMap: roughnessTex,
      roughness: 0.92,
      metalness: 0.32,
      clippingPlanes: [opticalClipPlane],
      clipShadows: true,
    });

    terrainMeshGroup = gltf.scene;
    terrainMeshGroup.traverse((child) => {
      if (child.isMesh) {
        child.material = pbrMaterial;
        child.receiveShadow = true;
        child.castShadow = true;
        terrainMeshForRaycast = child;
      }
    });
    scene.add(terrainMeshGroup);

    // Load Layer C: Co-Registered 3D Vector Overlays (site_vectors.json)
    setProgress(90, "Loading 3D vector footprints (site_vectors.json)...");
    let vecResp = await fetch("./site_vectors.json");
    if (!vecResp.ok) {
      vecResp = await fetch("./public/assets/site_vectors.json");
    }
    if (vecResp.ok) {
      const vecJson = await vecResp.json();
      state.vectorsData = vecJson;
      buildVectorOverlays(vecJson);
    }

    // Apply initial mode & select first annotation
    applyVisualMode(state.mode);
    if (manifest.annotations && manifest.annotations.length > 0) {
      selectAnnotation(0, false);
    }

    setProgress(100, "Ready.");
    setTimeout(() => {
      loadingOverlay.classList.add("fade-out");
    }, 250);
  } catch (err) {
    console.error("Error initializing 3D scene:", err);
    setProgress(100, `Initialization error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Visual Mode & Spatial Wipe Controller
// ---------------------------------------------------------------------------
function updateSpatialWipePlane(normalizedValue) {
  state.wipeNormalized = THREE.MathUtils.clamp(normalizedValue, 0.0, 1.0);
  const halfX = state.worldSizeX * 0.5;
  const wipeX = THREE.MathUtils.lerp(-halfX, halfX, state.wipeNormalized);

  opticalClipPlane.constant = wipeX;
  sarClipPlane.constant = -wipeX;
  wipeDividerGroup.position.x = wipeX;

  if (wipeSlider && Math.abs(parseFloat(wipeSlider.value) - state.wipeNormalized * 100) > 0.5) {
    wipeSlider.value = String(state.wipeNormalized * 100);
  }
}

function applyVisualMode(mode) {
  state.mode = mode;

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    const isMatch = btn.dataset.mode === mode;
    btn.classList.toggle("active", isMatch);
    btn.setAttribute("aria-selected", isMatch ? "true" : "false");
  });

  if (mode === "optical") {
    if (terrainMeshGroup) {
      terrainMeshGroup.visible = true;
      terrainMeshGroup.traverse((c) => {
        if (c.isMesh) c.material.clippingPlanes = [];
      });
    }
    if (sarPointCloud) sarPointCloud.visible = false;
    wipeDividerGroup.visible = false;
    xrayControls.classList.add("hidden");
    bloomPass.strength = 0.22;
  } else if (mode === "sar") {
    if (terrainMeshGroup) terrainMeshGroup.visible = false;
    if (sarPointCloud) {
      sarPointCloud.visible = true;
      sarPointsMaterial.clippingPlanes = [];
    }
    wipeDividerGroup.visible = false;
    xrayControls.classList.add("hidden");
    bloomPass.strength = parseFloat(document.getElementById("slider-bloom").value) * 0.65;
  } else {
    if (terrainMeshGroup) {
      terrainMeshGroup.visible = true;
      terrainMeshGroup.traverse((c) => {
        if (c.isMesh) c.material.clippingPlanes = [opticalClipPlane];
      });
    }
    if (sarPointCloud) {
      sarPointCloud.visible = true;
      sarPointsMaterial.clippingPlanes = [sarClipPlane];
    }
    wipeDividerGroup.visible = true;
    xrayControls.classList.remove("hidden");
    bloomPass.strength = parseFloat(document.getElementById("slider-bloom").value) * 0.5;
    updateSpatialWipePlane(state.wipeNormalized);
  }
}

// ---------------------------------------------------------------------------
// Telemetry HUD & Floating 3D CSS2D Annotations
// ---------------------------------------------------------------------------
function populateTelemetryHUD(manifest) {
  const tel = manifest.telemetry || {};
  document.getElementById("tel-sensor").textContent = "Umbra X-band Spotlight";
  document.getElementById("tel-grazing").textContent = `~35° (${tel.grazing_angle_deg || 60.1}° Collect)`;
  document.getElementById("tel-azimuth").textContent = `242° (${tel.azimuth_angle_deg || 287.2}° View)`;
  document.getElementById("tel-resolution").textContent = "25cm (50cm GEC Grid)";
  document.getElementById("tel-pol").textContent = `${tel.polarization || "VV"} // ${tel.center_frequency_ghz || 9.73} GHz`;
  document.getElementById("tel-crs").textContent = "WGS 84 / UTM 12N (32612)";
}

function buildAnnotationPins(annotations) {
  const listContainer = document.getElementById("annotation-buttons");
  listContainer.innerHTML = "";

  annotations.forEach((ann, index) => {
    const pinEl = document.createElement("div");
    pinEl.className = "sar-pin";
    pinEl.innerHTML = `
      <span class="sar-pin-beacon"></span>
      <span class="sar-pin-code">${ann.code}</span>
      <span class="sar-pin-label">${ann.title}</span>
    `;
    pinEl.addEventListener("click", (e) => {
      e.stopPropagation();
      stopGuidedTour();
      selectAnnotation(index, true);
    });

    const cssObj = new CSS2DObject(pinEl);
    cssObj.position.set(ann.position[0], ann.position[1], ann.position[2]);
    scene.add(cssObj);

    const ringGeo = new THREE.RingGeometry(0.14, 0.22, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.set(ann.position[0], ann.position[1] - 0.14, ann.position[2]);
    scene.add(ringMesh);

    const jumpBtn = document.createElement("button");
    jumpBtn.className = "poi-jump-btn";
    jumpBtn.innerHTML = `
      <div class="poi-jump-left">
        <span class="poi-code">${ann.code}</span>
        <span class="poi-name">${ann.title}</span>
      </div>
      <span>→</span>
    `;
    jumpBtn.addEventListener("click", () => {
      stopGuidedTour();
      selectAnnotation(index, true);
    });
    listContainer.appendChild(jumpBtn);

    pinElements.push({ pinEl, jumpBtn, data: ann });
  });
}

function selectAnnotation(index, flyCamera = true) {
  const annotations = state.manifest?.annotations || [];
  if (!annotations.length) return;

  if (state.selectedVectorEntry) {
    setVectorEntryHighlight(state.selectedVectorEntry, false, false);
    state.selectedVectorEntry = null;
  }

  state.activeAnnotationIndex = (index + annotations.length) % annotations.length;
  const ann = annotations[state.activeAnnotationIndex];

  pinElements.forEach((item, idx) => {
    const active = idx === state.activeAnnotationIndex;
    item.pinEl.classList.toggle("active", active);
    item.jumpBtn.classList.toggle("active", active);
  });

  inspCode.textContent = ann.code;
  inspCode.className = "insp-badge";
  inspTitle.textContent = ann.title;
  inspSubtitle.textContent = ann.subtitle;
  inspDesc.textContent = ann.description;

  inspMetrics.innerHTML = "";
  if (ann.metrics) {
    Object.entries(ann.metrics).forEach(([k, v]) => {
      const row = document.createElement("div");
      row.className = "metric-row";
      row.innerHTML = `<span class="metric-key">${k}</span><span class="metric-val">${v}</span>`;
      inspMetrics.appendChild(row);
    });
  }
  inspectorCard.classList.remove("hidden");

  if (flyCamera) {
    const camPos = ann.camera_Position || [ann.position[0] + 2.6, ann.position[1] + 2.0, ann.position[2] + 2.6];
    animateCameraTo(
      new THREE.Vector3(...camPos),
      new THREE.Vector3(...ann.position),
      1600
    );
  }
}

// ---------------------------------------------------------------------------
// Smooth Cubic Camera Spline & Guided Tour Controller
// ---------------------------------------------------------------------------
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animateCameraTo(targetCamPos, targetLookAt, durationMs = 1800, onComplete = null) {
  state.cameraTransition = {
    startPos: camera.position.clone(),
    endPos: targetCamPos.clone(),
    startTarget: controls.target.clone(),
    endTarget: targetLookAt.clone(),
    startTime: performance.now(),
    duration: durationMs,
    onComplete,
  };
}

function startGuidedTour() {
  const stops = state.manifest?.guided_tour || [];
  if (!stops.length) return;

  state.tourActive = true;
  state.tourPaused = false;
  tourPauseBtn.textContent = "Pause";
  document.getElementById("btn-guided-tour").classList.add("active");
  document.getElementById("btn-free-orbit").classList.remove("active");
  tourBanner.classList.remove("hidden");

  runTourStep(state.tourStepIndex);
}

function stopGuidedTour() {
  state.tourActive = false;
  state.tourPaused = false;
  state.cameraTransition = null;
  document.getElementById("btn-guided-tour").classList.remove("active");
  document.getElementById("btn-free-orbit").classList.add("active");
  tourBanner.classList.add("hidden");
}

function runTourStep(stepIdx) {
  const stops = state.manifest?.guided_tour || [];
  if (!stops.length || !state.tourActive) return;

  state.tourStepIndex = (stepIdx + stops.length) % stops.length;
  const stop = stops[state.tourStepIndex];

  tourStepBadge.textContent = `TOUR ${state.tourStepIndex + 1} / ${stops.length}`;
  tourStepTitle.textContent = stop.title;
  tourStepCaption.textContent = stop.caption;

  if (stop.mode) {
    applyVisualMode(stop.mode);
  }
  if (typeof stop.wipe === "number") {
    updateSpatialWipePlane(stop.wipe);
  }
  if (stop.annotationId && state.manifest?.annotations) {
    const annIdx = state.manifest.annotations.findIndex((a) => a.id === stop.annotationId);
    if (annIdx >= 0) selectAnnotation(annIdx, false);
  }

  animateCameraTo(
    new THREE.Vector3(...stop.camera),
    new THREE.Vector3(...stop.target),
    stop.duration || 3200,
    () => {
      if (state.tourActive && !state.tourPaused) {
        setTimeout(() => {
          if (state.tourActive && !state.tourPaused) {
            runTourStep(state.tourStepIndex + 1);
          }
        }, 1400);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// UI Event Listeners & Modal / Vector Controls
// ---------------------------------------------------------------------------
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    applyVisualMode(btn.dataset.mode);
  });
});

const toggleVectorsCheckbox = document.getElementById("toggle-vectors");
const vectorToggleLabel = document.getElementById("vector-toggle-label");

function setVectorLayerVisibility(visible) {
  state.vectorsVisible = visible;
  vectorOverlayGroup.visible = visible;
  if (toggleVectorsCheckbox) toggleVectorsCheckbox.checked = visible;
  if (vectorToggleLabel) vectorToggleLabel.classList.toggle("active", visible);
  if (!visible) {
    vectorTooltip.classList.add("hidden");
  }
}

toggleVectorsCheckbox.addEventListener("change", (e) => {
  setVectorLayerVisibility(e.target.checked);
});

document.querySelectorAll("input[data-vec-cat]").forEach((cb) => {
  cb.addEventListener("change", (e) => {
    const cat = e.target.dataset.vecCat;
    state.categoryVisible[cat] = e.target.checked;
    if (vectorCategoryGroups[cat]) {
      vectorCategoryGroups[cat].visible = e.target.checked;
    }
  });
});

// Mission Briefing / About Modal
function toggleAboutModal(show) {
  const isHidden = aboutModalBackdrop.classList.contains("hidden");
  const nextState = typeof show === "boolean" ? show : isHidden;
  aboutModalBackdrop.classList.toggle("hidden", !nextState);
}

document.getElementById("btn-about-modal").addEventListener("click", () => {
  toggleAboutModal(true);
});

document.getElementById("close-about-modal").addEventListener("click", () => {
  toggleAboutModal(false);
});

aboutModalBackdrop.addEventListener("click", (e) => {
  if (e.target === aboutModalBackdrop) {
    toggleAboutModal(false);
  }
});

wipeSlider.addEventListener("input", (e) => {
  updateSpatialWipePlane(parseFloat(e.target.value) / 100.0);
});

cursorWipeCheckbox.addEventListener("change", (e) => {
  state.cursorWipeEnabled = e.target.checked;
});

document.getElementById("btn-free-orbit").addEventListener("click", () => {
  stopGuidedTour();
});

document.getElementById("btn-guided-tour").addEventListener("click", () => {
  if (state.tourActive) {
    stopGuidedTour();
  } else {
    startGuidedTour();
  }
});

document.getElementById("btn-reset-cam").addEventListener("click", () => {
  stopGuidedTour();
  applyVisualMode("xray");
  updateSpatialWipePlane(0.5);
  animateCameraTo(new THREE.Vector3(0.0, 9.5, 13.5), new THREE.Vector3(0, 0, 0), 1400);
});

document.getElementById("toggle-telemetry").addEventListener("click", (e) => {
  const body = document.getElementById("telemetry-body");
  const collapsed = body.classList.toggle("collapsed");
  e.target.textContent = collapsed ? "+" : "−";
});

document.getElementById("close-inspector").addEventListener("click", () => {
  inspectorCard.classList.add("hidden");
  if (state.selectedVectorEntry) {
    setVectorEntryHighlight(state.selectedVectorEntry, false, false);
    state.selectedVectorEntry = null;
  }
});

document.getElementById("insp-prev").addEventListener("click", () => {
  stopGuidedTour();
  selectAnnotation(state.activeAnnotationIndex - 1, true);
});

document.getElementById("insp-next").addEventListener("click", () => {
  stopGuidedTour();
  selectAnnotation(state.activeAnnotationIndex + 1, true);
});

document.getElementById("tour-prev").addEventListener("click", () => {
  if (state.tourActive) runTourStep(state.tourStepIndex - 1);
});

document.getElementById("tour-next").addEventListener("click", () => {
  if (state.tourActive) runTourStep(state.tourStepIndex + 1);
});

tourPauseBtn.addEventListener("click", () => {
  if (!state.tourActive) return;
  state.tourPaused = !state.tourPaused;
  tourPauseBtn.textContent = state.tourPaused ? "Resume" : "Pause";
  if (!state.tourPaused && !state.cameraTransition) {
    runTourStep(state.tourStepIndex + 1);
  }
});

document.getElementById("slider-pt-size").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById("val-pt-size").textContent = v.toFixed(3);
  if (sarPointsMaterial) sarPointsMaterial.size = v;
});

document.getElementById("slider-bloom").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById("val-bloom").textContent = `${v.toFixed(2)}×`;
  if (state.mode === "sar") bloomPass.strength = v * 0.65;
  else if (state.mode === "xray") bloomPass.strength = v * 0.5;
});

document.getElementById("slider-sun").addEventListener("input", (e) => {
  const deg = parseFloat(e.target.value);
  document.getElementById("val-sun").textContent = `${deg}°`;
  updateSunElevation(deg);
});

// Keyboard Shortcuts
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const k = e.key.toLowerCase();
  if (k === "1") applyVisualMode("optical");
  else if (k === "2") applyVisualMode("sar");
  else if (k === "3") applyVisualMode("xray");
  else if (k === "v") setVectorLayerVisibility(!state.vectorsVisible);
  else if (k === "t") {
    if (state.tourActive) stopGuidedTour();
    else startGuidedTour();
  } else if (k === "i") toggleAboutModal();
  else if (e.key === "Escape") toggleAboutModal(false);
});

// ---------------------------------------------------------------------------
// Pointer Raycasting: 3D Vector Polygons + Live UTM Terrain Readout
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let pointerDownPos = { x: 0, y: 0 };

function getActivePickableVectorMeshes() {
  if (!state.vectorsVisible) return [];
  return vectorPickableMeshes.filter((m) => {
    const entry = vectorEntriesByMeshUuid.get(m.uuid);
    return entry && state.categoryVisible[entry.category];
  });
}

window.addEventListener("pointermove", (e) => {
  pointerNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;

  if (state.mode === "xray" && state.cursorWipeEnabled) {
    const normX = e.clientX / window.innerWidth;
    updateSpatialWipePlane(normX);
  }

  raycaster.setFromCamera(pointerNDC, camera);

  // 1. Raycast against 3D Vector Polygons
  const activeVecMeshes = getActivePickableVectorMeshes();
  if (activeVecMeshes.length > 0 && e.target === canvas) {
    const vecHits = raycaster.intersectObjects(activeVecMeshes, false);
    if (vecHits.length > 0) {
      // Prioritize sub-airframe components (Nose Radome, Swept Wing & Nacelles, T-Tail) when inside an aircraft outline
      let chosenEntry = vectorEntriesByMeshUuid.get(vecHits[0].object.uuid);
      for (const hit of vecHits) {
        const cand = vectorEntriesByMeshUuid.get(hit.object.uuid);
        if (cand && cand.category === "aircraft_component") {
          chosenEntry = cand;
          break;
        }
      }

      if (state.hoveredVectorEntry && state.hoveredVectorEntry !== chosenEntry) {
        setVectorEntryHighlight(
          state.hoveredVectorEntry,
          false,
          state.hoveredVectorEntry === state.selectedVectorEntry
        );
      }
      state.hoveredVectorEntry = chosenEntry;
      setVectorEntryHighlight(chosenEntry, true, chosenEntry === state.selectedVectorEntry);

      canvas.style.cursor = "pointer";
      ttCatDot.style.background = chosenEntry.style.css;
      ttCatDot.style.color = chosenEntry.style.css;
      ttCategory.textContent = chosenEntry.style.label;
      ttName.textContent = chosenEntry.feature.name;
      ttSub.textContent = chosenEntry.feature.details?.airframe_type || "";
      vectorTooltip.style.left = `${Math.min(e.clientX + 16, window.innerWidth - 300)}px`;
      vectorTooltip.style.top = `${Math.min(e.clientY + 16, window.innerHeight - 110)}px`;
      vectorTooltip.classList.remove("hidden");
    } else {
      if (state.hoveredVectorEntry) {
        setVectorEntryHighlight(
          state.hoveredVectorEntry,
          false,
          state.hoveredVectorEntry === state.selectedVectorEntry
        );
        state.hoveredVectorEntry = null;
      }
      canvas.style.cursor = "grab";
      vectorTooltip.classList.add("hidden");
    }
  } else {
    vectorTooltip.classList.add("hidden");
  }

  // 2. Raycast against Terrain Mesh for live UTM coordinates
  if (terrainMeshForRaycast) {
    const hits = raycaster.intersectObject(terrainMeshForRaycast, false);
    if (hits.length > 0) {
      const pt = hits[0].point;
      const utmE = Math.round(513559 + (pt.x / state.worldSizeX + 0.5) * 2000);
      const utmN = Math.round(3559596 - (pt.z / state.worldSizeZ + 0.5) * 2000);
      const elevM = (828.79 + (pt.y / 2.8) * 100.0).toFixed(1);
      cursorCoordsEl.textContent = `UTM 12N: ${utmE.toLocaleString()} E / ${utmN.toLocaleString()} N // ELEV: ${elevM} m`;
    }
  }
});

canvas.addEventListener("pointerdown", (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener("pointerup", (e) => {
  const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  if (moveDist < 5 && state.hoveredVectorEntry) {
    stopGuidedTour();
    inspectVectorFeature(state.hoveredVectorEntry, true);
  }
});

window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  labelRenderer.setSize(w, h);
  allLine2Materials.forEach((mat) => mat.resolution.set(w, h));
});

// ---------------------------------------------------------------------------
// Main Render Loop
// ---------------------------------------------------------------------------
let frameCount = 0;
let lastFpsUpdate = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  frameCount++;
  if (now - lastFpsUpdate >= 500) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    fpsCounterEl.textContent = `${fps} FPS`;
    frameCount = 0;
    lastFpsUpdate = now;
  }

  if (state.cameraTransition) {
    const tr = state.cameraTransition;
    const elapsed = now - tr.startTime;
    const rawT = Math.min(elapsed / tr.duration, 1.0);
    const k = easeInOutCubic(rawT);

    camera.position.lerpVectors(tr.startPos, tr.endPos, k);
    controls.target.lerpVectors(tr.startTarget, tr.endTarget, k);

    if (rawT >= 1.0) {
      const cb = tr.onComplete;
      state.cameraTransition = null;
      if (cb) cb();
    }
  }

  controls.update();
  composer.render();
  labelRenderer.render(scene, camera);
}

loadSceneAssets();
requestAnimationFrame(animate);
