// Theme preference: the tiny head bootstrap prevents a flash; this controller
// owns the visible toggle, persistence, and live system-preference changes.
(function () {
  const root = document.documentElement;
  const toggle = document.querySelector('.theme-toggle');
  const storageKey = 'zeroone_theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

  function storedTheme() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  }

  function syncControl(theme) {
    if (!toggle) return;
    const isDark = theme === 'dark';
    const nextLabel = isDark ? '切换为浅色模式' : '切换为深色模式';
    toggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    toggle.setAttribute('aria-label', nextLabel);
    toggle.title = nextLabel;
    const label = toggle.querySelector('.theme-toggle-label');
    if (label) label.textContent = isDark ? '外观 · 深色' : '外观 · 浅色';
  }

  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    syncControl(theme);
    if (!persist) return;
    try { localStorage.setItem(storageKey, theme); } catch { /* Preference is optional. */ }
  }

  syncControl(root.dataset.theme || (systemTheme.matches ? 'dark' : 'light'));
  if (toggle) {
    toggle.addEventListener('click', () => {
      applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
    });
  }

  const onSystemChange = (event) => {
    if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light', false);
  };
  if (systemTheme.addEventListener) systemTheme.addEventListener('change', onSystemChange);
  else if (systemTheme.addListener) systemTheme.addListener(onSystemChange);
})();


