// 3D view of the assembled pack (three.js). The engine (pack/assembly.py, via Engine.pack) gives
// every solid already placed in the model frame; this file only draws them.
//
//   const v = PackViewer.mount(element)   one WebGL canvas inside element
//   v.setAssembly(result.assembly)        redraw for a new pack (keeps the viewing angle)
//   v.resetView()  v.setSeeThrough(bool)  v.setExplode(t)   t = 0 assembled .. 1 fully exploded
//
// Loaded as a module after the page script; it fires "packviewer-ready" on window when it is
// ready (or "packviewer-failed" if WebGL is not available).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const LOOKS = {
  polycarbonate: { color: 0x3b4248, roughness: 0.45, metalness: 0.0, edges: 0x9aa4ad },
  aluminum: { color: 0xc4c9ce, roughness: 0.4, metalness: 0.2, edges: 0x6b7178 },
  cell: { color: 0x2f6fb5, roughness: 0.3, metalness: 0.1 },           // shrink wrap
  cell_can: { color: 0xc9ccd0, roughness: 0.35, metalness: 0.2 },      // nickel-plated steel
  cell_insulator: { color: 0xecebe6, roughness: 0.8, metalness: 0.0 },
  nickel: { color: 0xc9c8bd, roughness: 0.35, metalness: 0.2 },
  abs: { color: 0x1e2124, roughness: 0.8, metalness: 0.0 },
  printed: { color: 0x5b6067, roughness: 0.75, metalness: 0.0, edges: 0xa3a9b0 },   // printed ABS wall pieces
  foam: { color: 0x8c9096, roughness: 1.0, metalness: 0.0, texture: "foam" },   // dark grey closed-cell foam (times the grey texture)
  steel: { color: 0x1a1b1c, roughness: 0.4, metalness: 0.2 },
  zinc: { color: 0xb9bdc2, roughness: 0.35, metalness: 0.35 },          // zinc-plated coupling nuts, allthread
  holder: { color: 0x141517, roughness: 0.7, metalness: 0.0 },         // black ABS / PC cell holders
  insulator: { color: 0x3d7a46, roughness: 0.9, metalness: 0.0 },      // green fish paper rings
};
// (No environment map, so metals stay at low metalness: high metalness would render them black.)
// See-through mode fades the walls and everything that hides the cells.
const SEE_THROUGH = { polycarbonate: 0.28, printed: 0.3, nickel: 0.18, foam: 0.12, holder: 0.35 };
const VIEW_DIR = new THREE.Vector3(0.75, 0.6, 1.0).normalize();   // front-right, from above

function material(name) {
  const l = LOOKS[name] || LOOKS.abs;
  const m = new THREE.MeshStandardMaterial({ color: l.color, roughness: l.roughness, metalness: l.metalness, side: THREE.DoubleSide });
  if (l.texture === "foam") {   // speckled cells, also used as a bump map; box UVs are in mm / FOAM_TILE
    const tex = foamTexture();
    m.map = tex;
    m.bumpMap = tex;
    m.bumpScale = 0.6;
  }
  return m;
}

// Foam: a tiling noise of light and dark pores on mid grey, drawn once on a canvas
const FOAM_TILE = 12;      // mm of foam per texture repeat
function foamTexture() {
  const n = 128, c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d");
  g.fillStyle = "#8a8d92";
  g.fillRect(0, 0, n, n);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * n, y = rnd() * n, r = 0.6 + rnd() * 1.8, v = rnd();
    g.fillStyle = v < 0.6 ? `rgba(40,42,46,${0.35 + rnd() * 0.5})` : `rgba(200,203,208,${0.2 + rnd() * 0.3})`;
    for (const [dx, dy] of [[0, 0], [n, 0], [-n, 0], [0, n], [0, -n]]) {   // wrap so it tiles
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// BoxGeometry gives every face UVs 0..1; rescale them to the face size in mm so a texture keeps
// its scale on long and short boxes alike. Faces: +x, -x, +y, -y, +z, -z (4 vertices each).
function scaleBoxUVs(geom, w, h, d, tile) {
  const uv = geom.attributes.uv, size = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * size[f][0] / tile, uv.getY(i) * size[f][1] / tile);
    }
  }
  uv.needsUpdate = true;
  return geom;
}

function shapeFrom(outline, holes, circles, slots) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  if (circles) {   // round holes sent as centers + one radius (the holder bores)
    for (const [x, y] of circles.centers) shape.holes.push(new THREE.Path().absarc(x, y, circles.radius, 0, Math.PI * 2, true));
  }
  if (slots) {     // oval slots along the strip (weld slots): two half circles joined by straight sides
    const r = slots.width / 2, h = slots.length / 2 - r;
    for (const [x, y] of slots.centers) {
      const p = new THREE.Path();
      p.absarc(x, y + h, r, 0, Math.PI, false);
      p.absarc(x, y - h, r, Math.PI, Math.PI * 2, false);
      p.closePath();
      shape.holes.push(p);
    }
  }
  return shape;
}

