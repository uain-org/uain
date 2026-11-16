import * as THREE from 'three';
import { buildCoin } from './coin3d.js';

// The stage is square and the coin fills 85% of it, matching the static artwork underneath.
const CAMERA_DISTANCE = 4.39;
const MAX_BUFFER = 1400;
const REST = { x: -0.07, y: -0.4, z: -0.05 };
// One slow pass of light across the face, then a long rest.
const SWEEP_PERIOD = 11;
const SWEEP_SPAN = 3.2;
const SWEEP_DELAY = 0.4;
const STILL_SWEEP = 0.42;

// A bright room. coin3d's black studio suits a dark page; on white paper it turns gold to bronze.
function brightStudio(renderer) {
  const room = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(20, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vD; void main(){ vD=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `
        varying vec3 vD;
        void main(){
          vec3 d=normalize(vD);
          float t=d.y*.5+.5;
          vec3 c=mix(vec3(.3,.19,.1),vec3(1.,.86,.62),smoothstep(.1,.55,t));
          c=mix(c,vec3(1.5,1.4,1.2),smoothstep(.55,.95,t));
          // Dark bands around the room give the rim something to contrast against.
          c*=.72+.28*smoothstep(-.2,.2,sin(atan(d.x,d.z)*5.));
          gl_FragColor=vec4(c,1.);
        }`,
    }),
  );
  room.add(dome);
  const box = (w, h, color, i, p) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(i), side: THREE.DoubleSide }),
    );
    m.position.set(...p);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  box(9, 3, 0xfff6e6, 6, [0, 7, 3]);
  box(1.6, 10, 0xffffff, 7, [-7, 1, 4]);
  box(0.8, 10, 0xffe2ad, 5, [7, 0, 5]);
  box(3, 3, 0x7f9bff, 1.6, [6, -4, 2]);
  box(3, 2, 0xff9d7a, 1.4, [-5, -5, 3]);
  const pm = new THREE.PMREMGenerator(renderer);
  const target = pm.fromScene(room, 0.03);
  pm.dispose();
  room.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  return target;
}

// Colour for the struck face, using coin3d's device placement: deep gold field, pale raised AI$.
function faceTint(size, anisotropy) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const m = size / 2;
  const field = x.createRadialGradient(m * 0.72, m * 0.62, 0, m, m, m * 1.05);
  field.addColorStop(0, '#ffd163');
  field.addColorStop(0.6, '#f4ad28');
  field.addColorStop(1, '#e2971b');
  x.fillStyle = field;
  x.fillRect(0, 0, size, size);
  x.translate(m, m);
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `800 ${size * 0.315}px "Bodoni Moda", serif`;
  x.lineJoin = 'round';
  const device = (color, blur, line) => {
    x.filter = `blur(${size / blur}px)`;
    x.fillStyle = x.strokeStyle = color;
    x.lineWidth = size * line;
    x.strokeText('AI$', -size * 0.006, -size * 0.012);
    x.fillText('AI$', -size * 0.006, -size * 0.012);
  };
  device('#a9690c', 110, 0.016);
  device('#fff1bd', 500, 0.0075);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

function glintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const glow = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.16, 'rgba(255,232,170,.7)');
  glow.addColorStop(1, 'rgba(255,200,90,0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, 128, 128);
  x.globalCompositeOperation = 'lighter';
  for (const [w, h] of [[128, 2], [2, 128]]) {
    const ray = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    ray.addColorStop(0, 'rgba(255,255,255,.95)');
    ray.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = ray;
    x.fillRect(64 - w / 2, 64 - h / 2, w, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createGoldCoin(canvas, { mobile, reduced, onReady, onFail }) {
  const cleanups = [];
  let disposed = false, started = false, paused = false, onscreen = true;
  let frame = 0, last = 0, time = 0, px = 0, py = 0, sx = 0, sy = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    for (const clean of cleanups.reverse()) {
      try {
        clean();
      } catch {}
    }
    cleanups.length = 0;
  };
  try {
    const host = canvas.parentElement;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    cleanups.push(() => {
      renderer.dispose();
      renderer.forceContextLoss();
    });
    renderer.setClearColor(0x000000, 0);
    // Neutral keeps gold saturated where ACES would push it towards brown.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.08;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.z = CAMERA_DISTANCE;

    const studio = brightStudio(renderer);
    cleanups.push(() => studio.dispose());

    const coin = buildCoin(studio.texture, renderer, mobile ? 768 : 1024);
    cleanups.push(() =>
      coin.traverse((o) => {
        o.geometry?.dispose();
        const m = o.material;
        m?.map?.dispose();
        m?.normalMap?.dispose();
        m?.roughnessMap?.dispose();
        m?.dispose();
      }),
    );
    scene.add(coin);
    const [front, back, ...edge] = coin.children;
    // The sway never turns past the edge, so the reverse is never seen.
    back.visible = false;
    front.material.color.set(0xffffff);
    front.material.map = faceTint(mobile ? 512 : 1024, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    front.material.envMapIntensity = 1.15;
    for (const part of edge) {
      part.material.color.set(0xffcb57);
      part.material.envMapIntensity = 1.25;
    }

    const key = new THREE.DirectionalLight(0xfff2d6, 2.4);
    key.position.set(-2.5, 3, 4);
    const warm = new THREE.PointLight(0xffefcf, 7, 0, 2);
    warm.position.set(-2.1, 2, 2.6);
    const sweep = new THREE.PointLight(0xfff4dc, 0, 0, 2);
    scene.add(key, warm, sweep);

    const glintMap = glintTexture();
    const glint = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glintMap, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0 }),
    );
    glint.position.set(-0.56, 0.74, 0.3);
    scene.add(glint);
    cleanups.push(() => {
      glintMap.dispose();
      glint.material.dispose();
    });

    const render = () => {
      if (disposed) return;
      const still = reduced;
      const t = still ? 0 : time;
      coin.rotation.set(
        REST.x + (still ? 0 : Math.sin(t * 0.23) * 0.035 + sy * 0.12),
        REST.y + (still ? 0 : Math.sin(t * 0.31) * 0.16 + sx * 0.22 - 0.18 * (1 - Math.min(1, t / 1.8)) ** 4),
        REST.z,
      );
      const phase = ((t + SWEEP_PERIOD - SWEEP_DELAY) % SWEEP_PERIOD) / SWEEP_SPAN;
      const p = still ? STILL_SWEEP : phase;
      const lit = p <= 1 ? Math.sin(p * Math.PI) : 0;
      sweep.intensity = 26 * lit;
      sweep.position.set(-5 + 4.8 * Math.min(1, p), 1.6 - 2 * Math.min(1, p), 2.8);
      glint.material.opacity = lit ** 3 * 0.9;
      glint.scale.setScalar(0.5 + lit * 0.5);
      renderer.render(scene, camera);
    };
    const fit = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h || disposed) return;
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2, MAX_BUFFER / Math.max(w, h)));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // Resizing clears the buffer, and a paused scene has no next frame to repaint it.
      if (started) render();
    };
    const loop = (now) => {
      frame = requestAnimationFrame(loop);
      if (now - last < 15) return;
      time += Math.min(0.05, (now - last) / 1000);
      last = now;
      sx += (px - sx) * 0.05;
      sy += (py - sy) * 0.05;
      render();
    };
    const sync = () => {
      const run = started && !disposed && !paused && !reduced && onscreen && !document.hidden;
      if (run && !frame) {
        last = performance.now();
        frame = requestAnimationFrame(loop);
      } else if (!run && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const lost = (e) => {
      e.preventDefault();
      const fail = onFail;
      dispose();
      fail?.();
    };
    canvas.addEventListener('webglcontextlost', lost);
    cleanups.push(() => canvas.removeEventListener('webglcontextlost', lost));
    document.addEventListener('visibilitychange', sync);
    cleanups.push(() => document.removeEventListener('visibilitychange', sync));
    const sizes = new ResizeObserver(fit);
    sizes.observe(host);
    cleanups.push(() => sizes.disconnect());
    const view = new IntersectionObserver((entries) => {
      onscreen = entries[entries.length - 1].isIntersecting;
      sync();
    });
    view.observe(host);
    cleanups.push(() => view.disconnect());
    if (!mobile && matchMedia('(hover: hover)').matches) {
      const pointer = (e) => {
        px = e.clientX / innerWidth - 0.5;
        py = e.clientY / innerHeight - 0.5;
      };
      addEventListener('pointermove', pointer, { passive: true });
      cleanups.push(() => removeEventListener('pointermove', pointer));
    }
    fit();

    return {
      start() {
        started = true;
        render();
        canvas.classList.add('on');
        onReady?.();
        sync();
      },
      setPaused(value) {
        paused = Boolean(value);
        sync();
      },
      setReduced(value) {
        reduced = Boolean(value);
        sync();
        if (started) render();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
