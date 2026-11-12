// Surtido Betterware — reparte productos en bolsas por asociada escaneando el código.
// Un celular carga el PDF (anfitrión) y otros se pueden unir con un código de 4 letras (celular a celular, PeerJS).
'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const CLAVE = 'surtido-bw-v2';
const CLAVE_NOMBRE = 'surtido-bw-nombre';
const PREFIJO_PEER = 'surtido-bw-';
const T_EXITO = 3000;          // ms que se queda el aviso verde
const T_FUERA = 800;           // ms que el código debe salir de la cámara para volver a contarlo

let estado = null;             // anfitrión: la semana completa. Invitado: copia que manda el anfitrión.
let rol = null;                // 'host' | 'guest'
let conectados = [];           // nombres conectados (lo calcula el anfitrión)
const $ = id => document.getElementById(id);

// ---------- Utilidades ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dinero = s => parseFloat(s.replace(/,/g, ''));
const titulo = s => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase())
  .replace(/ (De|Del|La|Las|Los|Y)(?= )/g, m => m.toLowerCase());
function leer(k) { try { return localStorage.getItem(k); } catch { return null; } }
function escribir(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
const miNombre = () => (leer(CLAVE_NOMBRE) || '').trim();
// Sesión en curso: se retoma sola al recargar la página. {rol:'host'} o {rol:'guest', codigo, nombre}
const CLAVE_ACTIVA = 'surtido-bw-activa';
let nombreInvitado = '';           // nombre que el anfitrión le pone al invitado que no escribió uno
const quienSoy = () => miNombre() || (rol === 'guest' && nombreInvitado) || 'Yo';
function marcarActiva() {
  if (rol === 'host') escribir(CLAVE_ACTIVA, JSON.stringify({ rol }));
  else if (rol === 'guest') escribir(CLAVE_ACTIVA, JSON.stringify({ rol, codigo: codigoInvitado, nombre: nombreInvitado }));
  else escribir(CLAVE_ACTIVA, null);
}

// "MARIA DEL CARMEN GARCIA GONZALEZ" → "María del Carmen"; "IMELDA DE LA CERDA VALADEZ" → "Imelda"
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa']);
function nombrePila(completo) {
  const p = titulo(completo.trim().replace(/\s+/g, ' ')).split(' ');
  if (p.length <= 2) return p[0];
  let i = p.length - 2;                                    // empieza el primer apellido
  while (i > 1 && PARTICULAS.has(p[i - 1].toLowerCase())) i--;
  return p.slice(0, Math.max(1, i)).join(' ');
}
function ponerAlias(asociados) {
  for (const a of asociados) a.alias = nombrePila(a.nombre);
  const cuenta = {};
  for (const a of asociados) cuenta[a.alias] = (cuenta[a.alias] || 0) + 1;
  const base = asociados.map(a => a.alias);
  asociados.forEach((a, i) => {
    if (cuenta[base[i]] < 2) return;
    // La misma asociada en dos notas de distribuidoras distintas: "Imelda (FDWP)"
    const misma = asociados.filter((b, j) => base[j] === base[i] && b.nombre === a.nombre).length > 1;
    if (misma && a.dist) { a.alias += ` (${a.dist})`; return; }
    const resto = titulo(a.nombre).split(' ').slice(a.alias.split(' ').length);   // dos "Laura": primer apellido
    a.alias += ' ' + (resto.find(w => !PARTICULAS.has(w.toLowerCase())) || '');
  });
}

// ---------- Lectura del PDF ----------
async function lineasDePdf(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lineas = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    const filas = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let f = filas.find(f => Math.abs(f.y - y) < 2.5);
      if (!f) { f = { y, items: [] }; filas.push(f); }
      f.items.push({ x, w: it.width, s: it.str });
    }
    filas.sort((a, b) => b.y - a.y);
    for (const f of filas) {
      f.items.sort((a, b) => a.x - b.x);
      let txt = '', fin = null;
      for (const it of f.items) {
        if (fin !== null && it.x - fin > 1) txt += ' ';
        txt += it.s; fin = it.x + it.w;
      }
      lineas.push(txt.replace(/\s+/g, ' ').trim());
    }
  }
  return lineas;
}

// Fila de producto (las dos tablas): código · descripción · [pág. catálogo] · solicitada · surtida · $… $…
const RE_PROD = /^(\d{5}) (.+?)(?: \d{1,3})? (\d{1,3}) (\d{1,3}) \$([\d,]+\.\d\d) \$([\d,]+\.\d\d)/;
function leerProducto(linea) {
  const m = linea.match(RE_PROD);
  if (!m) return null;
  const [, codigo, desc, sol, surt, , b] = m;
  return { codigo, desc: desc.replace(/\|+\s*$/, '').trim(), cant: +surt, pedida: +sol, precio: dinero(b) };
}
function leerNotas(lineas) {
  const notas = [];
  let nota = null;
  for (const l of lineas) {
    const folio = l.match(/Folio de pedido (OV-\d+)/);
    if (folio) {
      // Misma línea: "… Distribuidora FDWP ADELA PEÑA Código" → dueña de la nota
      const d = l.match(/Distribuidora ([A-Z0-9]{2,8}) (.+?)(?: C[oó]digo)?$/);
      nota = { folio: folio[1], cod: null, nombre: null, dist: d ? d[1] : '', distNombre: d ? d[2].trim() : '', prods: [] };
      notas.push(nota); continue;
    }
    const as = l.match(/C[oó]digo (\d+) Nombre Asociado (.+?) Tel[eé]fono/);
    if (as && nota) { nota.cod = as[1]; nota.nombre = as[2].replace(/\s+/g, ' ').trim(); continue; }
    const p = leerProducto(l);
    if (p && nota) nota.prods.push(p);
  }
  return notas;
}

async function cargarArchivos(files) {
  const msg = $('cargando');
  msg.textContent = 'Leyendo…';
  const porAsociado = new Map(), avisos = [], foliosVistos = new Set();
  for (const f of files) {
    let notas;
    try { notas = leerNotas(await lineasDePdf(await f.arrayBuffer())); }
    catch { avisos.push(`No pude leer «${f.name}».`); continue; }
    if (!notas.length) avisos.push(`«${f.name}» no parece un reporte de notas.`);
    for (const n of notas) {
      if (foliosVistos.has(n.folio)) { avisos.push(`El folio ${n.folio} venía repetido; lo conté una sola vez.`); continue; }
      foliosVistos.add(n.folio);
      // Una bolsa por asociada y por distribuidora (dos PDF de dueñas distintas = pedidos distintos)
      const clave = n.dist + '|' + (n.cod || n.nombre || n.folio);
      if (!porAsociado.has(clave)) porAsociado.set(clave, { cod: n.cod, nombre: n.nombre || '(sin nombre)', dist: n.dist, distNombre: n.distNombre, archivos: [], folios: [], items: {} });
      const a = porAsociado.get(clave);
      if (!a.archivos.includes(f.name)) a.archivos.push(f.name);
      a.folios.push(n.folio);
      if (!n.prods.length) avisos.push(`El folio ${n.folio} (${titulo(a.nombre)}) no tiene productos legibles.`);
      for (const p of n.prods) {
        if (p.cant < p.pedida) avisos.push(`${titulo(a.nombre)} pidió ${p.pedida} de ${p.codigo} ${p.desc} y solo se surtió ${p.cant}.`);
        if (!p.cant) continue;
        const it = a.items[p.codigo] || (a.items[p.codigo] = { desc: p.desc, cant: 0, hecho: 0, regalo: true });
        it.cant += p.cant;
        if (p.precio > 0) it.regalo = false;
      }
    }
  }
  const asociados = [...porAsociado.values()];
  if (!asociados.length) { msg.textContent = 'No encontré asociadas en esos archivos.'; return; }
  ponerAlias(asociados);
  asociados.sort((x, y) => x.alias.localeCompare(y.alias, 'es'));
  asociados.forEach((a, i) => a.id = i + 1);
  estado = { sesion: codigoNuevo(), asociados, log: [], sobrantes: {}, avisos };
  msg.textContent = '';
  rol = 'host';
  marcarActiva();
  guardar();
  iniciarAnfitrion();
  ir('bolsas');
}
function codigoNuevo() {
  const L = 'ACDEFHJKMNPRTUVWXY';
  let c = '';
  for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
  return c;
}