// Native Threads background for the Jinja site. It matches the requested
// amplitude=1, distance=0 and pointer interaction without adding React/OGL.
(function () {
  const container = document.querySelector('[data-threads]');
  if (!container) return;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', {alpha: true, antialias: false});
  if (!gl) return;
  container.appendChild(canvas);

  const vertexSource = `
    attribute vec2 aPosition;
    void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
  `;
  const fragmentSource = `
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform vec3 uColor;
    uniform float uAmplitude;
    uniform float uDistance;
    uniform vec2 uMouse;

    const float PI = 3.1415926538;
    const int LINE_COUNT = 40;
    const float LINE_WIDTH = 7.0;
    const float LINE_BLUR = 10.0;

    float perlin2D(vec2 point) {
      vec2 cell = floor(point);
      vec4 local = point.xyxy - vec4(cell, cell + 1.0);
      vec4 lattice = vec4(cell.xy, cell.xy + 1.0);
      lattice = lattice - floor(lattice * (1.0 / 71.0)) * 71.0;
      lattice += vec2(26.0, 161.0).xyxy;
      lattice *= lattice;
      lattice = lattice.xzxz * lattice.yyww;
      vec4 gradX = fract(lattice * (1.0 / 951.135664)) - 0.49999;
      vec4 gradY = fract(lattice * (1.0 / 642.949883)) - 0.49999;
      vec4 gradients = inversesqrt(gradX * gradX + gradY * gradY)
        * (gradX * local.xzxz + gradY * local.yyww);
      gradients *= 1.4142135623730950;
      vec2 blend = local.xy * local.xy * local.xy
        * (local.xy * (local.xy * 6.0 - 15.0) + 10.0);
      vec4 weights = vec4(blend, vec2(1.0 - blend));
      return dot(gradients, weights.zxzx * weights.wwyy);
    }

    float pixel(float count) {
      return (1.0 / max(uResolution.x, uResolution.y)) * count;
    }

    float threadLine(vec2 uv, float width, float progress) {
      float splitPoint = 0.1 + progress * 0.4;
      float amplitudeNormal = smoothstep(splitPoint, 0.7, uv.x);
      float finalAmplitude = amplitudeNormal * 0.5 * uAmplitude
        * (1.0 + (uMouse.y - 0.5) * 0.2);
      float scaledTime = uTime / 10.0 + (uMouse.x - 0.5);
      float blur = smoothstep(splitPoint, splitPoint + 0.05, uv.x) * progress;
      float xNoise = mix(
        perlin2D(vec2(scaledTime, uv.x + progress) * 2.5),
        perlin2D(vec2(scaledTime, uv.x + scaledTime) * 3.5) / 1.5,
        uv.x * 0.3
      );
      float y = 0.5 + (progress - 0.5) * uDistance
        + xNoise * 0.5 * finalAmplitude;
      float start = smoothstep(
        y + width * 0.5 + LINE_BLUR * pixel(1.0) * blur,
        y,
        uv.y
      );
      float end = smoothstep(
        y,
        y - width * 0.5 - LINE_BLUR * pixel(1.0) * blur,
        uv.y
      );
      return clamp(
        (start - end) * (1.0 - smoothstep(0.0, 1.0, pow(progress, 0.3))),
        0.0,
        1.0
      );
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution;
      float lineStrength = 1.0;
      for (int i = 0; i < LINE_COUNT; i++) {
        float progress = float(i) / float(LINE_COUNT);
        float width = LINE_WIDTH * pixel(1.0) * (1.0 - progress);
        lineStrength *= (1.0 - threadLine(uv, width, progress));
      }
      float colorValue = 1.0 - lineStrength;
      gl_FragColor = vec4(uColor * colorValue, colorValue);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  }

  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniforms = {
    time: gl.getUniformLocation(program, 'uTime'),
    resolution: gl.getUniformLocation(program, 'uResolution'),
    color: gl.getUniformLocation(program, 'uColor'),
    amplitude: gl.getUniformLocation(program, 'uAmplitude'),
    distance: gl.getUniformLocation(program, 'uDistance'),
    mouse: gl.getUniformLocation(program, 'uMouse')
  };
  const amplitude = 1;
  const distance = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let mouse = [0.5, 0.5];
  let targetMouse = [0.5, 0.5];
  let color = [1, 1, 1];

  function syncColor() {
    const values = getComputedStyle(document.documentElement)
      .getPropertyValue('--threads-color')
      .split(',')
      .map(value => Number(value.trim()) / 255);
    color = values.length === 3 && values.every(Number.isFinite) ? values : [1, 1, 1];
  }

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    const longest = Math.max(width, height) * baseDpr;
    const dpr = longest > 1920 ? (baseDpr * 1920) / longest : baseDpr;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw(time) {
    mouse[0] += (targetMouse[0] - mouse[0]) * 0.05;
    mouse[1] += (targetMouse[1] - mouse[1]) * 0.05;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uniforms.time, time * 0.001);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform3f(uniforms.color, color[0], color[1], color[2]);
    gl.uniform1f(uniforms.amplitude, amplitude);
    gl.uniform1f(uniforms.distance, distance);
    gl.uniform2f(uniforms.mouse, mouse[0], mouse[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let frameId = 0;
  function frame(time) {
    frameId = 0;
    if (document.hidden || reducedMotion.matches) {
      draw(0);
      return;
    }
    draw(time);
    schedule();
  }

  function schedule() {
    if (!frameId) frameId = window.requestAnimationFrame(frame);
  }

  window.addEventListener('pointermove', event => {
    targetMouse = [event.clientX / window.innerWidth, 1 - event.clientY / window.innerHeight];
  }, {passive: true});
  window.addEventListener('resize', resize, {passive: true});
  new MutationObserver(syncColor).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });
  document.addEventListener('visibilitychange', schedule);
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', schedule);

  syncColor();
  resize();
  draw(0);
  schedule();
})();


// Reference-style navbar: transparent at the top, compact glass capsule after
// the first scroll. requestAnimationFrame prevents scroll-handler layout churn.
(function () {
  const header = document.querySelector('.site-header');
  if (!header) return;
  let queued = false;

  function update() {
    header.classList.toggle('is-scrolled', window.scrollY > 24);
    queued = false;
  }

  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(update);
  }, {passive: true});
  update();
})();


// Native StrokeText adaptation for the two Hub display lines. Source text stays
// readable without JavaScript; enhancement adds a neutral 4s forward + 4s return shine.
(function () {
  const elements = Array.from(document.querySelectorAll('[data-stroke-text]'));
  if (!elements.length) return;

  const namespace = 'http://www.w3.org/2000/svg';
  const drawDuration = 1;
  const fillDelay = 0.15;
  const stagger = 0.035;
  const strokeWidth = 1.1;
  const fontWeight = 800;
  const defaultLetterSpacing = -4;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function createSvgElement(name, attributes = {}) {
    const node = document.createElementNS(namespace, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function enhance(element, elementIndex) {
    const text = element.textContent.trim();
    if (!text) return;

    const fontSize = Number(element.dataset.fontSize);
    const letterSpacing = Number(element.dataset.letterSpacing || defaultLetterSpacing);
    const characters = Array.from(text);
    const padding = Math.max(6, fontSize * 0.08);
    const baseline = fontSize + padding;
    const fillStart = drawDuration + Math.max(0, characters.length - 1) * stagger + fillDelay;
    const fillEnd = fillStart + drawDuration;
    const idBase = `stroke-text-${elementIndex}`;

    const accessible = document.createElement('span');
    accessible.className = 'stroke-text-accessible';
    accessible.textContent = text;

    const visual = document.createElement('span');
    visual.className = 'stroke-text-visual';
    visual.setAttribute('aria-hidden', 'true');

    const svg = createSvgElement('svg', {
      class: 'stroke-text-svg',
      preserveAspectRatio: 'xMidYMid meet',
      focusable: 'false'
    });
    const definitions = createSvgElement('defs');
    const mask = createSvgElement('mask', {
      id: `${idBase}-fill-mask`,
      maskUnits: 'userSpaceOnUse'
    });
    const wipe = createSvgElement('rect', {
      class: 'stroke-text-fill-wipe',
      fill: '#ffffff'
    });
    mask.appendChild(wipe);
    definitions.appendChild(mask);
    svg.appendChild(definitions);

    const textAttributes = {
      x: padding,
      y: baseline,
      'font-size': fontSize,
      'font-weight': fontWeight,
      'letter-spacing': letterSpacing,
      'xml:space': 'preserve'
    };
    const fill = createSvgElement('text', {
      ...textAttributes,
      class: 'stroke-text-fill',
      mask: `url(#${idBase}-fill-mask)`
    });
    fill.textContent = text;
    svg.appendChild(fill);

    let shinyFill = null;
    if (element.hasAttribute('data-shiny-after-fill')) {
      const gradient = createSvgElement('linearGradient', {
        id: `${idBase}-shiny`,
        gradientUnits: 'userSpaceOnUse'
      });
      [
        ['0%', 'var(--shiny-base)'],
        ['40%', 'var(--shiny-base)'],
        ['50%', 'var(--shiny-highlight)'],
        ['60%', 'var(--shiny-base)'],
        ['100%', 'var(--shiny-base)']
      ].forEach(([offset, color]) => {
        gradient.appendChild(createSvgElement('stop', {'offset': offset, 'stop-color': color}));
      });
      definitions.appendChild(gradient);
      shinyFill = createSvgElement('text', {
        ...textAttributes,
        class: 'stroke-text-fill stroke-text-shiny-fill',
        mask: `url(#${idBase}-fill-mask)`
      });
      shinyFill.style.setProperty('--stroke-shiny-fill', `url(#${idBase}-shiny)`);
      shinyFill.textContent = text;
      svg.appendChild(shinyFill);
    }

    visual.appendChild(svg);
    element.replaceChildren(accessible, visual);
    element.classList.add('is-enhanced');

    const bounds = fill.getBBox();
    const viewX = bounds.x - padding;
    const viewY = bounds.y - padding;
    const viewWidth = bounds.width + padding * 2;
    const viewHeight = bounds.height + padding * 2;
    svg.setAttribute('viewBox', `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);
    svg.setAttribute('width', viewWidth);
    svg.setAttribute('height', viewHeight);
    visual.style.setProperty('--stroke-natural-width', `${viewWidth}px`);
    wipe.setAttribute('x', viewX);
    wipe.setAttribute('y', viewY);
    wipe.setAttribute('width', viewWidth);
    wipe.setAttribute('height', viewHeight);
    element.style.setProperty('--fill-delay', `${fillStart}s`);
    element.style.setProperty('--shiny-delay', `${fillEnd}s`);

    characters.forEach((character, characterIndex) => {
      if (/\s/.test(character)) return;
      const start = fill.getStartPositionOfChar(characterIndex);
      const outline = createSvgElement('text', {
        x: start.x,
        y: baseline,
        class: 'stroke-text-char',
        'font-size': fontSize,
        'font-weight': fontWeight,
        'xml:space': 'preserve'
      });
      outline.textContent = character;
      outline.style.setProperty('--stroke-delay', `${characterIndex * stagger}s`);
      outline.style.setProperty('stroke-width', `${strokeWidth}px`);
      svg.appendChild(outline);
    });

    if (shinyFill && !reducedMotion.matches) {
      const gradient = definitions.querySelector('linearGradient');
      gradient.setAttribute('x1', bounds.x - bounds.width);
      gradient.setAttribute('x2', bounds.x + bounds.width);
      gradient.setAttribute('y1', '0');
      gradient.setAttribute('y2', '0');
      const flow = createSvgElement('animateTransform', {
        attributeName: 'gradientTransform',
        type: 'translate',
        values: `0 0; ${bounds.width} 0; 0 0`,
        keyTimes: '0; 0.5; 1',
        dur: '8s',
        begin: `${fillEnd}s`,
        repeatCount: 'indefinite',
        calcMode: 'linear'
      });
      gradient.appendChild(flow);
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => element.classList.add('is-running'));
    });
  }

  const mount = () => elements.forEach(enhance);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(mount);
  } else {
    mount();
  }
})();


// Pointer-following specular highlight. Only explicitly approved CTA elements
// opt in; no node is wrapped or replaced, so existing click/loading hooks stay intact.
(function () {
  const buttons = Array.from(document.querySelectorAll('.specular-button'));
  if (!buttons.length) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const proximity = 250;
  let pointer = null;
  let queued = false;

  function clear() {
    buttons.forEach((button) => button.style.setProperty('--shine-opacity', '0'));
  }

  function render() {
    queued = false;
    if (!pointer || reducedMotion.matches || !finePointer.matches) {
      clear();
      return;
    }
    buttons.forEach((button) => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
        button.style.setProperty('--shine-opacity', '0');
        return;
      }
      const rect = button.getBoundingClientRect();
      const nearestX = Math.max(rect.left, Math.min(pointer.x, rect.right));
      const nearestY = Math.max(rect.top, Math.min(pointer.y, rect.bottom));
      const distance = Math.hypot(pointer.x - nearestX, pointer.y - nearestY);
      const intensity = Math.max(0, 1 - distance / proximity);
      button.style.setProperty('--shine-x', `${nearestX - rect.left}px`);
      button.style.setProperty('--shine-y', `${nearestY - rect.top}px`);
      button.style.setProperty('--shine-opacity', intensity.toFixed(3));
    });
  }

  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(render);
  }

  document.addEventListener('pointermove', (event) => {
    pointer = {x: event.clientX, y: event.clientY};
    schedule();
  }, {passive: true});
  window.addEventListener('scroll', () => { pointer = null; schedule(); }, {passive: true});
  window.addEventListener('blur', () => { pointer = null; schedule(); });
  const syncPreference = () => { pointer = null; schedule(); };
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', syncPreference);
  if (finePointer.addEventListener) finePointer.addEventListener('change', syncPreference);
})();


// Scroll reveal is progressive enhancement: content is visible by default and
// receives a single entrance animation only when it first crosses the viewport.
(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches || !('IntersectionObserver' in window)) return;

  const selector = [
    '.trust-strip', '.protocol-card', '.how-it-works > h2', '.how-steps > li',
    '.hub-note', '.features > .feature',
    '.lb-row', '.faq-category', '.result-card', '.metrics-row', '.details-card'
  ].join(', ');
  const targets = Array.from(document.querySelectorAll(selector))
    .filter((element) => element.getBoundingClientRect().top >= window.innerHeight * 0.9);
  if (!targets.length) return;

  const siblingOrder = new Map();
  targets.forEach((element) => {
    const parent = element.parentElement;
    const order = siblingOrder.get(parent) || 0;
    element.style.setProperty('--reveal-delay', `${Math.min(order, 3) * 45}ms`);
    siblingOrder.set(parent, order + 1);
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const element = entry.target;
      element.classList.add('reveal-enter');
      element.addEventListener('animationend', () => element.classList.remove('reveal-enter'), {once: true});
      observer.unobserve(element);
    });
  }, {threshold: 0.08, rootMargin: '0px 0px -8% 0px'});
  targets.forEach((element) => observer.observe(element));
})();


// Mobile nav hamburger toggle. Pure aria-expanded toggling; CSS does the
// rest via the sibling selector. Closes on outside tap, on ESC, and on
// link tap so the dropdown doesn't linger after navigation.
(function () {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    setOpen(!isOpen);
  });

  // Close on tap outside the dropdown.
  document.addEventListener('click', (e) => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    if (nav.contains(e.target) || toggle.contains(e.target)) return;
    setOpen(false);
  });

  // Close after a nav link is tapped — otherwise the panel stays open over
  // the new page transition (jarring on mobile).
  nav.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
})();


// Custom model-name combobox: type-to-filter + tap-to-select.
// Replaces native <datalist> because iOS Safari / WeChat browser don't show
// it reliably on mobile.
(function () {
  const input = document.getElementById('model');
  const list = document.getElementById('model-list');
  if (!input || !list) return;
  let items = Array.from(list.querySelectorAll('.combo-item'));

  // De-emphasize non-matches instead of hiding them. Users repeatedly
  // expected the dropdown to show ALL probed models even after typing a
  // partial name (so they can compare options or pick a sibling). Hiding
  // made the relay's full whitelist invisible — exactly the opposite of
  // what /api/probe was meant to surface. Dimming preserves discoverability
  // while still highlighting the current text query.
  function filter(q) {
    const ql = (q || '').toLowerCase().trim();
    items.forEach((it) => {
      const v = (it.getAttribute('data-value') || '').toLowerCase();
      const match = ql === '' || v.includes(ql);
      it.classList.toggle('no-match', !match);
      it.hidden = false;
    });
    list.hidden = items.length === 0;
  }

  function bindItem(it) {
    // pointerdown beats focus loss; preventDefault keeps input focused so
    // mobile keyboard doesn't close before we set the value.
    it.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      input.value = it.getAttribute('data-value');
      list.hidden = true;
      input.blur();
    });
  }
  items.forEach(bindItem);

  // Exposed so the probe layer can replace the suggestions with whatever
  // the relay actually advertises. Falls back to the static template list
  // if probe fails / relay doesn't expose /v1/models.
  window.veridropSetModelChoices = function (values) {
    list.innerHTML = '';
    values.forEach((v) => {
      const li = document.createElement('li');
      li.className = 'combo-item';
      li.setAttribute('data-value', v);
      li.textContent = v;
      list.appendChild(li);
    });
    items = Array.from(list.querySelectorAll('.combo-item'));
    items.forEach(bindItem);
  };

  input.addEventListener('focus', () => filter(input.value));
  input.addEventListener('input', () => filter(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') list.hidden = true;
  });

  document.addEventListener('pointerdown', (e) => {
    if (e.target === input || list.contains(e.target)) return;
    list.hidden = true;
  });
})();


// Pre-submission probe: hit /api/probe on api_key blur, render an inline
// pill below the api_key input describing what the relay carries, replace
// the model dropdown with the actually-available models, and (when the
// current protocol has 0 matches) offer one-click handoff to a protocol
// the relay DOES carry.
(function () {
  const protocol =
    location.pathname.startsWith('/claude') ? 'anthropic' :
    location.pathname.startsWith('/openai') ? 'openai' :
    location.pathname.startsWith('/gemini') ? 'gemini' : null;
  if (!protocol) return;

  const protoLabel = {anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini'}[protocol];
  const protoPath = {anthropic: '/claude', openai: '/openai', gemini: '/gemini'};

  const baseUrlInput = document.getElementById('base_url');
  const apiKeyInput = document.getElementById('api_key');
  const modelInput = document.getElementById('model');
  if (!baseUrlInput || !apiKeyInput) return;

  // Inject pill container right after the api_key field's hint.
  const apiKeyField = apiKeyInput.closest('.field');
  const pill = document.createElement('div');
  pill.id = 'probe-pill';
  pill.className = 'probe-pill';
  pill.hidden = true;
  apiKeyField.appendChild(pill);

  let inflight = null;
  let lastKey = null;

  async function runProbe() {
    const baseUrl = baseUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!baseUrl || !apiKey || apiKey.length < 8) return;
    if (!/^https?:\/\//.test(baseUrl)) return;

    const key = baseUrl + '|' + apiKey.length + ':' + apiKey.slice(-4);
    if (key === lastKey) return; // already probed this combo
    lastKey = key;

    setPill('neutral', '🔄 正在识别中转站可用模型...');
    if (inflight) inflight.abort && inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;

    const fd = new FormData();
    fd.set('base_url', baseUrl);
    fd.set('api_key', apiKey);
    let r, data;
    try {
      r = await fetch('/api/probe', {method: 'POST', body: fd, signal: ctrl.signal});
      data = await r.json();
    } catch (e) {
      if (e.name === 'AbortError') return;
      setPill('warn', '⚪ 探测失败,但不影响检测继续 — 你填的模型会被直接尝试');
      setSubmitEnabled(true);
      return;
    }
    if (r.status === 429) {
      // Rate limited — surface clearly and keep submit enabled so the user
      // can still proceed (they're not blocked from detection itself).
      setPill('warn', '⚠ ' + (data.error || '探测过于频繁,稍后再试') + '(检测仍可正常提交)');
      setSubmitEnabled(true);
      lastKey = null; // allow retry after backoff
      return;
    }
    renderProbeResult(data);
  }

  function renderProbeResult(data) {
    if (!data.ok) {
      // Auth fail vs other errors — auth_ok=false is the only blocking case
      if (data.auth_ok === false) {
        setPill('fail', '🔴 ' + (data.error || '鉴权失败'));
        setSubmitEnabled(false, 'API key 鉴权失败');
      } else {
        setPill('warn', '⚪ ' + (data.error || '探测失败') + ' — 不影响检测继续');
        setSubmitEnabled(true);
      }
      return;
    }

    if (!data.models_endpoint_supported) {
      setPill('neutral', '⚪ ' + (data.note || '该中转站不暴露 /v1/models') + '(检测可正常进行)');
      setSubmitEnabled(true);
      return;
    }

    const myModels = (data.by_protocol && data.by_protocol[protocol]) || [];
    const total = data.raw_count || 0;

    if (myModels.length === 0) {
      // The headline case: cross-protocol suggestion.
      const others = Object.keys(data.by_protocol || {})
        .filter((p) => p !== protocol && data.by_protocol[p].length > 0)
        .map((p) => ({proto: p, count: data.by_protocol[p].length, sample: data.by_protocol[p][0]}));

      let html =
        '<div class="probe-headline">🟡 该中转站没有任何 ' + escapeHtml(protoLabel) + ' 模型</div>' +
        '<div class="probe-detail">已识别 ' + total + ' 个模型,但都不属于本检测协议。</div>';
      if (others.length) {
        html += '<div class="probe-actions">';
        others.forEach((o) => {
          const label = {anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini'}[o.proto];
          html +=
            '<button type="button" class="btn btn-ghost probe-action" data-handoff="' + o.proto + '">' +
            '改用 ' + label + ' 协议 (' + o.count + ' 个可用)</button>';
        });
        html += '</div>';
      }
      setPillHtml('warn', html);
      bindHandoff();
      // Disable submit — running detection here will produce 0% report.
      setSubmitEnabled(false, '该中转站没有 ' + protoLabel + ' 模型');
      return;
    }

    // Happy path: at least one model matches our protocol.
    const sample = myModels.slice(0, 4).join(', ');
    const more = myModels.length > 4 ? ` 等共 ${myModels.length} 个` : '';
    setPillHtml(
      'ok',
      '<div class="probe-headline">🟢 已识别 ' + total + ' 个模型,其中 ' + myModels.length + ' 个可用于本检测</div>' +
      '<div class="probe-detail">' + escapeHtml(sample) + escapeHtml(more) + '</div>'
    );

    // Replace the dropdown with what the relay actually carries.
    if (window.veridropSetModelChoices) {
      window.veridropSetModelChoices(myModels);
    }
    setSubmitEnabled(true);

    // Stash best_by_protocol globally — the submit handler reads it when
    // preflight 422s so it can offer a one-click swap to the recommended
    // model.
    window.veridropBestByProtocol = data.best_by_protocol || {};

    // If the user-typed model isn't in the list, auto-correct to the
    // protocol-preferred default rather than whatever sorts first
    // alphabetically. The backend computes "best" via each protocol's
    // pick_default_model — for OpenAI that's gpt-4o-mini, for Gemini it's
    // gemini-2.5-flash, etc. — so a /gemini → /openai handoff lands on a
    // sensible model instead of e.g. gpt-3.5-turbo or some preview SKU.
    const best = (data.best_by_protocol && data.best_by_protocol[protocol]) || myModels[0];
    if (modelInput && modelInput.value.trim() && !myModels.includes(modelInput.value.trim())) {
      modelInput.value = best;
    }
  }

  function setPill(level, text) {
    pill.className = 'probe-pill probe-' + level;
    pill.textContent = text;
    pill.hidden = false;
  }
  function setPillHtml(level, html) {
    pill.className = 'probe-pill probe-' + level;
    pill.innerHTML = html;
    pill.hidden = false;
  }

  function setSubmitEnabled(ok, reason) {
    const btn = document.getElementById('submit-btn');
    if (!btn) return;
    btn.disabled = !ok;
    btn.title = ok ? '' : (reason || '');
  }

  function bindHandoff() {
    pill.querySelectorAll('[data-handoff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-handoff');
        try {
          sessionStorage.setItem('veridrop:handoff', JSON.stringify({
            base_url: baseUrlInput.value.trim(),
            api_key: apiKeyInput.value.trim(),
            from: protocol,
          }));
        } catch (_) { /* sessionStorage unavailable — page navigates anyway */ }
        location.href = protoPath[target];
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Trigger probe on api_key blur. Also re-probe when base_url changes
  // (after blur) so users editing both fields don't miss a re-check.
  apiKeyInput.addEventListener('blur', runProbe);
  apiKeyInput.addEventListener('input', () => {
    lastKey = null;
    if (inflight && inflight.abort) inflight.abort();
    inflight = null;
    pill.hidden = true;
    setSubmitEnabled(true);
  });
  baseUrlInput.addEventListener('input', () => {
    lastKey = null;
    if (inflight && inflight.abort) inflight.abort();
    inflight = null;
    pill.hidden = true;
    setSubmitEnabled(true);
  });
  baseUrlInput.addEventListener('blur', () => {
    lastKey = null; // base changed → invalidate dedup
    runProbe();
  });

  // Cross-protocol handoff: if we landed here from another protocol page,
  // pre-fill the form and immediately probe. Single-shot — clear after read
  // so a refresh doesn't reuse the key.
  try {
    const raw = sessionStorage.getItem('veridrop:handoff');
    if (raw) {
      sessionStorage.removeItem('veridrop:handoff');
      const data = JSON.parse(raw);
      if (data && data.base_url && data.api_key) {
        baseUrlInput.value = data.base_url;
        apiKeyInput.value = data.api_key;
        const fromLabel = {anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini'}[data.from] || data.from;
        setPill('neutral', '🔄 已从 ' + fromLabel + ' 页面带入凭据,正在重新探测...');
        // Defer so the page paints first
        setTimeout(runProbe, 50);
      }
    }
  } catch (_) { /* malformed handoff — ignore */ }
})();


(function () {
  const form = document.getElementById('detect-form');
  if (!form) return;
  const submitBtn = document.getElementById('submit-btn');
  const errBox = document.getElementById('form-error');

  function endpointFor() {
    return form.getAttribute('data-endpoint')
      || (location.pathname.startsWith('/claude')
        ? '/api/detect/claude'
        : location.pathname.startsWith('/openai')
        ? '/api/detect/openai'
        : location.pathname.startsWith('/gemini')
        ? '/api/detect/gemini'
        : '/api/detect');
  }

  function currentProtocol() {
    return location.pathname.startsWith('/claude') ? 'anthropic' :
           location.pathname.startsWith('/openai') ? 'openai' :
           location.pathname.startsWith('/gemini') ? 'gemini' : null;
  }

  function renderModelDeadError(detail) {
    // Backend returns: {code, message, model, protocol, upstream_error}
    const proto = currentProtocol();
    const recommended = (window.veridropBestByProtocol || {})[proto];
    const dead = detail.model || '该模型';
    const reason = detail.upstream_error || '上游拒绝';

    errBox.innerHTML = '';
    errBox.hidden = false;
    errBox.classList.add('form-error-rich');

    const title = document.createElement('div');
    title.className = 'form-error-title';
    title.textContent = '该模型在中转站实际不可用';
    errBox.appendChild(title);

    const body = document.createElement('div');
    body.className = 'form-error-body';
    body.textContent = `${dead}: ${reason}`;
    errBox.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'form-error-actions';

    if (recommended && recommended !== dead) {
      const swapBtn = document.createElement('button');
      swapBtn.type = 'button';
      swapBtn.className = 'btn btn-primary';
      swapBtn.textContent = `换成 ${recommended} 重试`;
      swapBtn.addEventListener('click', () => {
        const modelInput = document.getElementById('model');
        if (modelInput) modelInput.value = recommended;
        errBox.hidden = true;
        errBox.classList.remove('form-error-rich');
        // Clear force flag if it was set by previous click.
        const force = form.querySelector('input[name="force"]');
        if (force) force.value = '';
        form.requestSubmit();
      });
      actions.appendChild(swapBtn);
    }

    const forceBtn = document.createElement('button');
    forceBtn.type = 'button';
    forceBtn.className = 'btn btn-ghost';
    forceBtn.textContent = '我知道,强制提交';
    forceBtn.title = 'preflight 偶尔会误判(例如 max_tokens 太小被代理拒)。强制提交后,如果模型真挂了,检测会以错误结果呈现。';
    forceBtn.addEventListener('click', () => {
      // Append a hidden force=1 field; the detect routes skip preflight when
      // it's set.
      let force = form.querySelector('input[name="force"]');
      if (!force) {
        force = document.createElement('input');
        force.type = 'hidden';
        force.name = 'force';
        form.appendChild(force);
      }
      force.value = '1';
      errBox.hidden = true;
      errBox.classList.remove('form-error-rich');
      form.requestSubmit();
    });
    actions.appendChild(forceBtn);

    errBox.appendChild(actions);
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    errBox.classList.remove('form-error-rich');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在确认模型可用…';

    const fd = new FormData(form);
    try {
      const r = await fetch(endpointFor(), {method: 'POST', body: fd});
      if (r.status === 422) {
        const j = await r.json().catch(() => ({}));
        const detail = j && j.detail;
        if (detail && detail.code === 'model_not_alive') {
          renderModelDeadError(detail);
          submitBtn.disabled = false;
          submitBtn.textContent = '开始检测';
          return;
        }
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({detail: 'request failed'}));
        const msg = typeof j.detail === 'string' ? j.detail
          : (j.detail && j.detail.message) || ('HTTP ' + r.status);
        throw new Error(msg);
      }
      const j = await r.json();
      form.api_key.value = '';
      // Clear force flag so a subsequent submission goes through preflight.
      const force = form.querySelector('input[name="force"]');
      if (force) force.value = '';
      location.href = '/r/' + j.job_id;
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = e.message || 'Submission failed';
      submitBtn.disabled = false;
      submitBtn.textContent = '开始检测';
    }
  });
})();

// FAQ dual-mode toggle (通俗 / 开发者).
// Two <p data-mode="layperson|developer"> per question are both in DOM
// (so search engines index both); CSS hides whichever doesn't match the
// section's data-mode. Choice persists in localStorage so the user
// doesn't have to re-toggle every visit.
(() => {
  const STORAGE_KEY = 'veridrop_faq_mode';
  const sections = document.querySelectorAll('.faq[data-mode]');
  if (!sections.length) return;

  // Restore saved preference (if any) before any clicks.
  const saved = (() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  })();
  if (saved === 'layperson' || saved === 'developer') {
    sections.forEach((sec) => {
      sec.dataset.mode = saved;
      sec.querySelectorAll('.faq-mode-btn').forEach((b) => {
        const active = b.dataset.mode === saved;
        b.classList.toggle('faq-mode-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    });
  }

  // Click handler: switch mode + persist.
  sections.forEach((sec) => {
    sec.querySelectorAll('.faq-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        sec.dataset.mode = mode;
        sec.querySelectorAll('.faq-mode-btn').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('faq-mode-active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
      });
    });
  });
})();
