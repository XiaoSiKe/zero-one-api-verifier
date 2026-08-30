import { useEffect, useRef } from 'react';

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uColor;
  uniform vec2 uMouse;

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
    float finalAmplitude = amplitudeNormal * 0.5
      * (1.0 + (uMouse.y - 0.5) * 0.2);
    float scaledTime = uTime / 10.0 + (uMouse.x - 0.5);
    float blur = smoothstep(splitPoint, splitPoint + 0.05, uv.x) * progress;
    float xNoise = mix(
      perlin2D(vec2(scaledTime, uv.x + progress) * 2.5),
      perlin2D(vec2(scaledTime, uv.x + scaledTime) * 3.5) / 1.5,
      uv.x * 0.3
    );
    float y = 0.5 + xNoise * 0.5 * finalAmplitude;
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

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

export default function ThreadsBackground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
    if (!gl) return undefined;

    const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return undefined;

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;

    container.appendChild(canvas);
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
      mouse: gl.getUniformLocation(program, 'uMouse'),
    };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let mouse = [0.5, 0.5];
    let targetMouse = [0.5, 0.5];
    let frameId = 0;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
      const longest = Math.max(width, height) * baseDpr;
      const dpr = longest > 1920 ? (baseDpr * 1920) / longest : baseDpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = (time) => {
      mouse[0] += (targetMouse[0] - mouse[0]) * 0.05;
      mouse[1] += (targetMouse[1] - mouse[1]) * 0.05;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.time, time * 0.001);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform3f(uniforms.color, 248 / 255, 250 / 255, 252 / 255);
      gl.uniform2f(uniforms.mouse, mouse[0], mouse[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const schedule = () => {
      if (!frameId) frameId = window.requestAnimationFrame(renderFrame);
    };
    const renderFrame = (time) => {
      frameId = 0;
      if (document.hidden || reducedMotion.matches) {
        draw(0);
        return;
      }
      draw(time);
      schedule();
    };
    const onPointerMove = (event) => {
      targetMouse = [event.clientX / window.innerWidth, 1 - event.clientY / window.innerHeight];
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    reducedMotion.addEventListener?.('change', schedule);
    resize();
    draw(0);
    schedule();

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', schedule);
      reducedMotion.removeEventListener?.('change', schedule);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    };
  }, []);

  return <div ref={containerRef} className="homepage-background" aria-hidden="true" />;
}