// ---------- Cálculos ----------
const piezas = a => Object.values(a.items).reduce((s, i) => s + i.cant, 0);
const hechas = a => Object.values(a.items).reduce((s, i) => s + i.hecho, 0);
const faltanCodigo = cod => estado.asociados.reduce((s, a) => s + (a.items[cod] ? a.items[cod].cant - a.items[cod].hecho : 0), 0);
const porId = id => estado.asociados.find(a => a.id === id);
function totales() {
  let t = 0, h = 0;
  for (const a of estado.asociados) { t += piezas(a); h += hechas(a); }
  return { t, h };
}

// ---------- Acciones (solo las ejecuta el anfitrión) ----------
// Devuelve el aviso que verá quien escaneó.
function ejecutar(acc, quien) {
  if (acc.t === 'scan') return registrar(acc.cod, quien);
  if (acc.t === 'undo') return deshacerDe(quien);
}

function registrar(cod, quien) {
  const destino = estado.asociados.find(a => a.items[cod] && a.items[cod].hecho < a.items[cod].cant);
  if (destino) {
    const it = destino.items[cod];
    it.hecho++;
    estado.log.push({ cod, id: destino.id, quien, t: Date.now() });
    const completa = hechas(destino) === piezas(destino);
    const restan = it.cant - it.hecho;
    return {
      tipo: completa ? 'fin' : 'ok',
      etq: completa ? '✓ Bolsa completa' : '✓ Registrado · Bolsa',
      grande: destino.alias,
      det: `${cod} · ${esc(it.desc)}${it.regalo ? ' (regalo)' : ''}` + (restan ? ` · le falta${restan > 1 ? 'n' : ''} ${restan} más` : ''),
      extra: completa ? 'Ya puedes cerrar su bolsa.' : '',
      voz: completa ? `${destino.alias}. Bolsa completa` : destino.alias,
    };
  }
  estado.sobrantes[cod] = (estado.sobrantes[cod] || 0) + 1;
  estado.log.push({ cod, id: null, quien, t: Date.now() });
  const con = estado.asociados.filter(a => a.items[cod]);
  if (con.length) {
    const desc = con[0].items[cod].desc;
    return {
      tipo: 'sobra', etq: 'Sobra', grande: 'Ya no va',
      det: `${cod} · ${esc(desc)}<br>Ya está completo en:`,
      lista: con.map(a => `${esc(a.alias)} (${a.items[cod].cant})`).join(' · '),
      extra: 'Revisa esas bolsas; si ya están bien, apártalo.',
      voz: 'Sobra', espera: true,
    };
  }
  return {
    tipo: 'mal', etq: 'No va', grande: 'Nadie lo pidió',
    det: `El código ${cod} no está en el reporte.`, extra: 'Apártalo.', voz: 'No va', espera: true,
  };
}

function deshacerDe(quien) {
  let i = estado.log.length - 1;
  while (i >= 0 && estado.log[i].quien !== quien) i--;
  if (i < 0) return { tipo: '', etq: 'Deshacer', grande: 'Nada que deshacer', det: '' };
  const [u] = estado.log.splice(i, 1);
  if (u.id) {
    const a = porId(u.id);
    a.items[u.cod].hecho--;
    return { tipo: 'mal', etq: 'Deshecho', grande: `Sácalo de ${a.alias}`, det: `${u.cod} · ${esc(a.items[u.cod].desc)}`, voz: `Sácalo de ${a.alias}`, espera: true };
  }
  estado.sobrantes[u.cod]--;
  if (!estado.sobrantes[u.cod]) delete estado.sobrantes[u.cod];
  return { tipo: '', etq: 'Deshecho', grande: 'Listo', det: `${u.cod} ya no cuenta como sobrante.` };
}

// Punto de entrada para escaneos, teclado y deshacer.
function accion(acc) {
  if (!estado) return;
  const quien = quienSoy();
  if (rol === 'guest') {
    if (!conn || !conn.open) { mostrar({ tipo: 'mal', etq: 'Sin conexión', grande: 'No se registró', det: 'Este celular perdió la conexión con el principal. Reconectando…', espera: true }); return; }
    conn.send({ t: 'accion', acc, quien });
    return;
  }
  const res = ejecutar(acc, quien);
  guardar();
  mostrar(res);
}

// ---------- Aviso en pantalla ----------
let temporizador = null, pausado = false;
function mostrar(r) {
  clearTimeout(temporizador);
  const el = $('res');
  el.className = r.tipo || '';
  el.innerHTML = `<div class="etq">${r.etq || ''}</div><div class="grande">${esc(r.grande || '')}</div>` +
    (r.det ? `<div class="det">${r.det}</div>` : '') +
    (r.lista ? `<div class="lista">${r.lista}</div>` : '') +
    (r.extra ? `<div class="det">${esc(r.extra)}</div>` : '') +
    (r.espera ? `<button class="btn-res" onclick="limpiar()">Entendido</button>` : (r.tipo ? `<div class="tiempo"><div id="t-barra"></div></div>` : ''));
  sonar(r.tipo);
  if (r.voz) decir(r.voz);
  vibrar(r.tipo === 'ok' || r.tipo === 'fin' ? [60] : r.tipo ? [80, 80, 80] : []);
  pausado = !!r.espera;
  if (!r.espera) {
    const b = $('t-barra');
    if (b) { b.style.transition = 'none'; b.style.width = '100%'; requestAnimationFrame(() => { b.style.transition = `width ${T_EXITO}ms linear`; b.style.width = '0%'; }); }
    temporizador = setTimeout(limpiar, r.tipo ? T_EXITO : 1500);
  }
}
function limpiar() {
  clearTimeout(temporizador);
  pausado = false;
  const el = $('res');
  el.className = '';
  el.innerHTML = `<div style="font-size:30px">▥</div><div class="det" style="font-size:19px;font-weight:600">Listo para escanear</div>
    <div class="det">Apunta al código de barras o al QR de la etiqueta</div>`;
}

let audio = null, vozDesbloqueada = false, vozEs = null;
const ES_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// iPhone: que suene aunque el switch de silencio esté puesto (iOS 17+)
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
// Voz en español (es-MX de preferencia). Las voces cargan tarde en algunos navegadores.
function elegirVoz() {
  try {
    const vs = speechSynthesis.getVoices();
    vozEs = vs.find(v => /es[-_]MX/i.test(v.lang)) || vs.find(v => /es[-_](US|419)/i.test(v.lang)) || vs.find(v => /^es/i.test(v.lang)) || null;
  } catch {}
}
try { elegirVoz(); speechSynthesis.addEventListener?.('voiceschanged', elegirVoz); } catch {}
// iPhone solo deja sonar y hablar si el sonido nace de un toque. Además suspende el audio
// tras llamadas o al bloquear: por eso se revisa en CADA toque, no solo en el primero.
function desbloquearAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state !== 'running') audio.resume();
  } catch {}
  try {
    if (!vozPropia() && !vozDesbloqueada && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
      vozDesbloqueada = true;
    }
  } catch {}
}

