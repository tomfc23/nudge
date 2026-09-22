/*
 * Liquid background.
 *
 * Two passes:
 *   1. field  — a small ping-pong buffer holding a 2D flow. It carries itself
 *               along its own velocity (semi-Lagrangian advection), turns
 *               around local vorticity, decays, and takes a splat from the
 *               pointer carrying the pointer's velocity.
 *   2. render — domain-warped 3-octave fbm displaced by that flow, shaded
 *               against a slope-derived normal so the folds catch light.
 *
 * The point of pass 1 is that the surface has a memory: it is stirred where
 * you moved and settles slowly, instead of following the cursor like a decal.
 */
(function () {
  "use strict";

  var canvas = document.querySelector("[data-liquid]");
  if (!canvas) return;
  var wrap = canvas.parentElement;

  var FIELD_PX = 256;

  /*
   * Cost controls. The background is a soft, low-contrast wash behind a scrim,
   * so it survives aggressive downsampling and a 2-octave fbm without the eye
   * noticing. Everything here is tuned so a weak GPU still holds frame rate.
   */
  var RENDER_BUDGET = 520000; // backing-store pixels at full quality
  var MAX_DPR = 1; // never supersample the canvas
  var FPS_ACTIVE = 30; // the fluid drifts slowly; 30 is ample
  var FPS_IDLE = 15; // once the pointer has been still for a moment
  var IDLE_AFTER = 1200; // ms of no pointer/scroll before dropping to FPS_IDLE
  var MIN_SCALE = 0.3; // calibration floor
  var OCTAVES = 2;
  var PROBE_FRAMES = 4; // per calibration pass
  var PROBE_STEPS = 2; // most shrink steps before we stop and accept

  var VERT = [
    "attribute vec2 position;",
    "void main() { gl_Position = vec4(position, 0.0, 1.0); }",
  ].join("\n");

  var HEAD = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "#define OCTAVES " + OCTAVES,
  ].join("\n");

  var NOISE = [
    "vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }",
    "float snoise(vec2 v) {",
    "  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);",
    "  vec2 i  = floor(v + dot(v, C.yy));",
    "  vec2 x0 = v - i + dot(i, C.xx);",
    "  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);",
    "  vec4 x12 = x0.xyxy + C.xxzz;",
    "  x12.xy -= i1;",
    "  i = mod(i, 289.0);",
    "  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));",
    "  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);",
    "  m = m * m; m = m * m;",
    "  vec3 x = 2.0 * fract(p * C.www) - 1.0;",
    "  vec3 h = abs(x) - 0.5;",
    "  vec3 ox = floor(x + 0.5);",
    "  vec3 a0 = x - ox;",
    "  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);",
    "  vec3 g;",
    "  g.x = a0.x * x0.x + h.x * x0.y;",
    "  g.yz = a0.yz * x12.xz + h.yz * x12.yw;",
    "  return 130.0 * dot(m, g);",
    "}",
    "float fbm(vec2 x) {",
    "  float v = 0.0;",
    "  float a = 0.5;",
    "  vec2 shift = vec2(100.0);",
    "  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));",
    "  for (int i = 0; i < OCTAVES; ++i) {",
    "    v += a * snoise(x);",
    "    x = rot * x * 2.0 + shift;",
    "    a *= 0.5;",
    "  }",
    "  return v;",
    "}",
  ].join("\n");

  var FIELD_FRAG = [
    HEAD,
    "uniform sampler2D uPrev;",
    "uniform vec2 uPointer;",
    "uniform vec2 uPointerVel;",
    "uniform vec2 uTexel;",
    "uniform float uInject;",
    "uniform float uDt;",
    "uniform float uAspect;",
    "vec3 decode(vec4 c) { return vec3((c.rg - 0.5) * 2.0, c.b); }",
    "vec4 encode(vec2 v, float ink) {",
    "  return vec4(clamp(v * 0.5 + 0.5, 0.0, 1.0), clamp(ink, 0.0, 1.0), 1.0);",
    "}",
    "void main() {",
    "  vec2 uv = gl_FragCoord.xy * uTexel;",
    "  vec3 here = decode(texture2D(uPrev, uv));",
    "  vec3 prev = decode(texture2D(uPrev, uv - here.xy * uDt * 0.9));",
    "  vec3 l = decode(texture2D(uPrev, uv - vec2(uTexel.x, 0.0)));",
    "  vec3 r = decode(texture2D(uPrev, uv + vec2(uTexel.x, 0.0)));",
    "  vec3 d = decode(texture2D(uPrev, uv - vec2(0.0, uTexel.y)));",
    "  vec3 u = decode(texture2D(uPrev, uv + vec2(0.0, uTexel.y)));",
    "  float curl = (r.y - l.y) - (u.x - d.x);",
    "  vec2 vel = prev.xy + vec2(-prev.y, prev.x) * curl * 3.0 * uDt;",
    "  float ink = prev.z;",
    "  vel *= exp(-uDt * 0.9);",
    "  ink *= exp(-uDt * 0.7);",
    "  vec2 dpx = (uv - uPointer) * vec2(uAspect, 1.0);",
    "  float g = exp(-dot(dpx, dpx) / 0.0028);",
    "  vel += uPointerVel * g * uInject;",
    "  ink += length(uPointerVel) * 0.7 * uInject * g;",
    "  if (length(vel) < 0.006) vel = vec2(0.0);",
    "  if (ink < 0.004) ink = 0.0;",
    "  gl_FragColor = encode(vel, ink);",
    "}",
  ].join("\n");

  var RENDER_FRAG = [
    HEAD,
    NOISE,
    "uniform sampler2D uField;",
    "uniform vec2 uResolution;",
    "uniform vec2 uMouse;",
    "uniform float uTime;",
    "uniform float uScroll;",
    "uniform float uVelocity;",
    "uniform float uPointerVel;",
    "uniform float uQuality;",
    "vec3 readField(vec2 at) {",
    "  vec4 c = texture2D(uField, at);",
    "  return vec3((c.rg - 0.5) * 2.0, c.b);",
    "}",
    "void main() {",
    "  vec2 uv = gl_FragCoord.xy / uResolution.xy;",
    "  vec2 p = uv * 2.0 - 1.0;",
    "  p.x *= uResolution.x / uResolution.y;",
    "  vec3 field = readField(uv);",
    "  vec2 flow = field.xy;",
    "  float stir = field.z;",
    "  float dist = length(p - uMouse);",
    "  float pull = exp(-dist * 1.5) * (0.5 + uPointerVel * 0.55);",
    "  float t = uTime * 0.15;",
    "  vec2 q = vec2(fbm(p), fbm(p + vec2(1.0)));",
    "  vec2 r;",
    "  r.x = fbm(p + q + vec2(1.7, 9.2) + 0.15 * t + uMouse.x * pull);",
    "  r.y = fbm(p + q + vec2(8.3, 2.8) + 0.126 * t + uMouse.y * pull);",
    "  vec2 w = p + r + (uScroll * 0.2) + flow * 0.75 + stir * 0.4 * vec2(r.y, -r.x);",
    "  float f = fbm(w);",
    "  float sheen = uQuality * clamp(length(r) * 0.6, 0.0, 1.0);",
    "  vec3 base = vec3(0.013, 0.010, 0.015);",
    "  vec3 mid  = vec3(0.060, 0.027, 0.060);",
    "  vec3 high = vec3(0.410, 0.120, 0.320);",
    "  vec3 color = mix(base, mid, clamp(f * f * 4.0, 0.0, 1.0));",
    "  color = mix(color, high, clamp(length(q) * length(r) * f, 0.0, 1.0) * (0.55 + pull * 0.45));",
    "  color += vec3(0.18, 0.05, 0.14) * sheen * (0.5 + uVelocity * 0.35);",
    "  float v = smoothstep(2.4, 0.15, length(p));",
    "  color *= 0.42 + 0.58 * v;",
    "  color *= smoothstep(0.0, 0.22, uv.y);",
    "  float ign = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x + 0.00583715 * gl_FragCoord.y));",
    "  color += (ign - 0.5) / 255.0;",
    "  gl_FragColor = vec4(max(color, 0.0) * 0.99 + 0.004, 1.0);",
    "}",
  ].join("\n");

  var gl = canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });

  if (!gl) {
    wrap.classList.add("is-fallback");
    return;
  }

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function program(fragSrc) {
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(p, "position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    var uni = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      uni[info.name.replace("[0]", "")] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, uniforms: uni };
  }

  function target() {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FIELD_PX, FIELD_PX, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { tex: tex, fbo: fbo } : null;
  }

  var fieldPass = program(FIELD_FRAG);
  var renderPass = program(RENDER_FRAG);
  var fboA = target();
  var fboB = target();

  if (!fieldPass || !renderPass || !fboA || !fboB) {
    wrap.classList.add("is-fallback");
    return;
  }

  gl.clearColor(0.5, 0.5, 0.0, 1.0);
  [fboA, fboB].forEach(function (t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
  });

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var coarse = window.matchMedia("(pointer: coarse)").matches;
  var quality = coarse ? 0.0 : 1.0;

  var width = 1;
  var height = 1;
  var hostW = 1;
  var hostH = 1;
  var scale = 1;
  var mouseX = 0;
  var mouseY = 0;
  var prevNdcX = 0;
  var prevNdcY = 0;
  var pointerVel = 0;
  var scroll = 0;
  var prevScroll = 0;
  var scrollVel = 0;
  var beadX = 0.5;
  var beadY = 0.5;
  var targetX = 0.5;
  var targetY = 0.5;
  var beadVelX = 0;
  var beadVelY = 0;
  var time = 0;
  var last = 0;
  var lastActivity = 0;
  var front = fboA;
  var back = fboB;
  var ready = false;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    var w = Math.max(1, Math.round(hostW * dpr));
    var h = Math.max(1, Math.round(hostH * dpr));
    var budget = RENDER_BUDGET * scale;
    if (w * h > budget) {
      var k = Math.sqrt(budget / (w * h));
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    if (w === width && h === height) return;
    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  // Layout is read here only — never inside the render loop.
  function measure() {
    var rect = wrap.getBoundingClientRect();
    hostW = Math.max(1, rect.width);
    hostH = Math.max(1, rect.height);
    resize();
  }

  function applyScale(next) {
    scale = next;
    if (!coarse) quality = Math.max(0, Math.min(1, (scale - MIN_SCALE) / (1 - MIN_SCALE)));
    resize();
  }

  /*
   * Calibration. Reallocating the drawing buffer costs a ~100ms stall, so we
   * never do it mid-animation: the first frames run at the full budget while
   * the canvas is still at opacity 0, and we step the resolution down only if
   * those hidden frames came back slower than the pace we intend to hold.
   * Returns once the final size is chosen and the canvas can be revealed.
   */
  function calibrate(done) {
    var step = 0;
    applyScale(1);

    function pass() {
      var t0 = 0;
      var frames = 0;
      var budgetMs = (1000 / FPS_ACTIVE) * 1.35;

      function probe(now) {
        if (gl.isContextLost()) return;
        if (!t0) t0 = now;
        frame(1 / FPS_ACTIVE);
        frames++;
        if (frames < PROBE_FRAMES) {
          requestAnimationFrame(probe);
          return;
        }
        var avg = (now - t0) / frames;
        if (avg <= budgetMs || scale <= MIN_SCALE || step >= PROBE_STEPS) {
          done();
          return;
        }
        step++;
        applyScale(Math.max(MIN_SCALE, scale * 0.6));
        requestAnimationFrame(pass);
      }

      requestAnimationFrame(probe);
    }

    pass();
  }

  function bind(pass) {
    gl.useProgram(pass.program);
    return pass.uniforms;
  }

  function frame(dt) {
    time += dt;

    var ease = 1 - Math.exp(-dt * 8);
    var nx = beadX + (targetX - beadX) * ease;
    var ny = beadY + (targetY - beadY) * ease;
    beadVelX = dt > 0 ? (nx - beadX) / dt : 0;
    beadVelY = dt > 0 ? (ny - beadY) / dt : 0;
    beadX = nx;
    beadY = ny;
    var beadSpeed = Math.hypot(beadVelX, beadVelY);

    pointerVel *= Math.exp(-dt * 3.2);
    scrollVel *= Math.exp(-dt * 2.4);

    var u = bind(fieldPass);
    gl.bindFramebuffer(gl.FRAMEBUFFER, back.fbo);
    gl.viewport(0, 0, FIELD_PX, FIELD_PX);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, front.tex);
    gl.uniform1i(u.uPrev, 0);
    gl.uniform2f(u.uPointer, beadX, beadY);
    gl.uniform2f(u.uPointerVel, clamp(beadVelX * 0.25, -1, 1), clamp(beadVelY * 0.25, -1, 1));
    gl.uniform2f(u.uTexel, 1 / FIELD_PX, 1 / FIELD_PX);
    gl.uniform1f(u.uInject, clamp(beadSpeed * 0.5, 0, 1));
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uAspect, width / height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    var tmp = front;
    front = back;
    back = tmp;

    u = bind(renderPass);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, front.tex);
    gl.uniform1i(u.uField, 0);
    gl.uniform2f(u.uResolution, width, height);
    gl.uniform2f(u.uMouse, mouseX, mouseY);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uScroll, scroll);
    gl.uniform1f(u.uVelocity, scrollVel);
    gl.uniform1f(u.uPointerVel, pointerVel);
    gl.uniform1f(u.uQuality, quality);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function reveal() {
    if (ready) return;
    ready = true;
    wrap.classList.add("is-ready");
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function onPointer(event) {
    lastActivity = performance.now();
    var w = window.innerWidth || 1;
    var h = window.innerHeight || 1;
    var ndcX = (event.clientX / w) * 2 - 1;
    var ndcY = -((event.clientY / h) * 2 - 1);
    mouseX = ndcX * (w / h);
    mouseY = ndcY;
    targetX = event.clientX / w;
    targetY = 1 - event.clientY / h;
    pointerVel = clamp(pointerVel + 6 * Math.hypot(ndcX - prevNdcX, ndcY - prevNdcY), 0, 1);
    prevNdcX = ndcX;
    prevNdcY = ndcY;
  }

  function onScroll() {
    lastActivity = performance.now();
    var s = window.scrollY / (window.innerHeight || 1);
    scrollVel = clamp(scrollVel + Math.abs(s - prevScroll) * 3.5, 0, 1);
    prevScroll = s;
    scroll = s;
  }

  var running = false;
  var visible = true;
  var calibrated = false;
  var raf = 0;

  function loop(now) {
    raf = requestAnimationFrame(loop);

    // Frame limiter. The fluid drifts slowly, so rendering every vsync is pure
    // waste; idle drops lower still once the pointer has been still a while.
    var target = now - lastActivity > IDLE_AFTER ? 1000 / FPS_IDLE : 1000 / FPS_ACTIVE;
    var elapsed = last ? now - last : target;
    if (elapsed < target - 1) return;

    var dt = Math.min(elapsed / 1000, 1 / FPS_IDLE);
    last = now;

    frame(dt);
  }

  function start() {
    if (!calibrated || running || reduceMotion.matches || !visible || document.hidden) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });

  if (window.ResizeObserver) new ResizeObserver(measure).observe(wrap);
  else window.addEventListener("resize", measure, { passive: true });

  // Nothing to draw once the hero has scrolled away — shelf the whole loop.
  if (window.IntersectionObserver) {
    new IntersectionObserver(
      function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) start();
        else stop();
      },
      { threshold: 0 },
    ).observe(wrap);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else start();
  });

  canvas.addEventListener("webglcontextlost", function (event) {
    event.preventDefault();
    stop();
    wrap.classList.add("is-fallback");
  });

  reduceMotion.addEventListener("change", function () {
    if (reduceMotion.matches) stop();
    else start();
  });

  measure();

  if (reduceMotion.matches) {
    calibrated = true;
    frame(1 / FPS_ACTIVE);
    reveal();
  } else {
    calibrate(function () {
      calibrated = true;
      reveal();
      start();
    });
  }
})();
