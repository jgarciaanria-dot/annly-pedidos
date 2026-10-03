// =====================================================================
// Annly · campana.js — campanita de avisos en tiempo real (Agenda y Tiendas)
// El mismo archivo va en los dos repos. Cada panel lo configura con:
//   AnnlyCampana.iniciar({
//     cliente,            // cliente de Supabase ya autenticado
//     negocioId,          // id del negocio actual
//     tabla,              // 'appointments' | 'orders'
//     montarEn,           // [elementos] donde poner el botón de la campana
//     cargarRecientes,    // async () => [filas] para llenar la lista al abrir el panel
//     describir,          // fila => { titulo, detalle, urgente, fecha }
//     alAbrir,            // fila => void (qué hacer al tocar un aviso)
//     alLlegar            // fila => void (opcional: refrescar la pantalla actual)
//   })
// Lo "leído" se guarda por negocio en este navegador.
// =====================================================================
(function (global) {
  'use strict';

  const C = {
    cfg: null, filas: [], canal: null, abierta: false, botones: [],

    async iniciar(cfg) {
      this.detener();
      this.cfg = cfg;
      this._estilos();
      this.botones = (cfg.montarEn || []).filter(Boolean).map(el => this._montarBoton(el));
      this._panel();
      try { this.filas = (await cfg.cargarRecientes()) || []; } catch (e) { console.error('[Campana]', e); this.filas = []; }
      this._pintar();
      this._escuchar();
    },

    detener() {
      if (this.canal && this.cfg) { try { this.cfg.cliente.removeChannel(this.canal); } catch (e) {} }
      this.canal = null;
      this.botones.forEach(b => b.remove());
      this.botones = [];
      this.filas = [];
      this._tituloBase && (document.title = this._tituloBase);
    },

    // ---- Leído / no leído (por negocio, en este navegador) ----
    _clave() { return 'annly_campana_' + (this.cfg ? this.cfg.negocioId : ''); },
    _vistoHasta() { try { return localStorage.getItem(this._clave()) || ''; } catch (e) { return ''; } },
    _marcarVisto() { try { localStorage.setItem(this._clave(), new Date().toISOString()); } catch (e) {} },
    _sinLeer() {
      const v = this._vistoHasta();
      return this.filas.filter(f => { const d = this.cfg.describir(f); return !v || (d.fecha && d.fecha > v); });
    },

    // ---- Tiempo real ----
    _escuchar() {
      const { cliente, tabla, negocioId } = this.cfg;
      this.canal = cliente.channel('campana-' + tabla + '-' + negocioId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: tabla, filter: 'business_id=eq.' + negocioId },
          p => this._llego(p.new))
        .subscribe(estado => { if (estado === 'CHANNEL_ERROR') console.warn('[Campana] Tiempo real no disponible (¿corriste el SQL?)'); });
    },

    _llego(fila) {
      if (!fila || this.filas.some(f => f.id === fila.id)) return;
      this.filas.unshift(fila);
      this.filas = this.filas.slice(0, 40);
      this._pintar();
      this._sonar();
      this._aviso(fila);
      if (this.cfg.alLlegar) { try { this.cfg.alLlegar(fila); } catch (e) { console.error(e); } }
    },

    // ---- UI ----
    _montarBoton(contenedor) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cmp-btn'; b.setAttribute('aria-label', 'Avisos');
      b.innerHTML = '<i class="ti ti-bell"></i><span class="cmp-num" hidden></span>';
      b.onclick = ev => { ev.stopPropagation(); this.alternar(); };
      contenedor.insertBefore(b, contenedor.firstChild);
      return b;
    },

    _panel() {
      if (document.getElementById('cmp-panel')) return;
      const p = document.createElement('div');
      p.id = 'cmp-panel'; p.className = 'cmp-panel'; p.hidden = true;
      p.innerHTML = `<div class="cmp-hdr"><b>Avisos</b><button type="button" class="cmp-x" aria-label="Cerrar">×</button></div><div class="cmp-lista" id="cmp-lista"></div>`;
      p.querySelector('.cmp-x').onclick = () => this.cerrar();
      p.addEventListener('click', e => e.stopPropagation());
      document.body.appendChild(p);
      document.addEventListener('click', () => this.abierta && this.cerrar());
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.abierta) this.cerrar(); });
    },

    alternar() { this.abierta ? this.cerrar() : this.abrir(); },
    abrir() {
      this.abierta = true;
      const p = document.getElementById('cmp-panel');
      this._pintarLista();
      p.hidden = false;
      // Al abrir se dan por vistos
      this._marcarVisto();
      setTimeout(() => this._pintarContador(), 400);
    },
    cerrar() { this.abierta = false; const p = document.getElementById('cmp-panel'); if (p) p.hidden = true; this._pintarLista(); },

    _pintar() { this._pintarContador(); if (this.abierta) this._pintarLista(); },

    _pintarContador() {
      const n = this._sinLeer().length;
      this.botones.forEach(b => {
        const el = b.querySelector('.cmp-num');
        el.hidden = n === 0; el.textContent = n > 9 ? '9+' : String(n);
        b.classList.toggle('on', n > 0);
      });
      if (!this._tituloBase) this._tituloBase = document.title.replace(/^\(\d+\+?\)\s*/, '');
      document.title = (n ? '(' + (n > 9 ? '9+' : n) + ') ' : '') + this._tituloBase;
    },

    _pintarLista() {
      const lista = document.getElementById('cmp-lista');
      if (!lista || !this.cfg) return;
      const v = this._vistoHasta();
      if (!this.filas.length) { lista.innerHTML = '<p class="cmp-vacio">Sin avisos por ahora.</p>'; return; }
      lista.innerHTML = this.filas.map((f, i) => {
        const d = this.cfg.describir(f);
        const nuevo = !v || (d.fecha && d.fecha > v);
        return `<button type="button" class="cmp-item${nuevo ? ' nuevo' : ''}${d.urgente ? ' urgente' : ''}" data-i="${i}">
          <i class="ti ${d.urgente ? 'ti-hourglass' : 'ti-circle-plus'}"></i>
          <span><b>${esc(d.titulo)}</b><small>${esc(d.detalle || '')}</small>${d.fecha ? `<em>${haceCuanto(d.fecha)}</em>` : ''}</span>
        </button>`;
      }).join('');
      lista.querySelectorAll('.cmp-item').forEach(b => b.onclick = () => {
        const f = this.filas[Number(b.dataset.i)];
        this.cerrar();
        if (f && this.cfg.alAbrir) this.cfg.alAbrir(f);
      });
    },

    _aviso(fila) {
      const d = this.cfg.describir(fila);
      const t = document.createElement('div');
      t.className = 'cmp-toast' + (d.urgente ? ' urgente' : '');
      t.innerHTML = `<i class="ti ti-bell-ringing"></i><span><b>${esc(d.titulo)}</b><small>${esc(d.detalle || '')}</small></span><button type="button">Ver</button>`;
      t.querySelector('button').onclick = () => { t.remove(); this.cfg.alAbrir && this.cfg.alAbrir(fila); };
      document.body.appendChild(t);
      setTimeout(() => t.classList.add('fuera'), 7000);
      setTimeout(() => t.remove(), 7600);
    },

    // Dos tonos cortos (los navegadores solo dejan sonar después de que tocaste la página)
    _sonar() {
      try {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return;
        const ctx = this._ctx || (this._ctx = new Ctx());
        [[880, 0], [1320, 0.16]].forEach(([fr, t0]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = fr;
          g.gain.setValueAtTime(0.0001, ctx.currentTime + t0);
          g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + 0.28);
          o.connect(g); g.connect(ctx.destination);
          o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + 0.3);
        });
      } catch (e) {}
    },

    _estilos() {
      if (document.getElementById('cmp-css')) return;
      const st = document.createElement('style');
      st.id = 'cmp-css';
      st.textContent = `
.cmp-btn{position:relative;width:40px;height:40px;border-radius:12px;border:1px solid #E7E2EE;background:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background .15s,border-color .15s;}
.cmp-btn i{font-size:19px;color:#5E5A6E;}
.cmp-btn:hover{background:#F9F6FD;border-color:#D8C9EC;}
.cmp-btn.on i{color:#7C3AED;animation:cmpDing 1.2s ease 2;}
.cmp-num{position:absolute;top:-6px;right:-6px;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:#E1306C;color:#fff;font:700 10.5px/19px system-ui,sans-serif;text-align:center;border:2px solid #fff;}
@keyframes cmpDing{0%,100%{transform:rotate(0)}15%{transform:rotate(14deg)}30%{transform:rotate(-12deg)}45%{transform:rotate(8deg)}60%{transform:rotate(-5deg)}}
.cmp-panel{position:fixed;top:64px;right:16px;width:min(360px,calc(100vw - 24px));max-height:min(70vh,520px);background:#fff;border:1px solid #E7E2EE;border-radius:18px;box-shadow:0 24px 60px -24px rgba(40,20,80,.45);z-index:9000;display:flex;flex-direction:column;overflow:hidden;}
.cmp-panel[hidden]{display:none;}
.cmp-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #F0ECF6;font-size:15px;}
.cmp-x{border:0;background:none;font-size:22px;line-height:1;color:#8A8796;cursor:pointer;}
.cmp-lista{overflow-y:auto;padding:6px;}
.cmp-item{width:100%;display:flex;gap:10px;align-items:flex-start;text-align:left;border:0;background:none;padding:10px;border-radius:12px;cursor:pointer;font-family:inherit;}
.cmp-item:hover{background:#F7F4FC;}
.cmp-item i{font-size:18px;color:#7C3AED;margin-top:1px;}
.cmp-item.urgente i{color:#B7791F;}
.cmp-item span{display:flex;flex-direction:column;gap:2px;min-width:0;}
.cmp-item b{font-size:13px;color:#24212E;}
.cmp-item small{font-size:12px;color:#6E6A7C;}
.cmp-item em{font-style:normal;font-size:11px;color:#A19DAE;}
.cmp-item.nuevo{background:#F6F1FE;}
.cmp-item.nuevo b::after{content:" •";color:#E1306C;}
.cmp-vacio{padding:22px;text-align:center;font-size:13px;color:#8A8796;}
.cmp-toast{position:fixed;right:16px;bottom:16px;z-index:9001;display:flex;align-items:center;gap:12px;max-width:min(380px,calc(100vw - 32px));padding:12px 12px 12px 14px;border-radius:16px;background:#24212E;color:#fff;box-shadow:0 18px 40px -16px rgba(0,0,0,.5);animation:cmpEntra .3s ease;transition:opacity .5s,transform .5s;}
.cmp-toast.urgente{background:#7A5200;}
.cmp-toast.fuera{opacity:0;transform:translateY(10px);}
.cmp-toast i{font-size:22px;color:#F7C6FF;}
.cmp-toast span{display:flex;flex-direction:column;gap:2px;min-width:0;}
.cmp-toast b{font-size:13.5px;}
.cmp-toast small{font-size:12px;opacity:.8;}
.cmp-toast button{margin-left:auto;border:0;border-radius:10px;padding:8px 12px;background:#fff;color:#24212E;font:700 12px/1 inherit;cursor:pointer;}
@keyframes cmpEntra{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(max-width:640px){.cmp-panel{top:58px;right:12px;}.cmp-toast{left:12px;right:12px;bottom:12px;max-width:none;}}
`;
      document.head.appendChild(st);
    }
  };

  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function haceCuanto(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return 'hace ' + m + ' min';
    const h = Math.round(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    const d = Math.round(h / 24);
    return 'hace ' + d + (d === 1 ? ' día' : ' días');
  }

  global.AnnlyCampana = C;
})(window);