// ---------- Voz propia (no usa la del sistema) ----------
// En iPhone, speechSynthesis pausa el video y corta la cámara (fallo de WebKit), y a veces ni suena.
// Ahí la app genera el audio de cada frase con eSpeak (vendor/voz.worker.js) y lo toca
// por el mismo canal que los pitidos. También es el respaldo si el celular no trae voces.
let forzarVozPropia = false, trabajadorVoz = null, vozError = '';
const frases = new Map();          // texto → AudioBuffer listo | Promise
function sinVocesDelSistema() { try { return !('speechSynthesis' in window) || (vocesRevisadas && !speechSynthesis.getVoices().length); } catch { return true; } }
let vocesRevisadas = false; setTimeout(() => { vocesRevisadas = true; }, 2500);
function vozPropia() { return ES_IOS || forzarVozPropia || sinVocesDelSistema(); }
function generarFrase(texto) {
  if (frases.has(texto)) return frases.get(texto);
  const p = new Promise((ok, no) => {
    try {
      if (!trabajadorVoz) {
        trabajadorVoz = new Worker('vendor/voz.worker.js');
        trabajadorVoz.pend = new Map();
        trabajadorVoz.onmessage = e => { const f = trabajadorVoz.pend.get(e.data.id); trabajadorVoz.pend.delete(e.data.id); if (f) e.data.error ? f.no(e.data.error) : f.ok(e.data.wav); };
        trabajadorVoz.onerror = e => { vozError = 'Voz: ' + (e.message || 'no cargó'); for (const f of trabajadorVoz.pend.values()) f.no(vozError); trabajadorVoz.pend.clear(); };
      }
      const id = Math.random();
      trabajadorVoz.pend.set(id, { ok, no });
      trabajadorVoz.postMessage({ id, texto });
    } catch (e) { no(e); }
  }).then(wav => {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    return new Promise((ok, no) => audio.decodeAudioData(wav, ok, no));     // forma con callbacks: sirve en iOS viejos
  }).then(buf => { frases.set(texto, buf); return buf; })
    .catch(e => { frases.delete(texto); vozError = 'Voz: ' + (e && e.message || e); throw e; });
  frases.set(texto, p);
  return p;
}
// Deja listas las frases de la semana para que suenen al instante.
function prepararFrases() {
  if (!vozPropia() || !estado) return;
  const lista = ['No va', 'Sobra', 'Bolsa Laura Esther'];
  for (const a of estado.asociados) lista.push(a.alias, `${a.alias}. Bolsa completa`, `Sácalo de ${a.alias}`);
  lista.reduce((p, t) => p.then(() => generarFrase(t)).catch(() => {}), Promise.resolve());
}
let fuenteVoz = null;
function tocarFrase(buf) {
  try {
    if (fuenteVoz) { try { fuenteVoz.stop(); } catch {} }
    if (audio.state !== 'running') audio.resume();
    const s = audio.createBufferSource(), g = audio.createGain();
    s.buffer = buf; g.gain.value = 1.6;
    s.connect(g).connect(audio.destination);
    s.start(audio.currentTime + 0.14);                     // después del pitido
    fuenteVoz = s;
  } catch (e) { vozError = 'Voz: ' + (e && e.message || e); }
}
function decirPropia(t) {
  const pedido = Date.now();
  const f = frases.get(t);
  if (f && !f.then) return tocarFrase(f);
  generarFrase(t).then(buf => { if (Date.now() - pedido < 2500) tocarFrase(buf); }).catch(() => {});
}
document.addEventListener('pointerup', desbloquearAudio, { passive: true });
document.addEventListener('touchend', desbloquearAudio, { passive: true });

function sonar(tipo) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const notas = tipo === 'ok' ? [[880, 0, .12]] : tipo === 'fin' ? [[660, 0, .1], [880, .12, .1], [1320, .24, .18]]
      : tipo ? [[220, 0, .18], [180, .22, .25]] : [];
    for (const [f, d, dur] of notas) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = tipo === 'ok' || tipo === 'fin' ? 'sine' : 'square';
      g.gain.setValueAtTime(.25, audio.currentTime + d);
      g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + d + dur);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + d); o.stop(audio.currentTime + d + dur + .02);
    }
  } catch {}
}
// En iPhone, cancel() seguido de speak() al instante pierde la frase: solo se cancela si
// algo está sonando, y se habla un momento después.
function decir(t) {
  try {
    if (vozPropia()) return decirPropia(t);
    const s = speechSynthesis;
    const hablar = () => {
      const u = new SpeechSynthesisUtterance(t);
      if (vozEs) u.voice = vozEs;
      u.lang = vozEs ? vozEs.lang : 'es-MX'; u.rate = 1.05; u.volume = 1;
      // Si la voz del sistema falla o nunca arranca, se cambia a la voz propia.
      let arranco = false;
      u.onstart = () => { arranco = true; };
      u.onend = () => { arranco = true; };
      u.onerror = () => { arranco = true; forzarVozPropia = true; prepararFrases(); decirPropia(t); };
      setTimeout(() => { if (!arranco) { try { s.cancel(); } catch {} forzarVozPropia = true; prepararFrases(); decirPropia(t); } }, 1500);
      try { s.resume(); } catch {}
      s.speak(u);
    };
    if (s.speaking || s.pending) { s.cancel(); setTimeout(hablar, 120); } else hablar();
  } catch {}
}
function vibrar(p) { try { p.length && navigator.vibrate && navigator.vibrate(p); } catch {} }

function deshacer() { accion({ t: 'undo' }); }

// ---------- Teclado numérico ----------
let tecleado = '';
function abrirTeclado() {
  tecleado = ''; pintarTeclado();
  $('teclado').classList.remove('oculto'); $('velo').classList.remove('oculto');
}
function cerrarTeclado() { $('teclado').classList.add('oculto'); $('velo').classList.add('oculto'); }
function pintarTeclado() { $('tec-display').textContent = tecleado.padEnd(5, '·'); }
function tecla(k) {
  if (k === '⌫') tecleado = tecleado.slice(0, -1);
  else if (tecleado.length < 5) tecleado += k;
  pintarTeclado();
  if (tecleado.length === 5) {
    const cod = tecleado;
    setTimeout(() => { cerrarTeclado(); accion({ t: 'scan', cod }); }, 150);
  }
}
$('teclas').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']
  .map(k => k ? `<button onclick="tecla('${k}')">${k}</button>` : '<span></span>').join('');

// ---------- Cámara ----------
let stream = null, detector = null, escaneando = false, visto = { cod: null, t: 0 }, wakeLock = null;

