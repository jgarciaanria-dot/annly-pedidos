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
  // PANEL · CATÁLOGO
  // -------------------------------------------------------
  async _q(promesa) {
    const { data, error } = await promesa;
    if (error) throw new Error(this.mensajeError(error));
    return data;
  },

  async listarCategorias() {
    return (await this._q(sb.from('product_categories').select('*').eq('business_id', this.id)
      .order('position').order('name'))) || [];
  },
  async guardarCategoria(c) {
    const fila = { name: (c.name || '').trim(), active: c.active !== false, position: c.position || 0 };
    if (!fila.name) throw new Error('Escribe el nombre de la categoría.');
    if (c.id) return this._q(sb.from('product_categories').update(fila).eq('id', c.id).eq('business_id', this.id));
    return this._q(sb.from('product_categories').insert([{ ...fila, business_id: this.id }]).select('id').single());
  },
  async borrarCategoria(id) {
    return this._q(sb.from('product_categories').delete().eq('id', id).eq('business_id', this.id));
  },

  async listarProductos() {
    return (await this._q(sb.from('products').select('*, product_extras(item_id, price, position)')
      .eq('business_id', this.id).order('position').order('name'))) || [];
  },
  // p = { id?, name, category_id, description, photo_url, price, estimated_cost, active, extras:[{item_id, price}] }
  async guardarProducto(p) {
    const fila = {
      name: (p.name || '').trim(), category_id: p.category_id || null,
      description: (p.description || '').trim() || null, photo_url: p.photo_url || null,
      price: Number(p.price), estimated_cost: Number(p.estimated_cost || 0),
      active: p.active !== false, position: p.position || 0, updated_at: new Date().toISOString()
    };
    if (!fila.name) throw new Error('Escribe el nombre del producto.');
    if (!(fila.price >= 0) || isNaN(fila.price)) throw new Error('Escribe el precio del producto.');
    let id = p.id;
    if (id) await this._q(sb.from('products').update(fila).eq('id', id).eq('business_id', this.id));
    else id = (await this._q(sb.from('products').insert([{ ...fila, business_id: this.id }]).select('id').single())).id;
    // Extras: se reemplaza la lista completa del producto
    await this._q(sb.from('product_extras').delete().eq('product_id', id).eq('business_id', this.id));
    const extras = (p.extras || []).map((x, i) => ({
      product_id: id, item_id: x.item_id, business_id: this.id, position: i,
      price: x.price === '' || x.price == null ? null : Number(x.price)
    }));
    if (extras.length) await this._q(sb.from('product_extras').insert(extras));
    return id;
  },
  async borrarProducto(id) {
    return this._q(sb.from('products').delete().eq('id', id).eq('business_id', this.id));
  },

  // Foto: se reduce en el navegador (máx. 1200 px, WebP) antes de subirla
  async subirFoto(file) {
    const blob = await this._reducirImagen(file, 1200, 0.85);
    const path = `${this.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
    const { error } = await sb.storage.from('productos').upload(path, blob, { contentType: 'image/webp', upsert: false });
    if (error) throw new Error('No se pudo subir la foto: ' + this.mensajeError(error));
    return sb.storage.from('productos').getPublicUrl(path).data.publicUrl;
  },
  _reducirImagen(file, max, calidad) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) { reject(new Error('El archivo no es una imagen.')); return; }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const escala = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo procesar la imagen.')), 'image/webp', calidad);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
      img.src = url;
    });
  },

  // -------------------------------------------------------
  // PANEL · INVENTARIO
  // -------------------------------------------------------
  async listarArticulos() {
    const [items, stock] = await Promise.all([
      this._q(sb.from('inventory_items').select('*').eq('business_id', this.id).order('name')),
      this._q(sb.from('inventory_stock').select('item_id, stock, stock_bajo').eq('business_id', this.id))
    ]);
    return (items || []).map(i => {
      const st = (stock || []).find(s => s.item_id === i.id) || {};
      return { ...i, stock: Number(st.stock || 0), stock_bajo: !!st.stock_bajo };
    });
  },
  // a = { id?, name, description, unit_cost, sale_price, stock_min, track_stock, active, stock_inicial? }
  async guardarArticulo(a) {
    const fila = {
      name: (a.name || '').trim(), description: (a.description || '').trim() || null,
      unit_cost: Number(a.unit_cost || 0), sale_price: Number(a.sale_price || 0),
      stock_min: Number(a.stock_min || 0), track_stock: a.track_stock !== false,
      active: a.active !== false, updated_at: new Date().toISOString()
    };
    if (!fila.name) throw new Error('Escribe el nombre del artículo.');
    if (a.id) { await this._q(sb.from('inventory_items').update(fila).eq('id', a.id).eq('business_id', this.id)); return a.id; }
    const id = (await this._q(sb.from('inventory_items').insert([{ ...fila, business_id: this.id }]).select('id').single())).id;
    if (fila.track_stock && Number(a.stock_inicial) > 0) {
      await this.moverInventario(id, 'entrada', Number(a.stock_inicial), fila.unit_cost, 'Stock inicial');
    }
    return id;
  },
  async moverInventario(itemId, tipo, qty, costo, nota) {
    const { data, error } = await sb.rpc('pedidos_mover_inventario', {
      p_item: itemId, p_tipo: tipo, p_qty: qty, p_unit_cost: costo === '' || costo == null ? null : Number(costo), p_nota: nota || null
    });
    if (error) throw new Error(this.mensajeError(error));
    return data;
  },
  async movimientos(itemId) {
    return (await this._q(sb.from('inventory_movements').select('*').eq('item_id', itemId).eq('business_id', this.id)
      .order('created_at', { ascending: false }).limit(30))) || [];
  },

  // -------------------------------------------------------
  // PANEL · ENTREGAS, HORARIOS Y CONFIGURACIÓN
  // -------------------------------------------------------
  async configuracion() {
    const d = await this._q(sb.from('order_settings').select('*').eq('business_id', this.id).maybeSingle());
    return d || { business_id: this.id, min_prep_hours: 3, warn_hours: 24, pending_expiry_hours: 24, max_days_ahead: 60, acepta_retiro: true, acepta_domicilio: true };
  },
  async guardarConfiguracion(c) {
    return this._q(sb.from('order_settings').upsert([{ ...c, business_id: this.id, updated_at: new Date().toISOString() }], { onConflict: 'business_id' }));
  },
  // Datos del negocio que usa la tienda (pago y contacto)
  async guardarDatosNegocio(d) {
    const fila = {
      yappy_numero: (d.yappy_numero || '').replace(/\D/g, '') || null,
      whatsapp: (d.whatsapp || '').replace(/\D/g, '') || null,
      direccion: (d.direccion || '').trim() || null,
      instagram: (d.instagram || '').trim().replace(/^@+/, '') || null,
      tagline: (d.tagline || '').trim() || null
    };
    const data = await this._q(sb.from('businesses').update(fila).eq('id', this.id).select('*'));
    if (!data || !data.length) throw new Error('No se pudieron guardar los datos (sin permisos).');
    Object.assign(this.negocio, data[0]);
  },

  // Logo de la tienda (mismo espacio de fotos, carpeta del negocio)
  async subirLogo(file) {
    const blob = await this._reducirImagen(file, 600, 0.9);
    const path = `${this.id}/logo-${Date.now()}.webp`;
    const { error } = await sb.storage.from('productos').upload(path, blob, { contentType: 'image/webp', upsert: false });
    if (error) throw new Error('No se pudo subir el logo: ' + this.mensajeError(error));
    const url = sb.storage.from('productos').getPublicUrl(path).data.publicUrl;
    const data = await this._q(sb.from('businesses').update({ logo_url: url }).eq('id', this.id).select('logo_url'));
    if (!data || !data.length) throw new Error('No se pudo guardar el logo (sin permisos).');
    this.negocio.logo_url = url;
    return url;
  },
  async quitarLogo() {
    await this._q(sb.from('businesses').update({ logo_url: null }).eq('id', this.id));
    this.negocio.logo_url = null;
  },

  async listarZonas() {
    return (await this._q(sb.from('order_zones').select('*').eq('business_id', this.id).order('position').order('name'))) || [];
  },
  async guardarZona(z) {
    const fila = { name: (z.name || '').trim(), price: Number(z.price || 0), active: z.active !== false };
    if (!fila.name) throw new Error('Escribe el nombre de la zona.');
    if (z.id) return this._q(sb.from('order_zones').update(fila).eq('id', z.id).eq('business_id', this.id));
    return this._q(sb.from('order_zones').insert([{ ...fila, business_id: this.id }]));
  },
  async borrarZona(id) {
    return this._q(sb.from('order_zones').delete().eq('id', id).eq('business_id', this.id));
  },

  async listarFranjas() {
    return (await this._q(sb.from('order_slots').select('*').eq('business_id', this.id).order('weekday').order('start_time'))) || [];
  },
  async guardarFranja(f) {
    const fila = { weekday: Number(f.weekday), start_time: f.start_time, end_time: f.end_time, capacity: Number(f.capacity), active: f.active !== false };
    if (!fila.start_time || !fila.end_time) throw new Error('Indica la hora de inicio y de fin.');
    if (fila.end_time <= fila.start_time) throw new Error('La hora de fin debe ser después de la de inicio.');
    if (!(fila.capacity > 0)) throw new Error('La capacidad debe ser de al menos 1 pedido.');
    if (f.id) return this._q(sb.from('order_slots').update(fila).eq('id', f.id).eq('business_id', this.id));
    return this._q(sb.from('order_slots').insert([{ ...fila, business_id: this.id }]));
  },
  // Una franja con pedidos no se borra: se desactiva (los pedidos conservan su horario)
  async borrarFranja(id) {
    const { count } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('slot_id', id);
    if (count) {
      await this._q(sb.from('order_slots').update({ active: false }).eq('id', id).eq('business_id', this.id));
      return 'desactivada';
    }
    await this._q(sb.from('order_slots').delete().eq('id', id).eq('business_id', this.id));
    return 'borrada';
  },

  async listarFechasBloqueadas() {
    return (await this._q(sb.from('order_blocked_dates').select('*').eq('business_id', this.id)
      .gte('fecha', this.hoyISO()).order('fecha'))) || [];
  },
  async bloquearFecha(fecha, motivo) {
    if (!fecha) throw new Error('Elige la fecha.');
    return this._q(sb.from('order_blocked_dates').upsert([{ business_id: this.id, fecha, motivo: (motivo || '').trim() || null }], { onConflict: 'business_id,fecha' }));
  },
  async desbloquearFecha(id) {
    return this._q(sb.from('order_blocked_dates').delete().eq('id', id).eq('business_id', this.id));
  },

  // -------------------------------------------------------
  // PANEL · PEDIDOS
  // -------------------------------------------------------
  // f = { desde, hasta, estados:[...] } (fechas ISO; sin fechas = todas)
  async listarPedidos(f = {}) {
    let q = sb.from('orders').select('*, order_extras(name, qty, unit_price), order_payments(tipo, monto, comprobante, estado)')
      .eq('business_id', this.id);
    if (f.desde) q = q.gte('fecha', f.desde);
    if (f.hasta) q = q.lte('fecha', f.hasta);
    if (f.estados && f.estados.length) q = q.in('estado', f.estados);
    q = q.order('fecha', { ascending: true }).order('hora_inicio', { ascending: true }).order('numero', { ascending: true }).limit(500);
    return (await this._q(q)) || [];
  },
  async detallePedido(id) {
    const [pedido, historial] = await Promise.all([
      this._q(sb.from('orders').select('*, order_extras(*), order_payments(*)').eq('id', id).eq('business_id', this.id).single()),
      this._q(sb.from('order_history').select('*').eq('order_id', id).order('created_at', { ascending: true }))
    ]);
    return { ...pedido, historial: historial || [] };
  },
  async confirmarPago(id) {
    const { error } = await sb.rpc('pedidos_confirmar_pago', { p_order: id });
    if (error) throw new Error(this.mensajeError(error));
  },
  async cambiarEstado(id, estado) {
    const { error } = await sb.rpc('pedidos_cambiar_estado', { p_order: id, p_estado: estado });
    if (error) throw new Error(this.mensajeError(error));
  },
  async cancelarPedido(id, motivo, reembolso, devolverStock) {
    const { error } = await sb.rpc('pedidos_cancelar', {
      p_order: id, p_motivo: motivo, p_reembolso: Number(reembolso || 0), p_devolver_stock: !!devolverStock
    });
    if (error) throw new Error(this.mensajeError(error));
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
