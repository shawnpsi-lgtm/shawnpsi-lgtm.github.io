/* DotCloud - a point cloud whose positions come from a bit of GLSL.
   Usage:  var stop = DotCloud.mount(el, {place: SRC, cols: 300, rows: 220});
   Sibling of dotfield.js. That one is a heightfield on a ground plane and can
   only ever be ground; this one puts points anywhere in 3D and orbits a camera
   round them, so a sketch can be a shell, a stack of strata, or an attractor.
   No dependencies. Raw WebGL, one vertex shader placing a point set. */
(function (root) {
'use strict';

var VS_PRE = [
'precision highp float;',
'attribute vec3 aP;',                    // u, v in 0..1, and the point index
'uniform float uTime,uPoint,uDist,uYaw,uPitch,uFocal,uN,uFade;',
'uniform vec2 uRes;',
'uniform vec4 uData[16];',               // whatever the sketch wants, per frame
'varying float vFade;',
'const float PI=3.14159265;',
'mat2 rot(float a){ return mat2(cos(a),-sin(a),sin(a),cos(a)); }',
'float hash1(float p){ return fract(sin(p*127.1)*43758.5453); }',
'vec2 hash2(float p){ return fract(sin(vec2(p*127.1,p*311.7))*43758.5453); }',
'vec3 hash3(float p){ return fract(sin(vec3(p*127.1,p*311.7,p*74.7))*43758.5453); }',
/* an even spread of n points over a sphere, straight from the index */
'vec3 fib(float i,float n){',
'  float y=1.0-2.0*(i+0.5)/n;',
'  float r=sqrt(max(0.0,1.0-y*y));',
'  float a=2.39996323*i;',
'  return vec3(cos(a)*r,y,sin(a)*r);',
'}'].join('\n');

/* A sketch returns vec4(position, gain): where the point sits in the cloud's
   own space, and how bright to draw it. Override with opts.place. */
var DEFAULT_PLACE = [
'vec4 place(vec2 uv,float i,float t){',
'  vec3 d=fib(i,uN);',
'  return vec4(d*1.5,0.5+0.5*sin(d.y*6.0+t));',
'}'].join('\n');

var VS_MAIN = [
'void main(){',
'  vec4 P=place(aP.xy,aP.z,uTime);',
'  vec3 p=P.xyz;',
'  p.xz=rot(uYaw)*p.xz;',
'  p.yz=rot(uPitch)*p.yz;',
'  p.z+=uDist;',
'  float w=max(p.z,0.02);',
'  float aspect=uRes.x/uRes.y;',
'  gl_Position=vec4(p.x*uFocal/aspect,p.y*uFocal,0.0,w);',
'  gl_PointSize=max(uPoint*(uDist/w)*(uRes.y/900.0),0.6);',
   // near points fade in, far ones fade out, so the cloud has depth to it
'  vFade=P.w*(1.0-smoothstep(uDist,uDist*(1.0+uFade),p.z))*smoothstep(0.0,uDist*0.35,p.z);',
'}'].join('\n');

var FS = [
'precision mediump float;',
'varying float vFade;',
'uniform vec3 uColor;',
'void main(){',
'  float m=1.0-smoothstep(0.30,0.5,length(gl_PointCoord-0.5));',
'  float a=m*vFade*0.85;',
'  if(a<0.01) discard;',
'  gl_FragColor=vec4(uColor,a);',
'}'].join('\n');

var DEFAULTS = {
  cols: 300, rows: 220, point: 2.2, focal: 1.6, dist: 5.2, speed: 0.5,
  spin: 0.12, tilt: 0.18, wobble: 0.0, fade: 1.1,
  color: [0.86, 0.88, 0.90], background: [0, 0, 0],
  additive: true,               // dots pile into light where the cloud is dense
  place: null,                  // GLSL vec4 place(vec2 uv,float i,float t)
  data: null                    // f(t) -> Float32Array(64), 16 vec4s
};

function compile(gl, type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('DotCloud shader: ' + gl.getShaderInfoLog(s));
  return s;
}

function mount(host, opts) {
  var o = {}, k;
  for (k in DEFAULTS) o[k] = DEFAULTS[k];
  for (k in (opts || {})) o[k] = opts[k];

  var cv = document.createElement('canvas');
  cv.style.cssText = 'display:block;width:100%;height:100%';
  host.appendChild(cv);

  var transparent = !o.background;
  var gl = cv.getContext('webgl', { antialias: true, alpha: transparent,
                                    premultipliedAlpha: false });
  if (!gl) { host.removeChild(cv); throw new Error('DotCloud: WebGL unavailable'); }

  var prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER,
                  VS_PRE + '\n' + (o.place || DEFAULT_PLACE) + '\n' + VS_MAIN));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error('DotCloud link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  var n = o.cols * o.rows, pts = new Float32Array(n * 3), i = 0, idx = 0, r, c;
  for (r = 0; r < o.rows; r++)
    for (c = 0; c < o.cols; c++) {
      pts[i++] = c / (o.cols - 1);
      pts[i++] = r / (o.rows - 1);
      pts[i++] = idx++;
    }
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'aP');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);

  var U = function (nm) { return gl.getUniformLocation(prog, nm); };
  var u = { time: U('uTime'), res: U('uRes'), yaw: U('uYaw'),
            pitch: U('uPitch'), data: U('uData[0]') };
  gl.uniform1f(U('uPoint'), o.point); gl.uniform1f(U('uDist'), o.dist);
  gl.uniform1f(U('uFocal'), o.focal); gl.uniform1f(U('uN'), n);
  gl.uniform1f(U('uFade'), o.fade);   gl.uniform3fv(U('uColor'), o.color);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, o.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
  if (transparent) gl.clearColor(0, 0, 0, 0);
  else gl.clearColor(o.background[0], o.background[1], o.background[2], 1);

  function resize() {
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(host.clientWidth * dpr));
    var h = Math.max(1, Math.round(host.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w; cv.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.res, w, h);
    }
  }
  var ro = null;
  if (root.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(host); }
  else root.addEventListener('resize', resize);
  resize();

  var visible = true, io = null;         // offscreen cards cost nothing
  if (root.IntersectionObserver) {
    io = new IntersectionObserver(function (e) { visible = e[0].isIntersecting; });
    io.observe(host);
  }

  var raf = 0, t0 = performance.now(), dead = false;
  (function frame() {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    var t = (performance.now() - t0) / 1000 * o.speed;
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.yaw, t * o.spin);
    gl.uniform1f(u.pitch, o.tilt + Math.sin(t * o.wobble) * 0.18);
    if (o.data && u.data) gl.uniform4fv(u.data, o.data(t));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, n);
  })();

  return function destroy() {
    dead = true;
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect(); else root.removeEventListener('resize', resize);
    if (io) io.disconnect();
    gl.deleteBuffer(buf); gl.deleteProgram(prog);
    var lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    if (cv.parentNode) cv.parentNode.removeChild(cv);
  };
}

root.DotCloud = { mount: mount, defaults: DEFAULTS, DEFAULT_PLACE: DEFAULT_PLACE };
})(typeof window !== 'undefined' ? window : globalThis);