// Lector de códigos: el nativo de Chrome Android (BarcodeDetector) si existe;
// si no (iPhone/Safari), ZXing-C++ compilado a WebAssembly (vendor/zxing_reader.wasm, funciona sin internet).
// Lo que ve cada celular (pantalla Más → Diagnóstico)
const diag = { lector: '—', camara: '—', lecturas: 0, aciertos: 0, ultimo: '—', ms: 0, error: '' };
let forzarZXing = false;
async function crearDetector() {
  try {
    // En iPhone el BarcodeDetector puede existir (feature flag) pero no lee nada: ahí siempre ZXing.
    if (!ES_IOS && !forzarZXing && 'BarcodeDetector' in window) {
      const f = await BarcodeDetector.getSupportedFormats();
      if (f.includes('code_128')) {
        const d = new BarcodeDetector({ formats: f.includes('qr_code') ? ['code_128', 'qr_code'] : ['code_128'] });
        let fallas = 0;
        diag.lector = 'Nativo (BarcodeDetector)';
        return async lienzo => {
          try { const r = (await d.detect(lienzo)).map(c => c.rawValue || ''); fallas = 0; return r; }
          catch (e) {   // si el nativo truena seguido, se cambia a ZXing
            diag.error = 'Nativo: ' + (e && e.message || e);
            if (++fallas > 5) { forzarZXing = true; detector = await crearDetector(); }
            return [];
          }
        };
      }
    }
  } catch {}
  const Z = window.ZXingWASM;
  if (!Z) { diag.lector = 'Ninguno (no cargó ZXing)'; return null; }
  try {
    Z.prepareZXingModule({
      overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? new URL('vendor/zxing_reader.wasm', location.href).href : pre + p },
      fireImmediately: true,
    });
    await Z.getZXingModule();
  } catch (e) { diag.lector = 'Ninguno (falló ZXing)'; diag.error = String(e && e.message || e); return null; }
  diag.lector = 'ZXing (WebAssembly)';
  // El recorte es chico, así que se puede usar siempre el modo minucioso.
  return async (lienzo, ctx) => {
    try {
      const r = await Z.readBarcodes(ctx.getImageData(0, 0, lienzo.width, lienzo.height),
        { formats: ['Code128', 'QRCode'], tryHarder: true, maxNumberOfSymbols: 2 });
      return r.filter(b => b.isValid).map(b => b.text);
    } catch (e) { diag.error = 'ZXing: ' + (e && e.message || e); return []; }
  };
}

// Solo se analiza la franja de la mira, reducida: mucho menos trabajo por cuadro.
// El lienzo se reutiliza (no se crea memoria nueva en cada vuelta).
const ANCHO_MAX = 960;
const lienzoCam = document.createElement('canvas');
const ctxCam = lienzoCam.getContext('2d', { willReadFrequently: true });
// lupa = false: todo lo que se ve en el recuadro de la cámara (para alcanzar también el QR de la etiqueta).
// lupa = true: el centro, ampliado al doble (las etiquetas con barras muy finas solo se leen así).
function recortarMira(v, lupa) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return false;
  let cw = v.clientWidth, ch = v.clientHeight;
  if (!cw || !ch) { cw = vw; ch = vh; }                   // sin medidas en pantalla: usar el cuadro completo
  const s = Math.max(cw / vw, ch / vh);                    // object-fit: cover
  const ox = (vw * s - cw) / 2, oy = (vh * s - ch) / 2;
  // La vista completa incluye además lo que queda arriba y abajo del recuadro (la cámara ve más
  // de lo que se muestra): así alcanza el QR aunque se apunte a las barras.
  const [a, b, c, d] = lupa ? [0.1, 0.9, 0.15, 0.85] : [0, 1, -0.7, 1.7];
  let x0 = (a * cw + ox) / s, x1 = (b * cw + ox) / s;
  let y0 = (c * ch + oy) / s, y1 = (d * ch + oy) / s;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(vw, x1); y1 = Math.min(vh, y1);
  const sw = x1 - x0, sh = y1 - y0;
  const k = lupa ? Math.min(2, 1200 / sw) : Math.min(1, ANCHO_MAX / sw);
  const w = Math.round(sw * k), h = Math.round(sh * k);
  if (lienzoCam.width !== w || lienzoCam.height !== h) { lienzoCam.width = w; lienzoCam.height = h; }
  ctxCam.imageSmoothingQuality = 'high';
  ctxCam.drawImage(v, x0, y0, sw, sh, 0, 0, w, h);
  return true;
}
// ---------- Lector propio de Code 128 ----------
// Las etiquetas de Betterware casi no dejan margen blanco a los lados de las barras, y ZXing lo exige:
// por eso a veces no las lee. Este lector recorre varias líneas de la imagen, no pide margen,
// y solo acepta el código si la suma de verificación cuadra y dos líneas dan lo mismo.
const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232').split(' ').map(s => [...s].map(Number));
// tinta: cuánto más anchas salen las barras que los espacios (en módulos); la tinta corrida es lo normal.
function simbolo128(r, i, tinta) {                          // 6 franjas (11 módulos) → valor 0..105, o -1
  const m = (r[i] + r[i + 1] + r[i + 2] + r[i + 3] + r[i + 4] + r[i + 5]) / 11;
  if (m < 0.8) return -1;
  let mejor = -1, min = 1.7;
  for (let v = 0; v < 106; v++) {
    const p = C128[v]; let d = 0;
    for (let k = 0; k < 6; k++) { const e = Math.abs(r[i + k] / m + (k & 1 ? tinta : -tinta) - p[k]); if (e > 0.75) { d = 9; break; } d += e; }
    if (d < min) { min = d; mejor = v; }
  }
  return mejor;
}
function decodificar128(r, tinta) {                         // r: anchos de franjas, empezando en una oscura
  const hallados = [];
  for (let i = 0; i + 12 < r.length; i += 2) {
    const ini = simbolo128(r, i, tinta);
    if (ini < 103) continue;
    const vals = [];
    let j = i + 6, fin = false;
    while (j + 6 < r.length && vals.length < 20) {
      // ¿alto? 2331112 (13 módulos, 7 franjas)
      const s7 = r[j] + r[j + 1] + r[j + 2] + r[j + 3] + r[j + 4] + r[j + 5] + r[j + 6], m = s7 / 13;
      if (vals.length >= 2 && [2, 3, 3, 1, 1, 1, 2].every((p, k) => Math.abs(r[j + k] / m + (k & 1 ? tinta : -tinta) - p) <= 0.8)) { fin = true; break; }
      const v = simbolo128(r, j, tinta);
      if (v < 0 || v > 102) break;
      vals.push(v); j += 6;
    }
    if (!fin || vals.length < 2) continue;
    const verif = vals.pop();
    let suma = ini; vals.forEach((v, k) => suma += v * (k + 1));
    if (suma % 103 !== verif) continue;
    let set = ini === 103 ? 'A' : ini === 104 ? 'B' : 'C', txt = '', ok = true;
    for (const v of vals) {
      if (set === 'C') { if (v < 100) txt += String(v).padStart(2, '0'); else if (v === 100) set = 'B'; else if (v === 101) set = 'A'; else ok = false; }
      else if (v === 99) set = 'C';
      else if (v === 100 && set === 'A') set = 'B';
      else if (v === 101 && set === 'B') set = 'A';
      else if (v < 64 || (set === 'B' && v < 96)) txt += String.fromCharCode(v + 32);
      else ok = false;
    }
    if (ok && /^\d{5,7}$/.test(txt)) hallados.push(txt);
  }
  return hallados;
}
function leerCode128(img) {
  const { data, width: w, height: h } = img, votos = {};
  const gris = new Float32Array(w);
  const FILAS = 22;
  for (const pend of [0, 0.12, -0.12, 0.25, -0.25]) {       // líneas inclinadas: la etiqueta casi nunca queda derecha
    for (let f = 1; f <= FILAS; f++) {
      const yc = h * f / (FILAS + 1);
      let gmin = 255, gmax = 0;
      for (let x = 0; x < w; x++) {                         // promedio de 3 renglones (menos ruido)
        const y = Math.round(yc + (x - w / 2) * pend);
        if (y < 1 || y > h - 2) { gris[x] = 255; continue; }
        let g = 0;
        for (let dy = -1; dy <= 1; dy++) { const o = ((y + dy) * w + x) * 4; g += data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11; }
        g /= 3; gris[x] = g; if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      }
      if (gmax - gmin < 50) continue;
      // Crestas y valles de la señal (con histéresis): aguanta barras finas borrosas, donde los
      // espacios angostos no llegan a blanco. Cada borde va a media altura entre cresta y valle.
      const H = Math.max(10, (gmax - gmin) * 0.14), ext = [];
      let dir = 1, ev = gris[0], ex = 0;
      for (let x = 1; x < w; x++) {
        const v = gris[x];
        if (dir > 0) { if (v >= ev) { ev = v; ex = x; } else if (ev - v >= H) { ext.push(ex, ev); dir = -1; ev = v; ex = x; } }
        else { if (v <= ev) { ev = v; ex = x; } else if (v - ev >= H) { ext.push(ex, ev); dir = 1; ev = v; ex = x; } }
      }
      ext.push(ex, ev);
      if (ext.length < 44) continue;
      const bordes = [];                                    // bordes[0] es claro→oscuro (ext empieza en cresta)
      for (let e = 0; e + 3 < ext.length; e += 2) {
        const xa = ext[e], va = ext[e + 1], xb = ext[e + 2], vb = ext[e + 3], medio = (va + vb) / 2;
        let x = xa + 1;
        while (x < xb && (gris[x] - medio) * (va - medio) > 0) x++;
        const g0 = gris[x - 1], g1 = gris[x];
        bordes.push(g0 === g1 ? x : x - 1 + (g0 - medio) / (g0 - g1));
      }
      const franjas = [];
      for (let b = 0; b + 1 < bordes.length; b++) franjas.push(bordes[b + 1] - bordes[b]);
      const alReves = franjas.slice().reverse().slice(franjas.length % 2 ? 0 : 1), vistos = new Set();
      for (const tinta of [-0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8]) {
        for (const t of decodificar128(franjas, tinta)) vistos.add(t);
        for (const t of decodificar128(alReves, tinta)) vistos.add(t);
      }
      for (const t of vistos) votos[t] = (votos[t] || 0) + 1;
    }
  }
  return Object.keys(votos).filter(t => votos[t] >= 2).sort((a, b) => votos[b] - votos[a]);
}