// Exploded-view offset of each of a solid's n pieces (assembly.py: explode / explode_each)
function offsets(s, n) {
  const v = a => new THREE.Vector3(a[0], a[1], a[2]);
  if (s.explode_each) return s.explode_each.map(v);
  const one = v(s.explode || [0, 0, 0]);
  return Array.from({ length: n }, () => one);
}

function frameMatrix(f) {
  const v = a => new THREE.Vector3(a[0], a[1], a[2]);
  return new THREE.Matrix4().makeBasis(v(f.u), v(f.v), v(f.w)).setPosition(v(f.origin));
}

class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1.5, 0.5, -1);
    this.scene.add(key, fill);

    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());

    this.materials = Object.fromEntries(Object.keys(LOOKS).map(k => [k, material(k)]));
    this.edgeMaterials = {};
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.seeThrough = true;
    this.explode = 0;
    this.movers = [];      // exploded view: {apply(t)} per drawn piece
    this.bbox = null;
    this.bboxExploded = null;
    this.applySeeThrough();

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  clear() {
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.group.clear();
    this.movers = [];
  }

  edgeMaterial(name) {
    const color = (LOOKS[name] || {}).edges;
    if (color === undefined) return null;
    return this.edgeMaterials[name] || (this.edgeMaterials[name] = new THREE.LineBasicMaterial({ color }));
  }

  addExtrusion(s) {
    const geom = new THREE.ExtrudeGeometry(shapeFrom(s.outline, s.holes, s.circle_holes, s.slot_holes),
                                           { depth: s.thickness, bevelEnabled: false, curveSegments: s.circle_holes || s.slot_holes ? 10 : 1 });
    const m = frameMatrix(s.frame);
    const mesh = new THREE.Mesh(geom, this.materials[s.material]);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(m);
    mesh.name = s.name;
    mesh.renderOrder = s.material in SEE_THROUGH ? 2 : 0;
    this.group.add(mesh);
    const objs = [mesh];
    const em = this.edgeMaterial(s.material);
    if (em) {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), em);
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(m);
      lines.renderOrder = 3;
      this.group.add(lines);
      objs.push(lines);
    }
    const off = offsets(s, 1)[0];
    this.movers.push({ apply: t => {
      const moved = new THREE.Matrix4().makeTranslation(off.x * t, off.y * t, off.z * t).multiply(m);
      for (const o of objs) o.matrix.copy(moved);
    } });
  }

  addCylinders(s) {
    const pieces = [];     // [geometry, material name]
    if (s.lathe) {         // detailed cell: surfaces of revolution about the axis (assembly.py cell_lathe)
      for (const part of s.lathe) {
        const pts = part.profile.map(([r, z]) => new THREE.Vector2(r, z));
        pieces.push([new THREE.LatheGeometry(pts, 28).rotateX(Math.PI / 2), part.material]);
      }
    } else if (s.sides) {    // hex prism (coupling nut): a corner on +X, a round hole, extruded along Z
      const hex = new THREE.Shape();
      for (let k = 0; k < s.sides; k++) {
        const a = 2 * Math.PI * k / s.sides;
        if (k === 0) hex.moveTo(s.radius * Math.cos(a), s.radius * Math.sin(a));
        else hex.lineTo(s.radius * Math.cos(a), s.radius * Math.sin(a));
      }
      hex.closePath();
      if (s.inner_radius > 0) hex.holes.push(new THREE.Path().absarc(0, 0, s.inner_radius, 0, Math.PI * 2, true));
      const geom = new THREE.ExtrudeGeometry(hex, { depth: s.length, bevelEnabled: false, curveSegments: 16 });
      pieces.push([geom.translate(0, 0, -s.length / 2), s.material]);
    } else if (s.inner_radius > 0) {    // tube: an annulus extruded along Z, centered on its length
      const ring = new THREE.Shape().absarc(0, 0, s.radius, 0, Math.PI * 2, false);
      ring.holes.push(new THREE.Path().absarc(0, 0, s.inner_radius, 0, Math.PI * 2, true));
      const geom = new THREE.ExtrudeGeometry(ring, { depth: s.length, bevelEnabled: false, curveSegments: 20 });
      pieces.push([geom.translate(0, 0, -s.length / 2), s.material]);
    } else {
      pieces.push([new THREE.CylinderGeometry(s.radius, s.radius, s.length, 28).rotateX(Math.PI / 2), s.material]);
    }
    const meshes = pieces.map(([geom, mat]) => {
      const mesh = new THREE.InstancedMesh(geom, this.materials[mat] || this.materials[s.material], s.centers.length);
      mesh.name = s.name;
      this.group.add(mesh);
      return mesh;
    });
    const offs = offsets(s, s.centers.length), m = new THREE.Matrix4();
    this.movers.push({ apply: t => {
      s.centers.forEach(([x, y, z], i) => {
        if (s.flip && s.flip[i]) m.makeRotationX(Math.PI);    // flipped: positive toward -Z
        else if (s.rotate) m.makeRotationZ(s.rotate[i]);       // turned about Z (hex nuts)
        else m.identity();
        m.setPosition(x + offs[i].x * t, y + offs[i].y * t, z + offs[i].z * t);
        for (const mesh of meshes) mesh.setMatrixAt(i, m);
      });
      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    } });
  }

  addBoxes(s) {
    const textured = (LOOKS[s.material] || {}).texture;
    const geoms = s.boxes.map(([[x0, y0, z0], [x1, y1, z1]]) => {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      if (textured) scaleBoxUVs(g, x1 - x0, y1 - y0, z1 - z0, FOAM_TILE);
      return g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    });
    if (!s.explode_each && geoms.length > 1) {     // all move together: one merged mesh (holder tabs are hundreds of boxes)
      const mesh = new THREE.Mesh(mergeGeometries(geoms), this.materials[s.material]);
      geoms.forEach(g => g.dispose());
      mesh.name = s.name;
      mesh.renderOrder = s.material in SEE_THROUGH ? 1 : 0;
      this.group.add(mesh);
      const off = offsets(s, 1)[0];
      this.movers.push({ apply: t => mesh.position.copy(off).multiplyScalar(t) });
      return;
    }
    const offs = offsets(s, s.boxes.length);
    for (const [i, geom] of geoms.entries()) {
      const mesh = new THREE.Mesh(geom, this.materials[s.material]);
      mesh.name = s.name;
      mesh.renderOrder = s.material in SEE_THROUGH ? 1 : 0;
      this.group.add(mesh);
      this.movers.push({ apply: t => mesh.position.copy(offs[i]).multiplyScalar(t) });
    }
  }

  setAssembly(asm) {
    this.clear();
    for (const s of asm.solids) {
      if (s.type === "extrusion") this.addExtrusion(s);
      else if (s.type === "cylinders") this.addCylinders(s);
      else if (s.type === "boxes") this.addBoxes(s);
    }
    const first = !this.bbox;
    const box = b => new THREE.Box3(new THREE.Vector3(...b[0]), new THREE.Vector3(...b[1]));
    this.bbox = box(asm.bbox);
    this.bboxExploded = box(asm.bbox_exploded || asm.bbox);
    for (const mv of this.movers) mv.apply(this.explode);
    this.fit(first ? VIEW_DIR : null);
  }

  // Exploded view. The camera stays where it is while the slider moves; Reset view frames
  // whatever is showing.
  setExplode(t) {
    this.explode = Math.min(1, Math.max(0, t));
    for (const mv of this.movers) mv.apply(this.explode);
    this.render();
  }

  // Bounding box at the current explode amount (pieces move linearly, so this is close enough
  // for framing the camera).
  currentBox() {
    const t = this.explode, b = this.bbox, e = this.bboxExploded;
    return new THREE.Box3(b.min.clone().lerp(e.min, t), b.max.clone().lerp(e.max, t));
  }

  // Frame the pack. dir = viewing direction (null keeps the current one, so a size change does
  // not throw away the angle the visitor picked). The distance is the closest one that keeps all
  // eight corners of the bounding box in view from that direction.
  fit(dir) {
    if (!this.bbox) return;
    const bbox = this.currentBox();
    const center = bbox.getCenter(new THREE.Vector3());
    const radius = bbox.getSize(new THREE.Vector3()).length() / 2;
    const d = dir ? dir.clone() : this.camera.position.clone().sub(this.controls.target).normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, d).normalize();
    const up = new THREE.Vector3().crossVectors(d, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanH = tanV * this.camera.aspect;
    const { min, max } = bbox;
    let dist = 0;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      const c = new THREE.Vector3(x, y, z).sub(center);
      const toward = c.dot(d);
      dist = Math.max(dist, Math.abs(c.dot(right)) / tanH + toward, Math.abs(c.dot(up)) / tanV + toward);
    }
    dist *= 1.15;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = radius * 0.3;
    this.controls.maxDistance = dist * 6;
    this.controls.update();
    this.render();
  }

  resetView() { this.fit(VIEW_DIR); }

  setSeeThrough(on) {
    this.seeThrough = on;
    this.applySeeThrough();
    this.render();
  }

  applySeeThrough() {
    for (const [name, opacity] of Object.entries(SEE_THROUGH)) {
      const m = this.materials[name];
      m.transparent = this.seeThrough;
      m.opacity = this.seeThrough ? opacity : 1;
      m.depthWrite = !this.seeThrough;
      m.needsUpdate = true;
    }
  }
}

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (e) {
    return false;
  }
}

if (webglAvailable()) {
  window.PackViewer = { mount: el => new Viewer(el) };
  window.dispatchEvent(new Event("packviewer-ready"));
} else {
  window.dispatchEvent(new Event("packviewer-failed"));
}
