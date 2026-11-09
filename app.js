// Surtido Betterware — reparte productos en bolsas por asociado escaneando el código.
'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const CLAVE = 'surtido-bw-v1';
let estado = cargarEstado();     // {asociados:[...], log:[...], sobrantes:{}, avisos:[]}
let volverA = 'bolsas';

// ---------- Estado ----------
function cargarEstado() {
  try { return JSON.parse(localStorage.getItem(CLAVE)) || null; } catch { return null; }
}
function guardar() {
  try { localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch {}
  pintarProgreso();
}
function borrarTodo() {
  if (!confirm('¿Borrar la semana actual y empezar de cero?')) return;
  estado = null;
  try { localStorage.removeItem(CLAVE); } catch {}
  ir('inicio');
}

// ---------- Lectura del PDF ----------
const dinero = s => parseFloat(s.replace(/,/g, ''));
const cerca = (a, b) => Math.abs(a - b) <= 0.06;

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
  // Se reparte lo SURTIDO (lo que de verdad llegó en las cajas).
  return { codigo, desc: limpiar(desc), cant: +surt, pedida: +sol, precio: dinero(b) };
}
const limpiar = d => d.replace(/\|+\s*$/, '').trim();

function leerNotas(lineas) {
  const notas = [];
  let nota = null;
  for (const l of lineas) {
    const folio = l.match(/Folio de pedido (OV-\d+)/);
    if (folio) { nota = { folio: folio[1], cod: null, nombre: null, prods: [] }; notas.push(nota); continue; }
    const as = l.match(/C[oó]digo (\d+) Nombre Asociado (.+?) Tel[eé]fono/);
    if (as && nota) { nota.cod = as[1]; nota.nombre = as[2].replace(/\s+/g, ' ').trim(); continue; }
    const p = leerProducto(l);
    if (p && nota) nota.prods.push(p);
  }
  return notas;
}

async function cargarArchivos(files) {
  const msg = document.getElementById('cargando');
  msg.textContent = 'Leyendo…';
  const porAsociado = new Map();
  const avisos = [];
  const foliosVistos = new Set();
  for (const f of files) {
    let notas;
    try { notas = leerNotas(await lineasDePdf(await f.arrayBuffer())); }
    catch (e) { avisos.push(`No pude leer «${f.name}».`); continue; }
    if (!notas.length) avisos.push(`«${f.name}» no parece un reporte de notas.`);
    for (const n of notas) {
      if (foliosVistos.has(n.folio)) { avisos.push(`El folio ${n.folio} venía repetido; lo conté una sola vez.`); continue; }
      foliosVistos.add(n.folio);
      const clave = n.cod || n.nombre || n.folio;
      if (!porAsociado.has(clave)) porAsociado.set(clave, { cod: n.cod, nombre: n.nombre || '(sin nombre)', folios: [], items: {} });
      const a = porAsociado.get(clave);
      a.folios.push(n.folio);
      if (!n.prods.length) avisos.push(`El folio ${n.folio} (${a.nombre}) no tiene productos legibles.`);
      for (const p of n.prods) {
        if (p.cant < p.pedida) avisos.push(`${a.nombre}: pidió ${p.pedida} de ${p.codigo} ${p.desc} y Betterware solo surtió ${p.cant}.`);
        if (!p.cant) continue;
        const it = a.items[p.codigo] || (a.items[p.codigo] = { desc: p.desc, cant: 0, hecho: 0, regalo: true });
        it.cant += p.cant;
        if (p.precio > 0) it.regalo = false;
      }
    }
  }
  const asociados = [...porAsociado.values()].sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
  asociados.forEach((a, i) => a.bolsa = i + 1);
  if (!asociados.length) { msg.textContent = 'No encontré asociados en esos archivos.'; return; }
  estado = { asociados, log: [], sobrantes: {}, avisos };
  guardar();
  msg.textContent = '';
  ir('bolsas');
}
document.getElementById('archivos').addEventListener('change', e => {
  if (e.target.files.length) cargarArchivos([...e.target.files]);
  e.target.value = '';
});

// ---------- Cálculos ----------
const piezas = a => Object.values(a.items).reduce((s, i) => s + i.cant, 0);
const hechas = a => Object.values(a.items).reduce((s, i) => s + i.hecho, 0);
const faltanCodigo = cod => estado.asociados.reduce((s, a) => s + (a.items[cod] ? a.items[cod].cant - a.items[cod].hecho : 0), 0);
const corto = n => n.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()).replace(/ (De|Del|La|Los|Las|Y)(?= )/g, s => s.toLowerCase());
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pintarProgreso() {
  const el = document.getElementById('prog');
  if (!estado) { el.textContent = ''; return; }
  const tot = estado.asociados.reduce((s, a) => s + piezas(a), 0);
  const ok = estado.asociados.reduce((s, a) => s + hechas(a), 0);
  el.textContent = `${ok} / ${tot} piezas`;
}

