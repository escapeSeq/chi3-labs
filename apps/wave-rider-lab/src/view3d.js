import * as THREE from "three";
import { sampleSurfaceXZ } from "./wave.js";
import { hullRings } from "./ship.js";

const SEA_NX = 96;
const SEA_NZ = 40;
const SPRAY_MAX = 560;
const WATER_FACE = new THREE.Color(0x152026);
const WATER_CREST = new THREE.Color(0x3db8c5);
const WATER_FOAM = new THREE.Color(0xe7efe6);
const HULL_ABOVE = new THREE.Color(0xc4a37a);
const HULL_BELOW = new THREE.Color(0x1b2a30);
const HULL_BOOT = new THREE.Color(0x5c4030);
const COLOR = new THREE.Color();

export function createView3D(canvas, { onPickX } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1418);
  scene.fog = new THREE.Fog(0x0c1418, 28, 110);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.2, 400);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x0c1418, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene.add(new THREE.HemisphereLight(0xb7d4d0, 0x1a1510, 1.05));
  const sun = new THREE.DirectionalLight(0xe7efe6, 1.35);
  sun.position.set(-18, 28, 16);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x3db8c5, 0.35);
  rim.position.set(12, 8, -22);
  scene.add(rim);

  const sea = makeSeaGrid();
  scene.add(sea);

  const shipGroup = new THREE.Group();
  scene.add(shipGroup);

  const spray = makeSprayPoints();
  scene.add(spray);

  const orbit = {
    azimuth: 0.72,
    elevation: 0.38,
    distance: 28,
    targetY: 0,
  };
  const drag = { active: false, x: 0, y: 0, moved: 0, pointerId: null };

  function resize() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function resetCamera(ship) {
    orbit.azimuth = 0.72;
    orbit.elevation = 0.38;
    orbit.distance = cameraDistance(ship);
  }

  function placeCamera(ship) {
    const length = Math.max(8, ship?.length ?? 14);
    const minD = length * 1.35;
    const maxD = length * 7.5;
    orbit.distance = Math.max(minD, Math.min(maxD, orbit.distance));
    orbit.elevation = Math.max(0.08, Math.min(1.28, orbit.elevation));
    orbit.targetY = (ship?.y ?? 0) * 0.35;
    const cosEl = Math.cos(orbit.elevation);
    camera.position.set(
      Math.sin(orbit.azimuth) * cosEl * orbit.distance,
      Math.sin(orbit.elevation) * orbit.distance + orbit.targetY + length * 0.06,
      Math.cos(orbit.azimuth) * cosEl * orbit.distance
    );
    camera.lookAt(0, orbit.targetY, 0);
  }

  function rebuildShip(ship) {
    while (shipGroup.children.length) {
      const child = shipGroup.children[0];
      shipGroup.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    const hull = makeHullMesh(ship);
    const cabin = makeCabinMesh(ship);
    shipGroup.add(hull);
    if (cabin) shipGroup.add(cabin);
    shipGroup.userData.key = hullKey(ship);
  }

  function render(field, ship) {
    if (shipGroup.userData.key !== hullKey(ship)) rebuildShip(ship);
    updateSea(sea, field, ship);
    updateShip(shipGroup, ship);
    updateSpray(spray, field, ship);
    placeCamera(ship);
    renderer.render(scene, camera);
  }

  function pointerPos(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      w: rect.width,
      h: rect.height,
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    drag.active = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = 0;
    drag.pointerId = event.pointerId;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    orbit.azimuth -= dx * 0.005;
    orbit.elevation += dy * 0.004;
  });

  function endDrag(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    const wasClick = drag.moved < 6;
    drag.active = false;
    drag.pointerId = null;
    if (!wasClick || !onPickX) return;
    const { x, y, w, h } = pointerPos(event);
    const ndc = new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -orbit.targetY);
    if (!raycaster.ray.intersectPlane(plane, hit)) return;
    onPickX(hit.x);
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      orbit.distance *= factor;
    },
    { passive: false }
  );

  canvas.addEventListener("dblclick", () => resetCamera(shipGroup.userData.ship));

  function dispose() {
    renderer.dispose();
    sea.geometry.dispose();
    sea.material.dispose();
    spray.geometry.dispose();
    spray.material.dispose();
    while (shipGroup.children.length) {
      const child = shipGroup.children[0];
      shipGroup.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }

  resize();
  return { resize, render, dispose, resetCamera };
}

function hullKey(ship) {
  return [ship.length, ship.draft, ship.beam].map((n) => n.toFixed(3)).join(":");
}

function cameraDistance(ship) {
  return Math.max(16, (ship?.length ?? 14) * 2.35);
}

