// =========================================================
// pedidos.js — Capa de datos de Annly Pedidos
// Panel (admin.html) y tienda pública (tienda.html).
// Las claves viven en config.js (window.PEDIDOS_CONFIG).
// =========================================================

const PCFG = window.PEDIDOS_CONFIG || {};
const sb = window.supabase.createClient(PCFG.SUPABASE_URL, PCFG.SUPABASE_KEY);

const Pedidos = {
  negocio: null,        // negocio activo (fila de businesses)
  negocios: [],         // Platform Admin: todos los negocios de pedidos
  esPlatformAdmin: false,

  // -------------------------------------------------------
  // SESIÓN
  // -------------------------------------------------------

  // Annly (registro o panel de Agenda) pasa la sesión en el hash:
  // #annly_at=...&annly_rt=... → se activa aquí y se borra de la URL.
  async tomarSesionDelHash() {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const at = h.get('annly_at'), rt = h.get('annly_rt');
    if (!at || !rt) return false;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    const { error } = await sb.auth.setSession({ access_token: at, refresh_token: rt });
    if (error) { console.error('No se pudo tomar la sesión de Annly:', error); return false; }
    return true;
  },

  async sesion() {
    const { data } = await sb.auth.getSession();
    return (data && data.session) || null;
  },

  async entrar(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async entrarConGoogle() {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/admin' }
    });
    if (error) throw error;
  },

  async salir() {
    await sb.auth.signOut();
    window.location.href = '/admin';
  },

  // -------------------------------------------------------
  // NEGOCIO DEL PANEL
  // Devuelve 'ok' | 'sin-negocio' | 'es-citas'
  // -------------------------------------------------------
  async cargarNegocioDelPanel() {
    const ses = await this.sesion();
    if (!ses) return 'sin-sesion';
    try {
      const { data } = await sb.rpc('is_platform_admin');
      this.esPlatformAdmin = data === true;
    } catch (e) { this.esPlatformAdmin = false; }

    if (this.esPlatformAdmin) {
      const { data, error } = await sb.from('businesses').select('*')
        .eq('tipo_negocio', 'pedidos').order('nombre', { ascending: true });
      if (error) throw error;
      this.negocios = data || [];
      const guardado = sessionStorage.getItem('pedidos_negocio_id');
      this.negocio = this.negocios.find(n => n.id === guardado) || this.negocios[0] || null;
      return this.negocio ? 'ok' : 'sin-negocio';
    }

    const { data, error } = await sb.from('businesses').select('*')
      .eq('owner_user_id', ses.user.id).limit(1);
    if (error) throw error;
    const n = data && data[0];
    if (!n) return 'sin-negocio';
    if (n.tipo_negocio !== 'pedidos') return 'es-citas';
    this.negocio = n;
    return 'ok';
  },

  seleccionarNegocio(id) {
    const n = this.negocios.find(x => x.id === id);
    if (!n) return;
    this.negocio = n;
    sessionStorage.setItem('pedidos_negocio_id', id);
  },

  // Un negocio de citas que entró aquí por error: se le envía a su panel de Annly Agenda
  urlPanelAgenda() {
    return (PCFG.ANNLY_URL || 'https://annly.app') + '/admin.html';
  },

  get id() { return this.negocio ? this.negocio.id : null; },

  // -------------------------------------------------------
  // PRIMEROS PASOS: qué tiene configurado el negocio
  // -------------------------------------------------------
  async estadoConfiguracion() {
    const b = this.id;
    const contar = async (tabla, extra) => {
      let q = sb.from(tabla).select('id', { count: 'exact', head: true }).eq('business_id', b);
      if (extra) q = extra(q);
      const { count, error } = await q;
      if (error) { console.error('Conteo de ' + tabla + ':', error); return 0; }
      return count || 0;
    };
    const [categorias, productos, articulos, zonas, franjas, pedidosHoy, pendientes] = await Promise.all([
      contar('product_categories', q => q.eq('active', true)),
      contar('products', q => q.eq('active', true)),
      contar('inventory_items', q => q.eq('active', true)),
      contar('order_zones', q => q.eq('active', true)),
      contar('order_slots', q => q.eq('active', true)),
      contar('orders', q => q.eq('fecha', this.hoyISO()).neq('estado', 'CANCELADO')),
      contar('orders', q => q.eq('estado', 'PENDIENTE'))
    ]);
    const n = this.negocio || {};
    return {
      categorias, productos, articulos, zonas, franjas, pedidosHoy, pendientes,
      yappy: !!(n.yappy_numero || n.tiene_yappy_comercial)
    };
  },

  // Pedidos cuyo pago no se confirmó a tiempo → cancelados y stock liberado
  async liberarVencidos() {
    if (!this.id) return 0;
    const { data, error } = await sb.rpc('pedidos_liberar_vencidos', { p_business: this.id });
    if (error) { console.error('Liberar vencidos:', error); return 0; }
    return data || 0;
  },

  // -------------------------------------------------------
  // TIENDA PÚBLICA
  // -------------------------------------------------------
  slugDeLaUrl() {
    return decodeURIComponent(window.location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '').toLowerCase();
  },

  async cargarNegocioPorSlug(slug) {
    const { data, error } = await sb.from('businesses').select('*').eq('slug', slug).maybeSingle();
    if (error) throw error;
    this.negocio = data || null;
    return this.negocio;
  },

  async catalogo() {
    const { data, error } = await sb.rpc('pedidos_catalogo', { p_business: this.id });
    if (error) throw error;
    return data || { categorias: [], productos: [], zonas: [], config: null };
  },

  async franjas(fechaISO) {
    const { data, error } = await sb.rpc('pedidos_franjas', { p_business: this.id, p_fecha: fechaISO });
    if (error) throw error;
    return data || [];
  },

  // Todos los precios y validaciones se hacen en la base (pedidos_crear)
  async crearPedido(p) {
    const { data, error } = await sb.rpc('pedidos_crear', { p: { ...p, businessId: this.id } });
    if (error) throw new Error(this.mensajeError(error));
    return data;
  },

  // -------------------------------------------------------
  // UTILIDADES
  // -------------------------------------------------------
  hoyISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },

  dinero(n) { return '$' + Number(n || 0).toFixed(2); },

  // Los errores de las funciones de la base ya vienen en español para el cliente
  mensajeError(e) {
    const m = (e && (e.message || e.details)) || '';
    return m || 'No se pudo completar la operación. Intenta de nuevo.';
  },

  esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};

window.Pedidos = Pedidos;
