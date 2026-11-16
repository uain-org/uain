import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LAND } from './landmask.js';
import { buildCoin, studio } from './coin3d.js';

const RADIUS = 3;
const seeded = (s) => () =>
  ((s = Math.imul(s ^ (s >>> 15), s | 1) + 0x6d2b79f5),
  ((s ^ (s >>> 14)) >>> 0) / 4294967296);
// [lat, lon, weight]: where the night lights gather.
const CITIES = [
  [40.7, -74, 5], [34, -118, 4], [41.9, -87.6, 3], [29.7, -95.4, 2.5], [19.4, -99.1, 4],
  [-23.5, -46.6, 5], [-34.6, -58.4, 3], [4.7, -74, 2], [-12, -77, 2], [43.7, -79.4, 2.5],
  [51.5, -0.1, 5], [48.9, 2.4, 4], [52.5, 13.4, 3], [47.4, 8.5, 2.5], [41.9, 12.5, 3],
  [40.4, -3.7, 3], [55.8, 37.6, 4], [41, 29, 4], [30, 31.2, 4], [6.5, 3.4, 4],
  [-1.3, 36.8, 2], [-26.2, 28, 3], [25.2, 55.3, 3], [24.7, 46.7, 2], [19.1, 72.9, 6],
  [28.6, 77.2, 6], [13, 77.6, 4], [23.8, 90.4, 4], [13.8, 100.5, 3.5], [1.35, 103.8, 2.5],
  [-6.2, 106.8, 5], [14.6, 121, 4], [31.2, 121.5, 6], [39.9, 116.4, 5], [22.5, 114, 5],
  [37.6, 127, 4], [35.7, 139.7, 6], [34.7, 135.5, 3.5], [-33.9, 151.2, 3], [-37.8, 145, 2],
];
const ROUTES = [
  [47.4, 8.5, 40.7, -74], [47.4, 8.5, 1.35, 103.8], [47.4, 8.5, 25.2, 55.3], [51.5, -0.1, 19.1, 72.9],
  [40.7, -74, -23.5, -46.6], [34, -118, 35.7, 139.7], [35.7, 139.7, 1.35, 103.8], [31.2, 121.5, 25.2, 55.3],
  [6.5, 3.4, 48.9, 2.4], [-26.2, 28, 51.5, -0.1], [19.1, 72.9, -33.9, 151.2], [37.6, 127, 34, -118],
  [55.8, 37.6, 39.9, 116.4], [41, 29, 28.6, 77.2], [-23.5, -46.6, 6.5, 3.4], [1.35, 103.8, -6.2, 106.8],
];
const onSphere = (lat, lon, r = RADIUS) => {
  const p = (lat * Math.PI) / 180;
  const l = (lon * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(p) * Math.cos(l) * r,
    Math.sin(p) * r,
    -Math.cos(p) * Math.sin(l) * r,
  );
};
function isLand() {
  const bytes = Uint8Array.from(atob(LAND), (c) => c.charCodeAt(0));
  return (lat, lon) => {
    const x = Math.max(0, Math.min(359, Math.floor(lon + 180)));
    const y = Math.max(0, Math.min(179, Math.floor(90 - lat)));
    const i = y * 360 + x;
    return (bytes[i >> 3] >> (i & 7)) & 1;
  };
}
// Land and night lights are baked once into textures, so the shader stays cheap on phones.
function bakeSurface(mobile, anisotropy) {
  const land = isLand();
  const W = mobile ? 1536 : 2560;
  const H = W / 2;
  const mask = document.createElement('canvas');
  mask.width = 360;
  mask.height = 180;
  const m = mask.getContext('2d');
  const id = m.createImageData(360, 180);
  for (let y = 0; y < 180; y++)
    for (let x = 0; x < 360; x++) {
      const i = (y * 360 + x) * 4;
      const v = land(90 - y - 0.5, x - 180 + 0.5) ? 255 : 0;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
  m.putImageData(id, 0, 0);
  const surface = document.createElement('canvas');
  surface.width = 1440;
  surface.height = 720;
  const s = surface.getContext('2d');
  s.filter = 'blur(2px)';
  s.drawImage(mask, 0, 0, 1440, 720);
  const lights = document.createElement('canvas');
  lights.width = W;
  lights.height = H;
  const c = lights.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  const r = seeded(21600);
  const total = CITIES.reduce((a, x) => a + x[2], 0);
  const dot = (lat, lon, a, size) => {
    c.fillStyle = `rgba(255,${190 + r() * 50},${110 + r() * 80},${a})`;
    c.fillRect(((lon + 180) / 360) * W, ((90 - lat) / 180) * H, size, size);
  };
  const gauss = () => (r() + r() + r() - 1.5) / 1.5;
  const n = mobile ? 26000 : 52000;
  for (let i = 0; i < n; i++) {
    let w = r() * total;
    let city = CITIES[0];
    for (const x of CITIES) {
      w -= x[2];
      if (w <= 0) {
        city = x;
        break;
      }
    }
    const spread = r() < 0.5 ? 1.6 : 7;
    const lat = city[0] + gauss() * spread;
    const lon = city[1] + (gauss() * spread) / Math.max(0.3, Math.cos((city[0] * Math.PI) / 180));
    if (land(lat, lon)) dot(lat, lon, 0.25 + r() * 0.75, W / 1500);
  }
  for (let i = 0; i < n / 2; i++) {
    const lat = r() * 130 - 60;
    const lon = r() * 360 - 180;
    if (land(lat, lon)) dot(lat, lon, 0.1 + r() * 0.3, W / 2000);
  }
  c.globalCompositeOperation = 'lighter';
  c.filter = `blur(${W / 700}px)`;
  c.globalAlpha = 0.9;
  c.drawImage(lights, 0, 0);
  const tex = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    return t;
  };
  return { surface: tex(surface), lights: tex(lights) };
}
function buildRoutes(group) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uA: { value: 1 } },
    vertexShader:
      'attribute float aSeed; varying vec2 vUv; varying float vSeed; void main(){ vUv=uv; vSeed=aSeed; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `
      uniform float uTime,uA; varying vec2 vUv; varying float vSeed;
      void main(){
        float t=fract(uTime*.09+vSeed);
        float d=vUv.x-t*1.3+.15;
        float pulse=exp(-d*d*520.);
        float tail=smoothstep(-.32,0.,d)*step(d,0.)*.5;
        vec3 c=mix(vec3(1.,.62,.26),vec3(1.,.93,.75),pulse);
        gl_FragColor=vec4(c*(.45+pulse*3.+tail*1.2),(.28+pulse+tail)*uA);
      }`,
  });
  ROUTES.forEach(([a, b, c, d], i) => {
    const from = onSphere(a, b, RADIUS * 1.002);
    const to = onSphere(c, d, RADIUS * 1.002);
    const span = from.angleTo(to);
    const mid = from.clone().add(to).normalize().multiplyScalar(RADIUS + 0.2 + span * 0.42);
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const geometry = new THREE.TubeGeometry(curve, 96, 0.0065, 5, false);
    geometry.setAttribute(
      'aSeed',
      new THREE.Float32BufferAttribute(
        new Float32Array(geometry.attributes.position.count).fill(i * 0.137),
        1,
      ),
    );
    group.add(new THREE.Mesh(geometry, material));
  });
  return material;
}
export function createEarth(canvas, { mobile, reduced }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !mobile,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.6 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03060d);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  camera.position.z = 11;

  // A sparse real star field keeps the black from feeling flat.
  const r = seeded(4);
  const starN = mobile ? 700 : 1600;
  const sp = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(40);
    sp.set([v.x, v.y, v.z - 6], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(
    sg,
    new THREE.PointsMaterial({ color: 0xbdd2ff, size: 0.09, transparent: true, opacity: 0.7, depthWrite: false }),
  );
  scene.add(stars);

  const { surface, lights } = bakeSurface(mobile, renderer.capabilities.getMaxAnisotropy());
  const sun = new THREE.Vector3(0.8, 0.56, -0.2).normalize();
  const earthPivot = new THREE.Group();
  const earth = new THREE.Group();
  earthPivot.add(earth);
  earthPivot.rotation.z = -0.3;
  scene.add(earthPivot);
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS, mobile ? 96 : 160, mobile ? 64 : 110),
    new THREE.ShaderMaterial({
      uniforms: { uLand: { value: surface }, uLights: { value: lights }, uSun: { value: sun } },
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ vUv=uv; vec4 m=modelViewMatrix*vec4(position,1.);
          vN=normalize(normalMatrix*normal); vV=normalize(-m.xyz); gl_Position=projectionMatrix*m; }`,
      fragmentShader: `
        uniform sampler2D uLand,uLights; uniform vec3 uSun;
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){
          vec3 N=normalize(vN), V=normalize(vV);
          float land=texture2D(uLand,vUv).r;
          vec3 night=texture2D(uLights,vUv).rgb;
          float sunDot=dot(N,uSun);
          float day=smoothstep(-.12,.42,sunDot);
          vec3 ocean=mix(vec3(.0006,.0016,.0065),vec3(.003,.012,.042),day);
          vec3 soil=mix(vec3(.0028,.0042,.0085),vec3(.03,.04,.05),day);
          vec3 col=mix(ocean,soil,land);
          vec3 H=normalize(uSun+V);
          float glint=pow(max(dot(N,H),0.),420.)*(1.-land)*day;
          col+=vec3(.75,.84,1.)*glint*.5;
          col+=night*night*vec3(1.,.7,.4)*(1.-day*.92)*4.2;
          float f=pow(clamp(1.-dot(N,V),0.,1.),3.);
          col+=vec3(.12,.36,1.)*f*(.05+day*1.5);
          float term=exp(-pow((sunDot-.06)*6.,2.));
          col+=vec3(.9,.42,.14)*term*f*.75;
          gl_FragColor=vec4(col,1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  earth.add(body);
  const routes = buildRoutes(earth);
  const air = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 1.09, 96, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSun: { value: sun } },
      vertexShader:
        'varying vec3 vN; varying vec3 vV; void main(){ vec4 m=modelViewMatrix*vec4(position,1.); vN=normalize(normalMatrix*normal); vV=normalize(-m.xyz); gl_Position=projectionMatrix*m; }',
      fragmentShader: `
        uniform vec3 uSun; varying vec3 vN; varying vec3 vV;
        void main(){
          vec3 N=normalize(vN);
          float d=clamp(dot(-N,normalize(vV)),0.,1.);
          float g=pow(d,6.)*.9;
          float lit=smoothstep(-.6,.6,dot(-N,-uSun)*-1.);
          vec3 c=vec3(.09,.3,.95)*(.1+lit*1.5);
          gl_FragColor=vec4(c*g,g);
        }`,
    }),
  );
  earthPivot.add(air);

  const env = studio(renderer);
  const coinPivot = new THREE.Group();
  const coin = buildCoin(env, renderer, mobile ? 1024 : 1536);
  coinPivot.add(coin);
  scene.add(coinPivot);

  let composer = null;
  let bloom = null;
  if (!mobile) {
    composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }),
    );
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.2, 0.55, 1.1);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }
  const state = {
    ex: mobile ? 0.3 : 2.1,
    ey: mobile ? -4 : -3.1,
    es: mobile ? 1.1 : 1.32,
    dim: 1,
    coinScale: 0.001,
    coinX: 0,
    coinY: 0,
    coinTurn: 0,
  };
  let px = 0, py = 0, sx = 0, sy = 0;
  let paused = false, visible = true, disposed = false, frame = 0, last = 0, spin = 0;
  const pointer = (e) => {
    px = e.clientX / innerWidth - 0.5;
    py = e.clientY / innerHeight - 0.5;
  };
  addEventListener('pointermove', pointer, { passive: true });
  const fit = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    camera.aspect = w / h;
    camera.position.z = Math.max(11, 11 * (0.9 / camera.aspect));
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', fit);
  fit();
  const render = (now = 0) => {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (!paused && !reduced) spin += dt;
    sx += (px - sx) * 0.05;
    sy += (py - sy) * 0.05;
    earthPivot.position.set(state.ex, state.ey, 0);
    earthPivot.scale.setScalar(state.es);
    earthPivot.visible = state.dim > 0.01;
    earth.rotation.y = -1.25 + spin * 0.028 + sx * 0.1;
    earth.rotation.x = 0.1 + sy * 0.05;
    routes.uniforms.uTime.value = spin;
    routes.uniforms.uA.value = state.dim;
    stars.rotation.y = spin * 0.002 + sx * 0.02;
    stars.rotation.x = sy * 0.02;
    coinPivot.visible = state.coinScale > 0.01;
    coinPivot.position.set(state.coinX, state.coinY, 0);
    coinPivot.scale.setScalar(state.coinScale * 1.6);
    coin.rotation.y = -0.66 + state.coinTurn + sx * 0.6 + Math.sin(spin * 0.4) * 0.2;
    coin.rotation.x = 0.2 + sy * 0.35;
    coin.rotation.z = -0.08;
    if (bloom) bloom.strength = 0.2 * (1 - Math.min(1, state.coinScale) * 0.8);
    if (composer) composer.render();
    else renderer.render(scene, camera);
  };
  const loop = (now) => {
    if (disposed) return;
    if (visible) render(now);
    frame = requestAnimationFrame(loop);
  };
  const vis = () => {
    visible = !document.hidden;
  };
  document.addEventListener('visibilitychange', vis);
  return {
    state,
    render,
    start() {
      canvas.classList.add('on');
      if (reduced) render();
      else frame = requestAnimationFrame(loop);
    },
    setPaused(v) {
      paused = v;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      removeEventListener('pointermove', pointer);
      removeEventListener('resize', fit);
      document.removeEventListener('visibilitychange', vis);
      scene.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat()) m?.dispose();
      });
      surface.dispose();
      lights.dispose();
      env.dispose();
      composer?.dispose();
      renderer.dispose();
    },
  };
}