// Texto leído → código de 5 dígitos. El QR de la etiqueta es un enlace que termina en el código
// (https://qrco.de/23432); las barras traen el código directo.
function textoACodigo(raw) {
  if (/^https?:|\//i.test(raw)) {
    const m = raw.match(/\/(\d{5})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }
  return codigoDe(raw);
}

const T_REPOSO = 60000;          // sin escanear 1 min → se apaga la cámara
let vuelta = 0, enReposo = false, ultimaActividad = Date.now(), abriendo = false;
const camViva = () => !!stream && stream.getVideoTracks().some(t => t.readyState === 'live');

async function prenderCamara() {
  pedirPantallaEncendida();
  ultimaActividad = Date.now();
  if (escaneando && camViva()) return;
  if (abriendo) return;
  apagarCamara();                                          // por si quedó congelada (volver de segundo plano)
  enReposo = false;
  const msg = $('cam-msg');
  abriendo = true;
  try {
    detector = detector || await crearDetector();
    if (!detector) {
      msg.textContent = 'No se pudo cargar el lector de códigos. Usa el botón Teclear.';
      msg.classList.remove('oculto'); return;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      // iPhone no deja enfocar a mano: más resolución para que las barras salgan nítidas (igual se recorta).
      video: ES_IOS ? { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
                    : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } }, audio: false });
    // Si el sistema corta la cámara (llamada, otra app), se vuelve a abrir al regresar.
    stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (stream && t === stream.getVideoTracks()[0]) apagarCamara(); }));
    const v = $('video');
    v.srcObject = stream;
    v.setAttribute('playsinline', ''); v.muted = true;
    await v.play();
    const ajustes = stream.getVideoTracks()[0]?.getSettings?.() || {};
    diag.camara = `${v.videoWidth || ajustes.width || '?'}×${v.videoHeight || ajustes.height || '?'}` + (ajustes.frameRate ? ` a ${Math.round(ajustes.frameRate)} fps` : '');
    diag.error = '';
    if (vistaActual !== 'surtir' || document.visibilityState !== 'visible') { apagarCamara(); return; }
    msg.classList.add('oculto');
    escaneando = true;
    bucle(++vuelta);
  } catch (e) {
    diag.error = 'Cámara: ' + (e && (e.name + ' ' + e.message) || e);
    apagarCamara();
    enReposo = true;                                       // no reintentar solo: esperar el toque
    msg.innerHTML = `<div><div style="font-size:18px;margin-bottom:12px">No pude abrir la cámara. Revisa el permiso de cámara del navegador, o usa el botón Teclear.</div>
      <button class="btn-despertar" style="height:auto;min-height:64px" onclick="reinicios=[];prenderCamara()">Reintentar</button></div>`;
    msg.classList.remove('oculto');
  } finally { abriendo = false; }
}
function apagarCamara() {
  escaneando = false;
  vuelta++;                                                // corta cualquier bucle anterior
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  const v = $('video');
  if (v) v.srcObject = null;
}
function dormirCamara() {
  apagarCamara();
  enReposo = true;
  const msg = $('cam-msg');
  msg.innerHTML = '<button class="btn-despertar" onclick="prenderCamara()">Tocar para seguir escaneando</button>';
  msg.classList.remove('oculto');
}
// Vigilante: cada segundo revisa que la cámara siga viva mientras se está en "Escanear".
// Si el sistema la cortó, la pausó o se quedó congelada, la revive sola.
let reinicios = [], tCongelado = 0, tMudo = 0, ultimoTiempoVideo = -1;
function pedirToque(texto) {
  apagarCamara();
  enReposo = true;
  const msg = $('cam-msg');
  msg.innerHTML = `<button class="btn-despertar" onclick="reinicios=[];prenderCamara()">${texto}</button>`;
  msg.classList.remove('oculto');
}
function revivirCamara(motivo) {
  const ahora = Date.now();
  reinicios = reinicios.filter(t => ahora - t < 30000);
  reinicios.push(ahora);
  diag.reinicios = (diag.reinicios || 0) + 1;
  diag.motivo = motivo;
  tCongelado = tMudo = 0; ultimoTiempoVideo = -1;
  if (reinicios.length > 4) {                              // no entrar en un ciclo sin fin
    try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {}
    return pedirToque('La cámara se detuvo. Tocar para reactivarla');
  }
  apagarCamara();
  prenderCamara();
}
setInterval(() => {
  if (vistaActual !== 'surtir' || document.visibilityState !== 'visible' || enReposo || abriendo) return;
  if (!detector && diag.lector.startsWith('Ninguno')) return;
  const v = $('video'), pista = stream && stream.getVideoTracks()[0];
  if (!escaneando || !pista || pista.readyState !== 'live') return revivirCamara('pista terminada');
  if (pista.muted) { if (++tMudo >= 2) revivirCamara('pista silenciada'); return; }
  tMudo = 0;
  if (v.paused) { v.play().catch(() => {}); if (++tCongelado >= 3) revivirCamara('video en pausa'); return; }
  if (v.currentTime === ultimoTiempoVideo) { if (++tCongelado >= 3) revivirCamara('imagen congelada'); }
  else tCongelado = 0;
  ultimoTiempoVideo = v.currentTime;
}, 1000);

