// Standalone WebGL version of the homepage SpecularButton rim for /app links.
(() => {
  const buttons = [...document.querySelectorAll('[data-home-specular]')];
  if (!buttons.length) return;

  const vertexSource = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
  const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;
out vec4 fragColor;

float sdRoundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float shapeSDF(vec2 p) { return sdRoundedRect(p, uHalfSize, uRadius); }
float gaussianLine(float d, float sigma) {
  float x = d / (sigma + 1e-6);
  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));
  return exp(-k * x * x);
}
void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = shapeSDF(p);
  vec2 L = vec2(cos(uAngle), sin(uAngle));
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;
  vec2 nEll = normalize(p / (uHalfSize * uHalfSize) + 1e-6);
  float phi = acos(clamp(abs(dot(nEll, L)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);
  float line = gaussianLine(d, uThickness);
  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));
  float hi = line * rim * edgeClamp * uIntensity;
  vec3 col = uBaseColor * base + uLineColor * hi;
  float a = clamp(base + hi, 0.0, 1.0);
  fragColor = vec4(col, a);
}
`;

  function shader(gl, type, source) {
    const item = gl.createShader(type);
    gl.shaderSource(item, source);
    gl.compileShader(item);
    if (gl.getShaderParameter(item, gl.COMPILE_STATUS)) return item;
    gl.deleteShader(item);
    return null;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const dpr = window.devicePixelRatio || 1;
  const states = [];

  for (const button of buttons) {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) continue;
    const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) continue;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) continue;

    const triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const uniforms = Object.fromEntries([
      'uCenter', 'uHalfSize', 'uRadius', 'uAngle', 'uPx', 'uLineColor', 'uBaseColor',
      'uIntensity', 'uShineSize', 'uShineFade', 'uThickness', 'uBaseWidth',
    ].map((name) => [name, gl.getUniformLocation(program, name)]));
    button.querySelector('.home-specular-fx').append(canvas);
    const state = { button, canvas, gl, program, uniforms, angle: 2.4, idleAngle: 2.4, brightness: 0, width: 1, height: 1 };
    const resize = () => {
      const rect = button.getBoundingClientRect();
      state.width = rect.width;
      state.height = rect.height;
      canvas.width = Math.max(1, Math.round((rect.width + 40) * dpr));
      canvas.height = Math.max(1, Math.round((rect.height + 40) * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw(state);
    };
    if (window.ResizeObserver) new ResizeObserver(resize).observe(button);
    else window.addEventListener('resize', resize, { passive: true });
    resize();
    states.push(state);
  }
  if (!states.length) return;

  let pointer = null;
  let frame = 0;
  let last = performance.now();

  function draw(state) {
    const { gl, uniforms, width, height } = state;
    const light = document.documentElement.dataset.theme === 'light';
    const line = light ? 23 / 255 : 1;
    const base = light ? 112 / 255 : 82 / 255;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(state.program);
    gl.uniform2f(uniforms.uCenter, (20 + width / 2) * dpr, (20 + height / 2) * dpr);
    gl.uniform2f(uniforms.uHalfSize, (width / 2) * dpr, (height / 2) * dpr);
    gl.uniform1f(uniforms.uRadius, Math.min(18, width / 2, height / 2) * dpr);
    gl.uniform1f(uniforms.uAngle, state.angle);
    gl.uniform1f(uniforms.uPx, dpr);
    gl.uniform3f(uniforms.uLineColor, line, line, line);
    gl.uniform3f(uniforms.uBaseColor, base, base, base);
    gl.uniform1f(uniforms.uIntensity, state.brightness);
    gl.uniform1f(uniforms.uShineSize, (10 * Math.PI) / 180);
    gl.uniform1f(uniforms.uShineFade, (40 * Math.PI) / 180);
    gl.uniform1f(uniforms.uThickness, dpr);
    gl.uniform1f(uniforms.uBaseWidth, dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function tick(now) {
    frame = 0;
    if (document.hidden || reducedMotion.matches || !finePointer.matches) return;
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const state of states) {
      const rect = state.button.getBoundingClientRect();
      let pointerAngle = null;
      let proximity = 0;
      if (pointer) {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const deltaX = Math.max(rect.left - pointer.x, 0, pointer.x - rect.right);
        const deltaY = Math.max(rect.top - pointer.y, 0, pointer.y - rect.bottom);
        const distance = Math.hypot(deltaX, deltaY);
        if (distance === 0) {
          const x = (pointer.x - centerX) / (rect.width / 2);
          const y = (centerY - pointer.y) / (rect.height / 2);
          pointerAngle = Math.atan2(2 / rect.height, -2 / rect.width) + x * 0.3 + y * 0.15;
        } else {
          pointerAngle = Math.atan2(centerY - pointer.y, pointer.x - centerX);
        }
        const value = Math.max(0, 1 - distance / 250);
        proximity = value * value * (3 - 2 * value);
      }
      state.idleAngle += 0.35 * delta;
      const target = pointerAngle == null ? state.idleAngle : pointerAngle;
      const difference = ((target - state.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      state.angle += difference * (1 - Math.exp(-delta * 7));
      state.brightness += (proximity - state.brightness) * (1 - Math.exp(-delta * 8));
      draw(state);
    }
    frame = requestAnimationFrame(tick);
  }

  function schedule() {
    if (!frame && !document.hidden && !reducedMotion.matches && finePointer.matches) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }
  function refreshPreference() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (reducedMotion.matches || !finePointer.matches) {
      states.forEach((state) => { state.brightness = 0; draw(state); });
    }
    schedule();
  }
  window.addEventListener('pointermove', (event) => { pointer = { x: event.clientX, y: event.clientY }; }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer = null; });
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener?.('change', refreshPreference);
  finePointer.addEventListener?.('change', refreshPreference);
  new MutationObserver(() => states.forEach(draw)).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });
  states.forEach(draw);
  schedule();
})();
