import * as THREE from 'three';

// Height field for a struck proof coin. Everything else is derived from this.
function drawHeight(size, back) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const m = size / 2;
  x.fillStyle = '#6a6a6a';
  x.fillRect(0, 0, size, size);
  x.translate(m, m);
  // Guilloche field, cut into the planchet.
  x.strokeStyle = '#8c8c8c';
  x.lineWidth = size / 900;
  for (let k = 0; k < 26; k++) {
    x.beginPath();
    for (let i = 0; i <= 720; i++) {
      const t = (i / 720) * Math.PI * 2;
      const r = m * (0.34 + k * 0.0165) * (1 + 0.07 * Math.sin(16 * t + k * 0.42));
      x[i ? 'lineTo' : 'moveTo'](Math.cos(t) * r, Math.sin(t) * r);
    }
    x.closePath();
    x.stroke();
  }
  // Inner bead ring.
  x.fillStyle = '#c8c8c8';
  for (let i = 0; i < 144; i++) {
    const t = (i / 144) * Math.PI * 2;
    x.beginPath();
    x.arc(Math.cos(t) * m * 0.775, Math.sin(t) * m * 0.775, size * 0.0028, 0, 7);
    x.fill();
  }
  // Legend around the rim.
  const legend = back ? 'ONE AI DOLLAR  ✦  21,600 CHALLENGES  ✦  108 TRILLION MAXIMUM SUPPLY  ✦  ' : 'UNITED INTELLIGENCE  ✦  UNITED ECONOMY  ✦  A BETTER TOMORROW  ✦  ';
  x.font = `600 ${size * 0.046}px "Bodoni Moda", serif`;
  x.fillStyle = '#e6e6e6';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const w = x.measureText(legend).width;
  const R = m * 0.86;
  let a = -Math.PI / 2;
  const scale = (Math.PI * 2 * R) / w;
  for (const ch of legend) {
    const adv = (x.measureText(ch).width * scale) / R;
    x.save();
    x.rotate(a + adv / 2 + Math.PI / 2);
    x.translate(0, -R);
    x.fillText(ch, 0, 0);
    x.restore();
    a += adv;
  }
  // The device, raised with a soft shoulder so it catches light.
  const device = (draw) => {
    x.save();
    x.filter = `blur(${size / 170}px)`;
    x.fillStyle = '#b4b4b4';
    draw();
    x.filter = `blur(${size / 700}px)`;
    x.fillStyle = '#ffffff';
    draw();
    x.restore();
  };
  if (back) {
    device(() => { x.font = `700 ${size * 0.42}px "Bodoni Moda", serif`; x.fillText('1', 0, -size * 0.02); });
    device(() => { x.font = `600 ${size * 0.05}px "Bodoni Moda", serif`; x.fillText('AI DOLLAR', 0, size * 0.235); });
  } else {
    device(() => {
      x.font = `800 ${size * 0.315}px "Bodoni Moda", serif`;
      x.lineWidth = size * 0.0075;
      x.lineJoin = 'round';
      x.strokeStyle = x.fillStyle;
      x.strokeText('AI$', -size * 0.006, -size * 0.012);
      x.fillText('AI$', -size * 0.006, -size * 0.012);
    });
  }
  return c;
}

function deriveMaps(height, renderer) {
  const s = height.width;
  const src = height.getContext('2d').getImageData(0, 0, s, s).data;
  const n = new Uint8ClampedArray(s * s * 4);
  const rm = new Uint8ClampedArray(s * s * 4);
  const h = (x, y) => src[(((y + s) % s) * s + ((x + s) % s)) * 4] / 255;
  const k = 7.5;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * k;
    const dy = (h(x, y + 1) - h(x, y - 1)) * k;
    const l = Math.hypot(dx, dy, 1);
    const i = (y * s + x) * 4;
    n[i] = (-dx / l) * 127.5 + 127.5;
    n[i + 1] = (dy / l) * 127.5 + 127.5;
    n[i + 2] = (1 / l) * 127.5 + 127.5;
    n[i + 3] = 255;
    // Proof finish: mirror field, frosted raised device.
    const v = h(x, y);
    rm[i] = rm[i + 2] = 0;
    rm[i + 1] = 255 * (0.13 + Math.max(0, v - 0.5) * 0.6 + (Math.random() - 0.5) * 0.015);
    rm[i + 3] = 255;
  }
  const tex = (data, srgb) => {
    const t = new THREE.DataTexture(data, s, s, THREE.RGBAFormat);
    t.flipY = true;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
  };
  return { normal: tex(n), rough: tex(rm) };
}

// A black studio with softboxes. Metal only looks real with something to reflect.
export function studio(renderer) {
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x02040c);
  const box = (w, h, color, i, p) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(i), side: THREE.DoubleSide }));
    m.position.set(...p);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  box(7, 2, 0xfff1d6, 3.6, [0, 6, 3]);
  box(1.2, 9, 0xffffff, 5, [-6, 1, 3]);
  box(0.5, 9, 0xffd9a0, 3.4, [6.2, -1, 4]);
  box(9, 0.6, 0xbfd4ff, 2, [0, -6, 2]);
  box(3, 3, 0x6d8dff, 1, [5, 4, -5]);
  box(2.4, 0.5, 0xffffff, 6, [2.4, 2.4, 6]);
  box(0.4, 3, 0xffe7bd, 4.5, [-2.6, -2.2, 6]);
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(room, 0.025).texture;
  pm.dispose();
  return env;
}

export function buildCoin(env, renderer, size) {
  const coin = new THREE.Group();
  const gold = (o = {}) => new THREE.MeshPhysicalMaterial({ color: 0xffc04e, metalness: 1, roughness: 0.2, envMap: env, envMapIntensity: 1, ...o });
  const T = 0.16, F = 0.945;
  const face = (back) => {
    const { normal, rough } = deriveMaps(drawHeight(size, back), renderer);
    const m = new THREE.Mesh(new THREE.CircleGeometry(F, 128), gold({ normalMap: normal, normalScale: new THREE.Vector2(1, 1), roughnessMap: rough, roughness: 1, metalnessMap: null, clearcoat: 0.35, clearcoatRoughness: 0.08 }));
    m.position.z = (back ? -1 : 1) * T * 0.46;
    if (back) m.rotation.y = Math.PI;
    return m;
  };
  coin.add(face(false), face(true));
  const profile = [[F - 0.002, T * 0.46], [F + 0.012, T * 0.56], [0.985, T * 0.555], [1, T * 0.49], [1, -T * 0.49], [0.985, -T * 0.555], [F + 0.012, -T * 0.56], [F - 0.002, -T * 0.46]];
  const rim = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 200), gold({ roughness: 0.16, side: THREE.DoubleSide }));
  rim.rotation.x = Math.PI / 2;
  coin.add(rim);
  // Reeded edge.
  const c = document.createElement('canvas');
  c.width = 32; c.height = 2;
  const x = c.getContext('2d');
  for (let i = 0; i < 32; i++) {
    const v = Math.sin((i / 32) * Math.PI * 2) * 100;
    x.fillStyle = `rgb(${127 + v},128,255)`;
    x.fillRect(i, 0, 1, 2);
  }
  const reed = new THREE.CanvasTexture(c);
  reed.wrapS = reed.wrapT = THREE.RepeatWrapping;
  reed.repeat.set(220, 1);
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.001, 1.001, T * 0.92, 200, 1, true), gold({ normalMap: reed, roughness: 0.28 }));
  wall.rotation.x = Math.PI / 2;
  coin.add(wall);
  return coin;
}