// ---------- Surtir ----------
let ultimo = { cod: null, t: 0 };

function surtir(cod, origen) {
  if (!estado) return;
  const ahora = Date.now();
  if (origen === 'camara' && cod === ultimo.cod && ahora - ultimo.t < 2500) return; // mismo producto aún frente a la cámara
  ultimo = { cod, t: ahora };

  const destino = estado.asociados.find(a => a.items[cod] && a.items[cod].hecho < a.items[cod].cant);
  if (destino) {
    const it = destino.items[cod];
    it.hecho++;
    estado.log.push({ cod, bolsa: destino.bolsa });
    guardar();
    const restanAqui = it.cant - it.hecho;
    const restanTotal = faltanCodigo(cod);
    mostrar('ok', `BOLSA ${destino.bolsa}`, corto(destino.nombre),
      `${cod} · ${it.desc}${it.regalo ? ' (regalo)' : ''}` +
      (restanAqui ? ` · le falta${restanAqui > 1 ? 'n' : ''} ${restanAqui} más` : '') +
      (restanTotal ? `<br>Quedan ${restanTotal} de este producto por repartir` : '<br>Este producto ya quedó completo'));
    decir(`Bolsa ${destino.bolsa}`);
    vibrar([80]);
  } else {
    const pedido = estado.asociados.some(a => a.items[cod]);
    estado.sobrantes[cod] = (estado.sobrantes[cod] || 0) + 1;
    estado.log.push({ cod, bolsa: null });
    guardar();
    if (pedido) {
      mostrar('aviso', 'SOBRA', 'Ya están completos', `${cod} · nadie más lo pidió. Apártalo.`);
      decir('Sobra');
    } else {
      mostrar('malo', 'NO VA', 'Nadie lo pidió', `${cod} no está en el reporte. Apártalo.`);
      decir('No va');
    }
    vibrar([60, 80, 60]);
  }
}

function deshacer() {
  if (!estado || !estado.log.length) return;
  const u = estado.log.pop();
  if (u.bolsa) {
    const a = estado.asociados.find(a => a.bolsa === u.bolsa);
    a.items[u.cod].hecho--;
    mostrar('', '↩', 'Deshecho', `Saca el ${u.cod} de la bolsa ${u.bolsa}`);
  } else {
    estado.sobrantes[u.cod]--;
    if (!estado.sobrantes[u.cod]) delete estado.sobrantes[u.cod];
    mostrar('', '↩', 'Deshecho', `${u.cod} ya no cuenta como sobrante`);
  }
  ultimo = { cod: null, t: 0 };
  guardar();
}

function manual() {
  const inp = document.getElementById('codigo');
  const cod = inp.value.replace(/\D/g, '');
  inp.value = '';
  if (cod.length !== 5) { mostrar('malo', '¿?', 'El código lleva 5 números', ''); return; }
  surtir(cod, 'manual');
}
document.getElementById('codigo').addEventListener('input', e => {
  if (e.target.value.replace(/\D/g, '').length === 5) manual();
});