function makeSeaGrid() {
  const vertexCount = SEA_NX * SEA_NZ;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = [];
  for (let z = 0; z < SEA_NZ; z += 1) {
    for (let x = 0; x < SEA_NX - 1; x += 1) {
      const a = z * SEA_NX + x;
      indices.push(a, a + 1);
    }
  }
  for (let x = 0; x < SEA_NX; x += 1) {
    for (let z = 0; z < SEA_NZ - 1; z += 1) {
      const a = z * SEA_NX + x;
      indices.push(a, a + SEA_NX);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    fog: true,
    transparent: true,
    opacity: 0.92,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

function updateSea(mesh, field, ship) {
  const positions = mesh.geometry.getAttribute("position");
  const colors = mesh.geometry.getAttribute("color");
  const spanX = field.viewWidth;
  const spanZ = Math.max(28, ship.beam * 8, ship.length * 2.2);
  const originX = ship.x ?? spanX * 0.5;
  const scroll = field.scrollX ?? 0;

  for (let iz = 0; iz < SEA_NZ; iz += 1) {
    const z = (iz / (SEA_NZ - 1) - 0.5) * spanZ;
    for (let ix = 0; ix < SEA_NX; ix += 1) {
      const displayX = (ix / (SEA_NX - 1)) * spanX;
      const seaX = displayX + scroll;
      const sample = sampleSurfaceXZ(field, seaX, z);
      const y = sample.y;
      const i = iz * SEA_NX + ix;
      positions.setXYZ(i, displayX - originX, y, z);
      const lift = 0.5 + 0.5 * Math.tanh(y * 0.55);
      COLOR.copy(WATER_FACE).lerp(WATER_CREST, 0.2 + lift * 0.8);
      if (sample.break > 0.06) COLOR.lerp(WATER_FOAM, Math.min(1, 0.35 + sample.break));
      colors.setXYZ(i, COLOR.r, COLOR.g, COLOR.b);
    }
  }

  positions.needsUpdate = true;
  colors.needsUpdate = true;
}

function makeHullMesh(ship) {
  const { rings } = hullRings(ship);
  const stations = rings.length;
  const profile = rings[0].length;
  const positions = [];
  const colors = [];
  const indices = [];

  for (const ring of rings) {
    for (const p of ring) {
      positions.push(p.x, p.y, p.z);
      COLOR.copy(HULL_ABOVE);
      if (p.y < -0.08) COLOR.copy(HULL_BELOW);
      else if (Math.abs(p.y) < 0.07) COLOR.copy(HULL_BOOT);
      colors.push(COLOR.r, COLOR.g, COLOR.b);
    }
  }

  for (let i = 0; i < stations - 1; i += 1) {
    for (let p = 0; p < profile - 1; p += 1) {
      const a = i * profile + p;
      const b = a + 1;
      const c = (i + 1) * profile + p;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    const port = i * profile;
    const starboard = port + profile - 1;
    const portNext = (i + 1) * profile;
    const starboardNext = portNext + profile - 1;
    indices.push(port, starboard, portNext, portNext, starboard, starboardNext);
  }

  capRing(rings[0], 0, false, positions, colors, indices);
  capRing(rings[stations - 1], (stations - 1) * profile, true, positions, colors, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

function capRing(ring, startIndex, bow, positions, colors, indices) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  const n = ring.length;
  cx /= n;
  cy /= n;
  cz /= n;
  const center = positions.length / 3;
  positions.push(cx, cy, cz);
  COLOR.copy(HULL_ABOVE);
  if (cy < -0.08) COLOR.copy(HULL_BELOW);
  colors.push(COLOR.r, COLOR.g, COLOR.b);
  for (let i = 0; i < n - 1; i += 1) {
    const a = startIndex + i;
    const b = startIndex + i + 1;
    if (bow) indices.push(center, a, b);
    else indices.push(center, b, a);
  }
}

function makeCabinMesh(ship) {
  const { cabin } = hullRings(ship);
  if (!cabin) return null;
  const geometry = new THREE.BoxGeometry(cabin.length, cabin.height, cabin.width);
  const material = new THREE.MeshLambertMaterial({ color: 0xd8c4a4 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(cabin.x, cabin.y, cabin.z);
  return mesh;
}

function updateShip(group, ship) {
  group.userData.ship = ship;
  group.position.set(0, ship.y, 0);
  group.rotation.set(0, 0, 0);
  group.rotation.order = "YZX";
  group.rotation.y = ship.heading >= 0 ? 0 : Math.PI;
  group.rotation.z = ship.pitch;
  group.visible = ship.visible !== false;
}

function makeSprayPoints() {
  const positions = new Float32Array(SPRAY_MAX * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);
  const material = new THREE.PointsMaterial({
    color: 0xe7f2f0,
    size: 0.18,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function updateSpray(points, field, ship) {
  const positions = points.geometry.getAttribute("position");
  const originX = ship.x ?? field.viewWidth * 0.5;
  const scroll = field.scrollX ?? 0;
  const drops = field.spray || [];
  const count = Math.min(SPRAY_MAX, drops.length);
  for (let i = 0; i < count; i += 1) {
    const drop = drops[i];
    const x = drop.x - scroll - originX;
    const z = Math.sin(drop.x * 13.1 + drop.y * 4.7) * Math.max(0.6, ship.beam * 0.35);
    positions.setXYZ(i, x, drop.y, z);
  }
  positions.needsUpdate = true;
  points.geometry.setDrawRange(0, count);
}
