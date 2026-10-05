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
      yappy: !!(n.yappy_numero || n.tiene_yappy_comercial || (n.banco_nombre && n.banco_numero_cuenta))
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
      solo_promo: !!p.solo_promo,
      precio_oferta: p.precio_oferta === '' || p.precio_oferta == null ? null : Number(p.precio_oferta),
      oferta_hasta: p.oferta_hasta || null,
      active: p.active !== false, position: p.position || 0, updated_at: new Date().toISOString()
    };
    if (!fila.name) throw new Error('Escribe el nombre del producto.');
    if (!(fila.price >= 0) || isNaN(fila.price)) throw new Error('Escribe el precio del producto.');
    if (fila.precio_oferta != null && !(fila.precio_oferta > 0 && fila.precio_oferta < fila.price))
      throw new Error('El precio de oferta debe ser mayor que 0 y menor que el precio normal.');
    if (fila.precio_oferta == null) fila.oferta_hasta = null;
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
  // -------------------------------------------------------
  // REPORTES (módulo Ventas e Inventario)
  // -------------------------------------------------------
  // Pedidos de un rango por fecha de entrega, con extras y pagos (sin el límite de 500 de la lista)
  async pedidosParaReporte(desde, hasta) {
    const filas = [];
    for (let desdeFila = 0; desdeFila < 10000; desdeFila += 1000) {
      const lote = await this._q(sb.from('orders')
        .select('id, numero, fecha, estado, total, product_name, product_price, product_cost, delivery_type, zone_name, delivery_fee, cancel_reembolso, customer_name, abono_monto, saldo_pendiente, order_extras(name, qty, unit_price, unit_cost), order_payments(tipo, metodo, monto, estado)')
        .eq('business_id', this.id).gte('fecha', desde).lte('fecha', hasta)
        .order('fecha', { ascending: true }).order('numero', { ascending: true })
        .range(desdeFila, desdeFila + 999));
      filas.push(...(lote || []));
      if (!lote || lote.length < 1000) break;
    }
    return filas;
  },
  // Movimientos de inventario de un rango (todas las fechas en hora local de Panamá)
  async movimientosRango(desde, hasta) {
    const ini = new Date(desde + 'T00:00:00').toISOString();
    const fin = new Date(hasta + 'T23:59:59').toISOString();
    return (await this._q(sb.from('inventory_movements').select('*')
      .eq('business_id', this.id).gte('created_at', ini).lte('created_at', fin)
      .order('created_at', { ascending: true }).limit(5000))) || [];
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
      tagline: (d.tagline || '').trim() || null,
      // Transferencia bancaria (mismas columnas que usa Annly Agenda)
      banco_nombre: (d.banco_nombre || '').trim() || null,
      banco_tipo_cuenta: (d.banco_tipo_cuenta || '').trim() || null,
      banco_numero_cuenta: (d.banco_numero_cuenta || '').trim() || null,
      banco_titular: (d.banco_titular || '').trim() || null
    };
    const data = await this._q(sb.from('businesses').update(fila).eq('id', this.id).select('*'));
    if (!data || !data.length) throw new Error('No se pudieron guardar los datos (sin permisos).');
    Object.assign(this.negocio, data[0]);
  },

  // Nombre de la tienda (por si se escribió mal al registrarse). El link (slug) NO cambia,
  // para no romper los links que el negocio ya compartió.
  async guardarNombre(nombre) {
    const limpio = String(nombre || '').replace(/\s+/g, ' ').trim();
    if (limpio.length < 2) throw new Error('Escribe el nombre de tu tienda.');
    if (limpio.length > 60) throw new Error('El nombre puede tener hasta 60 caracteres.');
    const data = await this._q(sb.from('businesses').update({ nombre: limpio }).eq('id', this.id).select('id, nombre'));
    if (!data || !data.length) throw new Error('No se pudo guardar el nombre (sin permisos).');
    this.negocio.nombre = data[0].nombre;
    const enLista = (this.negocios || []).find(x => x.id === this.id);
    if (enLista) enLista.nombre = data[0].nombre;
    return data[0].nombre;
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

  // Foto de portada de la tienda (la elige el negocio; sin foto, la tienda usa la de un producto)
  async subirPortada(file) {
    const blob = await this._reducirImagen(file, 1600, 0.85);
    const path = `${this.id}/portada-${Date.now()}.webp`;
    const { error } = await sb.storage.from('productos').upload(path, blob, { contentType: 'image/webp', upsert: false });
    if (error) throw new Error('No se pudo subir la portada: ' + this.mensajeError(error));
    const url = sb.storage.from('productos').getPublicUrl(path).data.publicUrl;
    const data = await this._q(sb.from('businesses').update({ portada_url: url }).eq('id', this.id).select('portada_url'));
    if (!data || !data.length) throw new Error('No se pudo guardar la portada (sin permisos).');
    this.negocio.portada_url = url;
    return url;
  },
  // Cuánto se tiñe la foto de portada con el color de la tienda (0–80 %)
  async guardarVeloPortada(pct) {
    const v = Math.min(80, Math.max(0, Math.round(Number(pct) || 0)));
    const data = await this._q(sb.from('businesses').update({ portada_velo: v }).eq('id', this.id).select('portada_velo'));
    if (!data || !data.length) throw new Error('No se pudo guardar (sin permisos).');
    this.negocio.portada_velo = data[0].portada_velo;
  },
  async quitarPortada() {
    await this._q(sb.from('businesses').update({ portada_url: null }).eq('id', this.id));
    this.negocio.portada_url = null;
  },

  // -------------------------------------------------------
  // PLAN Y MÓDULOS (mismo sistema de suscripción que Agenda)
  // -------------------------------------------------------
  // Regla de Annly: durante la prueba solo funciona lo que trae el plan;
  // los módulos comprados se activan cuando la suscripción pasa a 'active'.
  plan: null,          // { id, status, vence, code, nombre, precio }
  modulos: [],         // códigos de módulos activos (pagados aparte)

  async cargarPlan() {
    const { data, error } = await sb.from('subscriptions').select('id, status, current_period_end, plans(code, name, monthly_price)')
      .eq('business_id', this.id).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) console.error('No se pudo leer el plan:', error);
    this.plan = data ? {
      id: data.id, status: data.status, vence: data.current_period_end,
      code: data.plans && data.plans.code, nombre: (data.plans && data.plans.name) || 'Tiendas',
      precio: Number((data.plans && data.plans.monthly_price) || 0)
    } : null;
    this.modulos = this.plan ? await this._modulosActivos(this.plan.id) : [];
    return this.plan;
  },

  async _modulosActivos(subId) {
    const hoy = new Date().toISOString().split('T')[0];
    const { data } = await sb.from('subscription_items').select('item_code, cancela_el, created_at')
      .eq('subscription_id', subId).eq('item_type', 'addon').eq('is_active', true);
    this._modulosDetalle = (data || []).filter(r => !r.cancela_el || r.cancela_el >= hoy);
    return this._modulosDetalle.map(r => r.item_code);
  },

  detalleModulo(code) { return (this._modulosDetalle || []).find(r => r.item_code === code) || null; },

  async catalogoModulos() {
    const { data } = await sb.from('features').select('code, name, description, monthly_price')
      .eq('is_addon', true).eq('is_active', true).eq('producto', 'pedidos').order('code');
    return (data || []).map(f => ({ code: f.code, nombre: f.name, descripcion: f.description, precio: Number(f.monthly_price) || 0 }));
  },

  // ¿Se puede USAR el módulo? Solo con la suscripción activa (no en prueba) y el módulo comprado
  moduloDisponible(code) {
    return !!(this.plan && this.plan.status === 'active' && this.modulos.includes(code));
  },

  async activarModulo(code, nombre, precio) {
    if (!this.plan) throw new Error('Tu tienda no tiene plan todavía.');
    const { error } = await sb.from('subscription_items').insert([{
      subscription_id: this.plan.id, item_type: 'addon', item_code: code,
      description: nombre, quantity: 1, unit_price: precio, is_active: true
    }]);
    if (error) throw new Error('No se pudo activar el módulo: ' + this.mensajeError(error));
    await this.cargarPlan();
  },

  // Sigue activo hasta cumplir un mes desde que se activó (no se corta lo ya pagado)
  async cancelarModulo(code) {
    const d = this.detalleModulo(code);
    if (!d) throw new Error('Ese módulo no está activo.');
    const corte = new Date(d.created_at); corte.setMonth(corte.getMonth() + 1);
    const fecha = corte.toISOString().split('T')[0];
    const { error } = await sb.from('subscription_items').update({ cancela_el: fecha })
      .eq('subscription_id', this.plan.id).eq('item_code', code).eq('item_type', 'addon').eq('is_active', true);
    if (error) throw new Error('No se pudo cancelar: ' + this.mensajeError(error));
    await this.cargarPlan();
    return fecha;
  },

  // Pago de la mensualidad con PagueloFácil: el servidor calcula el monto y crea un enlace único
  async crearEnlaceMensualidad() {
    const { data, error } = await sb.functions.invoke('pf-crear-enlace', {
      body: { negocioId: this.id, origen: 'pedidos', volverA: window.location.origin }
    });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    if (!data || !data.url) throw new Error((data && data.error) || 'No se pudo crear el enlace de pago.');
    return data;
  },
  // Pago de la mensualidad con Yappy: el servidor calcula el monto y crea la orden en Yappy
  async crearOrdenYappyMensualidad(aliasYappy) {
    const { data, error } = await sb.functions.invoke('yappy-crear-orden', {
      body: { negocioId: this.id, origen: 'pedidos', volverA: window.location.origin, aliasYappy }
    });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    if (!data || !data.body || !data.body.token) throw new Error((data && data.error) || 'No se pudo crear la orden de pago.');
    return data;
  },
  async pagosDelNegocio() {
    const { data } = await sb.from('pagos_plataforma').select('*').eq('business_id', this.id).order('creado_en', { ascending: false }).limit(10);
    return data || [];
  },

  // Sin pasarela de pago todavía: el dueño termina la prueba con un clic (igual que en Agenda)
  async activarSuscripcion() {
    if (!this.plan) throw new Error('Tu tienda no tiene plan todavía.');
    const { error } = await sb.from('subscriptions').update({ status: 'active' }).eq('id', this.plan.id);
    if (error) throw new Error('No se pudo activar el plan: ' + this.mensajeError(error));
    await this.cargarPlan();
  },

  // Paleta de colores de la tienda (las mismas 8 del registro de Annly)
  PALETAS: [
    { nombre: 'Violeta',         primario: '#7C3AED', secundario: '#EC4899' },
    { nombre: 'Ámbar Urbano',    primario: '#F77F00', secundario: '#1D1D1D' },
    { nombre: 'Esmeralda',       primario: '#0F766E', secundario: '#84CC16' },
    { nombre: 'Coral',           primario: '#E85D4F', secundario: '#F4A261' },
    { nombre: 'Marino Elegante', primario: '#1E3A5F', secundario: '#C9A96E' },
    { nombre: 'Carbón & Oro',    primario: '#2D2D2D', secundario: '#C9A96E' },
    { nombre: 'Rosa Cuarzo',     primario: '#D88C9A', secundario: '#6B3F4D' },
    { nombre: 'Lavanda Suave',   primario: '#B39DDB', secundario: '#5E3A87' }
  ],
  async guardarPaleta(primario, secundario) {
    const hex = /^#[0-9a-fA-F]{6}$/;
    if (!hex.test(primario) || !hex.test(secundario)) throw new Error('Colores no válidos.');
    const data = await this._q(sb.from('businesses').update({ color_primario: primario, color_secundario: secundario })
      .eq('id', this.id).select('color_primario, color_secundario'));
    if (!data || !data.length) throw new Error('No se pudieron guardar los colores (sin permisos).');
    Object.assign(this.negocio, data[0]);
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
  // Calendario: solo lo que se dibuja (sin extras ni pagos), más liviano para el celular
  async pedidosCalendario(desde, hasta) {
    return (await this._q(sb.from('orders')
      .select('id, numero, fecha, hora_inicio, hora_fin, estado, total, product_name, customer_name, recipient_name, delivery_type, zone_name, saldo_pendiente, abono_monto')
      .eq('business_id', this.id).gte('fecha', desde).lte('fecha', hasta).neq('estado', 'CANCELADO')
      .order('fecha', { ascending: true }).order('hora_inicio', { ascending: true }).limit(1000))) || [];
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
    // Función segura: un solo negocio, por su slug, con las columnas públicas
    const { data, error } = await sb.rpc('negocio_publico', { p_slug: slug });
    if (error) throw error;
    this.negocio = data || null;
    return this.negocio;
  },

  async catalogo() {
    const { data, error } = await sb.rpc('pedidos_catalogo', { p_business: this.id });
    if (error) throw error;
    return data || { categorias: [], productos: [], zonas: [], config: null };
  },

  // Ofertas vigentes de la tienda: { productId: { precio, hasta } }
  async ofertas() {
    const { data, error } = await sb.rpc('pedidos_ofertas', { p_business: this.id });
    if (error) { console.error('Ofertas no disponibles:', error); return {}; }
    return Object.fromEntries((data || []).map(o => [o.id, { precio: Number(o.precio_oferta), hasta: o.oferta_hasta }]));
  },

  // Productos "solo para promoción": se pueden pedir, pero no van en el catálogo
  async soloPromo() {
    const { data, error } = await sb.rpc('pedidos_solo_promo', { p_business: this.id });
    if (error) { console.error('Solo promoción no disponible:', error); return new Set(); }
    return new Set((data || []).map(r => r.id));
  },

  // Promoción destacada (misma tabla que Agenda: promo_banner)
  async promo() {
    const { data } = await sb.from('promo_banner').select('*').eq('business_id', this.id).maybeSingle();
    return data || null;
  },
  async guardarPromo(pr) {
    const fila = {
      business_id: this.id, activa: !!pr.activa, tema: pr.tema || 'fiesta',
      etiqueta: (pr.etiqueta || '').trim() || null, festejo: (pr.festejo || '').trim() || null,
      vigencia: (pr.vigencia || '').trim() || null, producto_id: pr.producto_id || null,
      servicio: pr.servicio || null, precio_normal: pr.precio_normal || null, precio_promo: pr.precio_promo || null
    };
    if (fila.activa && !fila.producto_id) throw new Error('Elige el producto que quieres destacar.');
    const { error } = await sb.from('promo_banner').upsert(fila, { onConflict: 'business_id' });
    if (error) throw new Error('No se pudo guardar la promoción: ' + this.mensajeError(error));
  },

  async franjas(fechaISO) {
    const { data, error } = await sb.rpc('pedidos_franjas', { p_business: this.id, p_fecha: fechaISO });
    if (error) throw error;
    return data || [];
  },

  // Todos los precios y validaciones se hacen en la base (pedidos_crear)
  // Siempre pasa por la función que aplica en el servidor la oferta vigente y el abono (p.pagoTipo = 'total' | 'abono').
  // Si aún no existe (SQL pendiente), se crea el pedido normal.
  async crearPedido(p) {
    const datos = { ...p, businessId: this.id };
    {
      const { data, error } = await sb.rpc('pedidos_crear_con_abono', { p: datos });
      if (!error) return data;
      if (!/function|does not exist|schema cache/i.test(error.message || '')) throw new Error(this.mensajeError(error));
      console.error('pedidos_crear_con_abono no está instalada; se crea el pedido sin oferta ni abono.', error);
    }
    const { data, error } = await sb.rpc('pedidos_crear', { p: datos });
    if (error) throw new Error(this.mensajeError(error));
    return data;
  },

  // Panel: cobra el saldo de un pedido con abono
  async registrarSaldo(id, metodo, comprobante) {
    const { error } = await sb.rpc('pedidos_registrar_saldo', { p_order: id, p_metodo: metodo, p_comprobante: comprobante || null });
    if (error) throw new Error(this.mensajeError(error));
  },
  // Panel: monto del abono de la tienda (null = no acepta abono)
  async guardarAbono(monto) {
    const v = monto === '' || monto == null ? null : Math.round(Number(monto) * 100) / 100;
    if (v != null && !(v > 0)) throw new Error('El abono debe ser mayor que 0, o déjalo vacío para no aceptar abono.');
    const data = await this._q(sb.from('businesses').update({ abono_pedido: v }).eq('id', this.id).select('abono_pedido'));
    if (!data || !data.length) throw new Error('No se pudo guardar el abono (sin permisos).');
    this.negocio.abono_pedido = data[0].abono_pedido;
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

Pedidos.cliente = sb; // lo usa la campanita (tiempo real)
window.Pedidos = Pedidos;