function mostrar(clase, grande, nombre, detalle) {
  const r = document.getElementById('resultado');
  r.className = clase;
  document.getElementById('res-grande').textContent = grande;
  document.getElementById('res-nombre').textContent = nombre;
  document.getElementById('res-detalle').innerHTML = detalle;
}
function decir(t) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'es-MX'; u.rate = 1.1;
    speechSynthesis.speak(u);
  } catch {}
}
function vibrar(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

// ---------- Cámara ----------
let stream = null, detector = null, escaneando = false;

async function prenderCamara() {
  const msg = document.getElementById('cam-msg');
  if (!('BarcodeDetector' in window)) {
    msg.textContent = 'Este navegador no lee códigos con la cámara. Usa Chrome en Android, o teclea el código.';
    return;
  }
  try {
    detector = new BarcodeDetector({ formats: ['code_128', 'ean_13', 'ean_8', 'upc_a', 'code_39'] });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    const v = document.getElementById('video');
    v.srcObject = stream;
    await v.play();
    msg.textContent = '';
    escaneando = true;
    bucle();
  } catch (e) {
    msg.textContent = 'No pude abrir la cámara (' + e.name + '). Revisa el permiso, o teclea el código.';
  }
}
function apagarCamara() {
  escaneando = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}
async function bucle() {
  const v = document.getElementById('video');
  while (escaneando) {
    try {
      const cods = await detector.detect(v);
      for (const c of cods) {
        const m = (c.rawValue || '').match(/\d{5}/);
        if (m) { surtir(m[0], 'camara'); break; }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
}

// ---------- Vistas ----------
function ir(vista) {
  if (vista !== 'inicio' && !estado) vista = 'inicio';
  for (const s of document.querySelectorAll('main > section')) s.classList.add('oculto');
  document.getElementById('v-' + vista).classList.remove('oculto');
  if (vista === 'surtir') prenderCamara(); else apagarCamara();
  if (vista === 'inicio') document.getElementById('continuar-card').classList.toggle('oculto', !estado);
  if (vista === 'bolsas') pintarBolsas();
  if (vista === 'final') pintarFinal();
  if (vista === 'bolsas' || vista === 'final') volverA = vista;
  pintarProgreso();
  window.scrollTo(0, 0);
}

function pintarBolsas() {
  document.getElementById('avisos').innerHTML = estado.avisos.length
    ? `<div class="aviso-txt">${estado.avisos.map(esc).join('<br>')}</div>` : '';
  document.getElementById('lista-bolsas').innerHTML = estado.asociados.map(a => {
    const t = piezas(a), h = hechas(a);
    return `<div class="bolsa" onclick="verBolsa(${a.bolsa})">
      <div class="num ${h === t ? 'lista-ok' : ''}">${a.bolsa}</div>
      <div><div class="nombre">${esc(corto(a.nombre))}</div>
      <div class="sub">${h} de ${t} piezas · ${a.folios.length > 1 ? a.folios.length + ' notas' : a.folios[0]}</div></div></div>`;
  }).join('');
}

function verBolsa(n) {
  const a = estado.asociados.find(a => a.bolsa === n);
  const filas = Object.entries(a.items).sort((x, y) => x[0].localeCompare(y[0])).map(([cod, it]) =>
    `<tr><td>${cod}</td><td>${esc(it.desc)}${it.regalo ? '<span class="regalo">regalo</span>' : ''}</td>
     <td class="c ${it.hecho >= it.cant ? 'hecho' : 'falta'}">${it.hecho}/${it.cant}</td></tr>`).join('');
  document.getElementById('detalle').innerHTML =
    `<div class="bolsa" style="display:flex;gap:12px;align-items:center"><div class="num">${a.bolsa}</div>
     <div><div class="nombre">${esc(corto(a.nombre))}</div><div class="sub">${a.folios.join(', ')}</div></div></div>
     <table style="margin-top:10px">${filas}</table>`;
  for (const s of document.querySelectorAll('main > section')) s.classList.add('oculto');
  document.getElementById('v-detalle').classList.remove('oculto');
  window.scrollTo(0, 0);
}

function pintarFinal() {
  const faltan = [];
  for (const a of estado.asociados)
    for (const [cod, it] of Object.entries(a.items))
      if (it.hecho < it.cant) faltan.push({ a, cod, it });
  const sob = Object.entries(estado.sobrantes);
  let h = '';
  h += `<h2>Faltan (${faltan.reduce((s, f) => s + f.it.cant - f.it.hecho, 0)} piezas)</h2>`;
  h += faltan.length
    ? `<div class="card"><table>${faltan.map(f => `<tr><td><b>Bolsa ${f.a.bolsa}</b><br><span class="sub">${esc(corto(f.a.nombre))}</span></td>
        <td>${f.cod} ${esc(f.it.desc)}</td><td class="c falta">${f.it.cant - f.it.hecho}</td></tr>`).join('')}</table></div>`
    : `<div class="card hecho"><b>¡Todo completo!</b></div>`;
  h += `<h2>Sobran (${sob.reduce((s, x) => s + x[1], 0)} piezas)</h2>`;
  h += sob.length
    ? `<div class="card"><table>${sob.map(([cod, n]) => `<tr><td>${cod}</td><td>${esc(descDe(cod))}</td><td class="c">${n}</td></tr>`).join('')}</table></div>`
    : `<div class="card sub">Nada sobró.</div>`;
  document.getElementById('final').innerHTML = h;
}
function descDe(cod) {
  for (const a of estado.asociados) if (a.items[cod]) return a.items[cod].desc;
  return 'no está en el reporte';
}

// ---------- Arranque ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
ir('inicio');