// Algunos Android le pegan dígitos extra al código (p. ej. un "1" al inicio):
// se prefiere el tramo de 5 dígitos que sí viene en el reporte; si ninguno, los últimos 5.
function codigoDe(raw) {
  const d = raw.replace(/\D/g, '');
  if (d.length < 5) return null;
  const tramos = [];
  for (let i = d.length - 5; i >= 0; i--) tramos.push(d.slice(i, i + 5));
  return tramos.find(t => estado && estado.asociados.some(a => a.items[t])) || tramos[0];
}
// ~5 lecturas por segundo. No analiza mientras hay un aviso esperando "Entendido",
// el teclado está abierto o la app está en segundo plano.
async function bucle(mia) {
  const v = $('video');
  let n = 0;
  while (escaneando && mia === vuelta) {
    const inicio = Date.now();
    const libre = !pausado && $('teclado').classList.contains('oculto') && document.visibilityState === 'visible';
    if (libre && inicio - ultimaActividad > T_REPOSO) { dormirCamara(); return; }
    if (libre && recortarMira(v, ++n % 2 === 0)) {          // alterna: vista completa / lupa al centro
      try {
        let cods = await detector(lienzoCam, ctxCam);
        if (mia !== vuelta) return;
        let cod = cods.map(textoACodigo).find(Boolean);
        if (!cod) {                                         // respaldo: lector propio de barras (no pide margen blanco)
          try {
            const mias = leerCode128(ctxCam.getImageData(0, 0, lienzoCam.width, lienzoCam.height));
            if (mias.length) { cods = mias; cod = mias.map(codigoDe).find(Boolean); diag.propias = (diag.propias || 0) + 1; }
          } catch (e) { diag.error = 'Lector propio: ' + (e && e.message || e); }
        }
        const ahora = Date.now();
        diag.lecturas++; diag.ms = Math.round(diag.ms * 0.8 + (ahora - inicio) * 0.2);
        if (cods.length) { diag.aciertos++; diag.ultimo = cods.join(', ') + (cod && cod !== cods[0] ? ` → ${cod}` : ''); }
        if (cod) {
          // Para contar otra pieza igual, el código tiene que salir de la cámara un momento.
          const repetido = cod === visto.cod && ahora - visto.t < T_FUERA;
          visto = { cod, t: ahora };
          ultimaActividad = ahora;
          if (!repetido && !pausado && $('teclado').classList.contains('oculto')) accion({ t: 'scan', cod });
        }
      } catch {}
    }
    // Espera lo que falte para ~150 ms (si el celular es lento, al menos 60 ms de respiro)
    await new Promise(r => setTimeout(r, Math.max(60, 150 - (Date.now() - inicio))));
  }
}
async function pedirPantallaEncendida() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch {}
}
// Segundo plano (bloquear el celular, cambiar de app): se apaga la cámara y se vuelve a abrir al regresar.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { apagarCamara(); return; }
  if (vistaActual === 'surtir' && !enReposo) prenderCamara();
});
window.addEventListener('pagehide', apagarCamara);
// Cualquier toque cuenta como actividad (no se duerme mientras usan la app).
document.addEventListener('pointerdown', () => { ultimaActividad = Date.now(); }, { passive: true });

// ---------- Red: celular a celular ----------
let peer = null, conn = null, conexiones = new Map(), codigoInvitado = null, reintento = null;

function iniciarAnfitrion() {
  if (!window.Peer || !estado) return;
  if (peer) { try { peer.destroy(); } catch {} }
  peer = new Peer(PREFIJO_PEER + estado.sesion.toLowerCase());
  pintarRed('conectando');
  peer.on('open', () => pintarRed());
  peer.on('connection', c => {
    c.on('data', d => {
      if (d.t === 'hola') {
        let nombre = (d.quien || '').trim();
        if (!nombre) {                                       // sin nombre: "inv. Adela", "inv. Adela 2"…
          const base = `inv. ${miNombre() || 'anfitrión'}`, usados = new Set(conexiones.values());
          nombre = base;
          for (let i = 2; usados.has(nombre); i++) nombre = `${base} ${i}`;
          try { c.send({ t: 'nombre', nombre }); } catch {}
        }
        conexiones.set(c, nombre); enviarEstado(); pintarRed();
      }
      if (d.t === 'accion' && rol === 'host') {
        const res = ejecutar(d.acc, conexiones.get(c) || d.quien || 'Alguien');
        guardar();
        try { c.send({ t: 'res', res }); } catch {}
      }
    });
    c.on('close', () => { conexiones.delete(c); enviarEstado(); pintarRed(); });
  });
  peer.on('disconnected', () => { pintarRed('off'); setTimeout(() => { try { peer.reconnect(); } catch {} }, 2000); });
  peer.on('error', e => {
    pintarRed('off');
    // Tras recargar, el servidor tarda unos segundos en soltar el código anterior.
    if (e.type === 'unavailable-id' || e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      clearTimeout(reintento); reintento = setTimeout(iniciarAnfitrion, 4000);
    }
  });
}
function enviarEstado() {
  if (rol !== 'host') return;
  conectados = [miNombre() || 'Yo', ...conexiones.values()];
  for (const c of conexiones.keys()) { try { c.open && c.send({ t: 'estado', estado, conectados }); } catch {} }
}

function unirse(codigo) {
  codigo = (codigo || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (codigo.length !== 4) { $('unirse-msg').textContent = 'El código lleva 4 letras.'; return; }
  guardarNombre();                                         // el nombre es opcional: si falta, lo pone el anfitrión
  if (!window.Peer) { $('unirse-msg').textContent = 'No se pudo cargar la conexión. Revisa el internet.'; return; }
  rol = 'guest'; codigoInvitado = codigo; estado = null;
  marcarActiva();
  $('unirse-msg').textContent = 'Conectando…';
  if (peer) { try { peer.destroy(); } catch {} }
  peer = new Peer();
  peer.on('open', conectarInvitado);
  peer.on('error', e => {
    pintarRed('off');
    if (e.type === 'peer-unavailable') $('unirse-msg').textContent = `No encuentro la sesión ${codigo}. ¿El otro celular tiene la app abierta?`;
    clearTimeout(reintento); reintento = setTimeout(() => peer && !peer.destroyed && (peer.disconnected ? peer.reconnect() : conectarInvitado()), 3000);
  });
  peer.on('disconnected', () => setTimeout(() => { try { peer.reconnect(); } catch {} }, 2000));
}
function conectarInvitado() {
  if (rol !== 'guest') return;
  if (conn) { try { conn.close(); } catch {} }
  conn = peer.connect(PREFIJO_PEER + codigoInvitado.toLowerCase(), { reliable: true });
  pintarRed('conectando');
  conn.on('open', () => { conn.send({ t: 'hola', quien: miNombre() || nombreInvitado }); pintarRed(); });
  conn.on('data', d => {
    if (d.t === 'nombre') { nombreInvitado = d.nombre; marcarActiva(); repintar(); }
    if (d.t === 'estado') {
      const primera = !estado;
      estado = d.estado; conectados = d.conectados || [];
      $('unirse-msg').textContent = '';
      if (primera) ir('surtir'); else repintar();
    }
    if (d.t === 'res') mostrar(d.res);
  });
  conn.on('close', () => { pintarRed('off'); clearTimeout(reintento); reintento = setTimeout(conectarInvitado, 2000); });
}
function unirseDesdeInicio() { unirse($('codigo-unirse').value); }

function pintarRed(forzado) {
  const chip = $('chip-red'), txt = $('red-txt');
  chip.classList.remove('on', 'off');
  let estadoRed = forzado;
  if (!estadoRed) {
    if (rol === 'host') estadoRed = peer && peer.open ? 'on' : 'off';
    else estadoRed = conn && conn.open ? 'on' : 'off';
  }
  if (rol === 'host') {
    const n = conexiones.size + 1;
    txt.textContent = estadoRed === 'on' ? (n > 1 ? `${n} conectados` : `Compartir · ${estado.sesion}`) : estadoRed === 'conectando' ? 'Conectando…' : 'Solo este celular';
    if (estadoRed === 'on') chip.classList.add('on'); else if (estadoRed === 'off') chip.classList.add('off');
  } else {
    txt.textContent = estadoRed === 'on' ? `${conectados.length || 2} conectados` : estadoRed === 'conectando' ? 'Conectando…' : 'Sin conexión';
    chip.classList.add(estadoRed === 'on' ? 'on' : 'off');
  }
  if (!$('v-compartir').classList.contains('oculto')) pintarCompartir();
}

// ---------- Estado guardado ----------
function guardar() {
  if (rol === 'host') { escribir(CLAVE, JSON.stringify(estado)); enviarEstado(); }
  repintar();
}
function guardarNombre() { escribir(CLAVE_NOMBRE, $('mi-nombre').value.trim()); }
$('mi-nombre').addEventListener('input', () => {
  guardarNombre();
  $('mi-nombre').classList.remove('con-error');
  $('nombre-error').classList.add('oculto');
});
// Sin nombre no se puede cargar ni unirse: el aviso sale pegado a la casilla, que se ve y se sacude.
function faltaNombre() {
  guardarNombre();
  if (miNombre()) return false;
  const inp = $('mi-nombre');
  inp.classList.add('con-error');
  $('nombre-error').classList.remove('oculto');
  inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
  inp.classList.remove('sacudir'); void inp.offsetWidth; inp.classList.add('sacudir');
  vibrar([80, 80, 80]);
  setTimeout(() => inp.focus(), 300);
  return true;
}

function continuar() {
  if (faltaNombre()) return;
  const g = leer(CLAVE);
  if (!g) return;
  estado = JSON.parse(g); rol = 'host';
  marcarActiva();
  iniciarAnfitrion();
  ir('surtir');
}
function salir() {
  apagarCamara();
  escribir(CLAVE_ACTIVA, null);
  clearTimeout(reintento); nombreInvitado = '';
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  conn = null; conexiones.clear(); rol = null; estado = null;
  ir('inicio');
}
function terminarSemana() {
  if (!confirm('¿Borrar esta semana del celular? Ya no se podrá recuperar.')) return;
  escribir(CLAVE, null);
  salir();
}

// ---------- Vistas ----------
let vistaActual = 'inicio';
function ir(vista) {
  if (vista !== 'inicio' && !estado) vista = 'inicio';
  vistaActual = vista;
  for (const s of document.querySelectorAll('body > section')) s.classList.add('oculto');
  $('v-' + vista).classList.remove('oculto');
  if (vista === 'surtir') { reinicios = []; prenderCamara(); if (!$('res').innerHTML) limpiar(); } else apagarCamara();
  if (vista === 'surtir' || vista === 'bolsas' || vista === 'diag') prepararFrases();
  repintar();
  window.scrollTo(0, 0);
}
function repintar() {
  const v = vistaActual;
  if (v === 'inicio') pintarInicio();
  if (!estado) return;
  if (v === 'surtir') { pintarBarra(); pintarFeed(); pintarRed(); }
  if (v === 'bolsas') pintarBolsas();
  if (v === 'detalle') verBolsa(detalleId, true);
  if (v === 'final') pintarFinal();
  if (v === 'compartir') pintarCompartir();
  if (v === 'mas') { $('btn-terminar').classList.toggle('oculto', rol !== 'host'); }
  if (v === 'diag') pintarDiag();
}
function pintarDiag() {
  if (!detector) crearDetector().then(d => { detector = detector || d; if (vistaActual === 'diag') pintarDiag(); });
  const ua = navigator.userAgent;
  const nav = /OPR|OPT\//.test(ua) ? 'Opera' : /CriOS/.test(ua) ? 'Chrome (iPhone)' : /FxiOS/.test(ua) ? 'Firefox (iPhone)'
    : /EdgiOS|EdgA|Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox/.test(ua) ? 'Firefox'
    : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Otro';
  const so = (ua.match(/OS (\d+[_\d]*) like Mac/) || [])[1]?.replace(/_/g, '.');
  let voces = '—';
  try { const vs = speechSynthesis.getVoices(); voces = `${vs.filter(v => /^es/i.test(v.lang)).length} en español de ${vs.length}` + (vozEs ? ` · usa ${vozEs.name} (${vozEs.lang})` : ''); } catch { voces = 'No disponible'; }
  const filas = [
    ['Navegador', nav + (ES_IOS ? ` · iOS ${so || ''}` : '')],
    ['Lector', diag.lector],
    ['Cámara', diag.camara],
    ['Lecturas', `${diag.lecturas} intentos · ${diag.aciertos} con código (${diag.propias || 0} con el lector propio) · ~${diag.ms} ms c/u`],
    ['Último código', diag.ultimo],
    ['Voz', vozPropia() ? `Propia de la app · ${[...frases.values()].filter(f => !f.then).length} frases listas` : 'Del sistema · ' + voces],
    ['Sonido', audio ? audio.state : 'sin iniciar'],
    ['Cámara revivida', `${diag.reinicios || 0} veces` + (diag.motivo ? ` · ${diag.motivo}` : '')],
    ['Versión', 'v8'],
  ];
  if (diag.error) filas.push(['Error', diag.error]);
  if (vozError) filas.push(['Error de voz', vozError]);
  $('diag-tabla').innerHTML = filas.map(([k, v]) => `<tr><td>${k}</td><td class="c" style="font-weight:600;white-space:normal">${esc(String(v))}</td></tr>`).join('');
}
function pintarInicio() {
  $('mi-nombre').value = miNombre();
  const g = leer(CLAVE);
  $('continuar-card').classList.toggle('oculto', !g);
  if (g) {
    try {
      const e = JSON.parse(g); let t = 0, h = 0;
      for (const a of e.asociados) for (const i of Object.values(a.items)) { t += i.cant; h += i.hecho; }
      $('continuar-txt').textContent = `${e.asociados.length} asociadas · ${h} de ${t} piezas surtidas.`;
    } catch {}
  }
}
function pintarBarra() {
  const { t, h } = totales();
  $('conteo').textContent = `${h} / ${t}`;
  $('prog-barra').style.width = (t ? 100 * h / t : 0) + '%';
}
function pintarFeed() {
  const ult = estado.log.slice(-3).reverse();
  $('feed').innerHTML = ult.map(u => {
    const a = u.id ? porId(u.id) : null;
    return `<div>${esc(u.quien)} → ${a ? esc(a.alias) : 'sobrante'} · ${u.cod}</div>`;
  }).join('');
}
function pintarBolsas() {
  $('avisos').innerHTML = estado.avisos.length ? `<div class="aviso-txt">${estado.avisos.map(esc).join('<br>')}</div>` : '';
  // Distribuidoras (dueñas de cada PDF), en el orden en que aparecen
  const dists = [];
  for (const a of estado.asociados) {
    let d = dists.find(d => d.cod === (a.dist || ''));
    if (!d) dists.push(d = { cod: a.dist || '', nombre: a.distNombre || '', archivos: [], bolsas: [] });
    d.bolsas.push(a);
    for (const f of a.archivos || []) if (!d.archivos.includes(f)) d.archivos.push(f);
  }
  const color = cod => 'd' + (dists.findIndex(d => d.cod === cod) % 4);
  const tarjeta = (a, etiqueta) => {
    const t = piezas(a), h = hechas(a);
    return `<div class="bolsa ${h === t ? 'lista' : ''}" onclick="verBolsa(${a.id})">
      ${etiqueta && a.dist ? `<span class="etq ${color(a.dist)}">${esc(a.dist)}</span>` : ''}
      <div class="n">${esc(a.alias)}</div>
      <div><div class="c">${h === t ? '✓ Completa' : `${h} de ${t} piezas`}</div><div class="mini"><div style="width:${100 * h / t}%"></div></div></div></div>`;
  };
  const porNota = vistaBolsas() === 'nota';
  $('seg-bolsas').classList.toggle('oculto', dists.length < 2 && !dists[0]?.cod);
  document.querySelectorAll('#seg-bolsas button').forEach(b => b.classList.toggle('on', b.dataset.v === vistaBolsas()));
  $('rejilla').innerHTML = porNota
    ? dists.map(d => {
        const t = d.bolsas.reduce((s, a) => s + piezas(a), 0), h = d.bolsas.reduce((s, a) => s + hechas(a), 0);
        return `<div class="grupo-nota"><div class="cab-nota ${color(d.cod)}">
            ${d.cod ? `<span class="k">${esc(d.cod)}</span>` : ''}
            <div style="flex:1;min-width:0"><div class="nn">${esc(d.nombre ? titulo(d.nombre) : 'Sin distribuidora')}</div>
            <div class="ss">${esc(d.archivos.join(', '))}${d.archivos.length ? ' · ' : ''}${h} de ${t} piezas</div></div></div>
          <div class="rejilla">${d.bolsas.map(a => tarjeta(a, false)).join('')}</div></div>`;
      }).join('')
    : `<div class="rejilla">${estado.asociados.map(a => tarjeta(a, true)).join('')}</div>`;
}
const CLAVE_VISTA = 'surtido-bw-vista';
function vistaBolsas() { try { return localStorage.getItem(CLAVE_VISTA) || 'nota'; } catch { return 'nota'; } }
function cambiarVista(v) { try { localStorage.setItem(CLAVE_VISTA, v); } catch {} pintarBolsas(); }
let detalleId = null;
function verBolsa(id, soloPintar) {
  detalleId = id;
  const a = porId(id);
  if (!a) return;
  const filas = Object.entries(a.items).sort((x, y) => x[0].localeCompare(y[0])).map(([cod, it]) =>
    `<tr><td>${cod}</td><td>${esc(it.desc)}${it.regalo ? '<span class="regalo">regalo</span>' : ''}</td>
     <td class="c ${it.hecho >= it.cant ? 'hecho' : 'falta'}">${it.hecho}/${it.cant}</td></tr>`).join('');
  $('detalle').innerHTML = `<h1 style="margin-top:0">${esc(a.alias)}</h1>
    <p class="sub">${esc(titulo(a.nombre))} · ${a.folios.join(', ')}${a.dist ? `<br>Nota de ${esc(a.dist)} · ${esc(titulo(a.distNombre || ''))}` : ''}</p><table>${filas}</table>`;
  if (!soloPintar) {
    vistaActual = 'detalle';
    for (const s of document.querySelectorAll('body > section')) s.classList.add('oculto');
    $('v-detalle').classList.remove('oculto');
    apagarCamara();
    window.scrollTo(0, 0);
  }
}
function pintarFinal() {
  const faltan = [];
  for (const a of estado.asociados)
    for (const [cod, it] of Object.entries(a.items))
      if (it.hecho < it.cant) faltan.push({ a, cod, it });
  const sob = Object.entries(estado.sobrantes);
  let h = `<h2>Faltan (${faltan.reduce((s, f) => s + f.it.cant - f.it.hecho, 0)} piezas)</h2>`;
  h += faltan.length
    ? `<div class="card"><table>${faltan.map(f => `<tr><td><b>${esc(f.a.alias)}</b></td>
        <td>${f.cod} ${esc(f.it.desc)}</td><td class="c falta">${f.it.cant - f.it.hecho}</td></tr>`).join('')}</table></div>`
    : `<div class="card hecho"><b>Todo completo</b></div>`;
  h += `<h2 style="margin-top:20px">Sobran (${sob.reduce((s, x) => s + x[1], 0)} piezas)</h2>`;
  h += sob.length
    ? `<div class="card"><table>${sob.map(([cod, n]) => {
        const con = estado.asociados.filter(a => a.items[cod]);
        return `<tr><td>${cod}</td><td>${esc(con.length ? con[0].items[cod].desc : 'No está en el reporte')}
          ${con.length ? `<br><span class="sub">Lo llevan: ${con.map(a => esc(a.alias)).join(', ')}</span>` : ''}</td><td class="c">${n}</td></tr>`;
      }).join('')}</table></div>`
    : `<div class="card sub">No sobró nada.</div>`;
  $('final').innerHTML = h;
}
function pintarCompartir() {
  const host = rol === 'host';
  $('compartir-host').classList.toggle('oculto', !host);
  $('compartir-invitado').classList.toggle('oculto', host);
  if (host) {
    $('codigo-sesion').textContent = estado.sesion;
    if (window.qrcode) {
      const q = qrcode(0, 'M');
      q.addData(location.origin + location.pathname + '#' + estado.sesion);
      q.make();
      $('qr').innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }
  } else $('codigo-invitado').textContent = codigoInvitado;
  const lista = host ? [miNombre() || 'Yo', ...conexiones.values()] : conectados;
  $('personas').innerHTML = lista.map(n => `<div class="persona"><span class="pt"></span>${esc(n)}</div>`).join('') ||
    '<p class="sub">Nadie más todavía.</p>';
}

// ---------- Arranque ----------
$('btn-pdf').addEventListener('click', () => {
  if (faltaNombre()) return;
  if (leer(CLAVE) && !confirm('Ya hay una semana guardada. ¿Reemplazarla con la nueva?')) return;
  $('archivos').click();
});
$('archivos').addEventListener('change', e => {
  if (e.target.files.length) cargarArchivos([...e.target.files]);
  e.target.value = '';
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

ir('inicio');
// Abrieron el enlace del QR (…/surtido/#KXPT): llenar el código para unirse.
const hash = location.hash.replace('#', '').toUpperCase();
if (/^[A-Z]{4}$/.test(hash)) {
  $('codigo-unirse').value = hash;
  history.replaceState(null, '', location.pathname);
  unirse(hash);
} else {
  // Al recargar la página se retoma la sesión que estaba abierta.
  try {
    const act = JSON.parse(leer(CLAVE_ACTIVA) || 'null');
    if (act && act.rol === 'host' && leer(CLAVE) && miNombre()) continuar();
    else if (act && act.rol === 'guest' && /^[A-Z]{4}$/.test(act.codigo || '')) {
      nombreInvitado = act.nombre || '';
      $('codigo-unirse').value = act.codigo;
      unirse(act.codigo);
    }
  } catch {}
}
