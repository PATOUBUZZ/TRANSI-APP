/* =====================================================================
 *  agence-benin.js  |  Portail AGENCE BÉNIN (Cotonou)
 * =====================================================================
 *  Accès : rôle « benin_staff » (l'admin peut aussi superviser).
 *  Ce que peut faire un employé de l'agence (garanti par la RLS) :
 *    - pointer l'arrivée des colis, lot par lot ou colis par colis
 *    - contrôler un colis (photos de l'entrepôt, observation) et le
 *      mettre à disposition du client
 *    - remettre les colis au client : encaissement + nom du receveur
 *  Il ne peut PAS : modifier un tarif ou un montant, créer un colis,
 *  toucher aux colis encore en Chine, ni modifier un colis déjà livré.
 *
 *  Plan du fichier :
 *   1. Imports, état, utilitaires    6. Section « Remise au client »
 *   2. Chargement des données        7. Section « Livrés » + reçus
 *   3. Navigation                    8. Temps réel & démarrage
 *   4. Section « Arrivages »
 *   5. Section « À l'agence »
 * ===================================================================== */


/* =====================================================================
 * 1. IMPORTS, ÉTAT, UTILITAIRES
 * ===================================================================== */
import {
  supabase, initPage, subscribeToTable, fetchAll,
  escapeHtml as esc, friendlyError, formatMoney, formatDate, formatWeight, formatVolume,
  statusBadge, statusLabel, modeLabel, debounce, toast, icon,
  pageHead, emptyState, setBusy, openModal, closeModal, bindModalBasics, askConfirm,
  renderNav, highlightNav, setBadge, bindDrawer, createRouter, openScanner, canScanBarcodes, $, $$,
} from './plateforms.js';

import {
  APP, ROLES, SHIPMENT_STATUS_LABELS, SHIPMENT_KIND_LABELS,
  PAYMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS,
} from './config.js';

const state = {
  profile: null,
  packages: [],        // colis actifs côté Bénin : en transit, arrivés, disponibles
  users: [],           // profils clients (nom, téléphone)
  shipments: [],       // lots
  delivered: [],       // derniers colis livrés (section « Livrés »)
  deliveredToday: 0,
  company: '',         // nom de l'entreprise (reçus)
};

const ui = {
  arrQuery: '',
  agencyTab: 'control', agencyQuery: '',
  selected: new Set(),         // colis cochés dans « À contrôler »
  delQuery: '',
  histQuery: '',
};

let router = null;

const userById = (id) => state.users.find((u) => u.id === id);
const clientName = (id) => userById(id)?.full_name || userById(id)?.email || 'Client inconnu';
const shipmentById = (id) => state.shipments.find((s) => s.id === id);
const pkgById = (id) => state.packages.find((p) => p.id === id) || state.delivered.find((p) => p.id === id);
const lotPackages = (id) => state.packages.filter((p) => p.shipment_id === id);

/** Délégation d'événements : on(root, 'click', '[data-x]', (el, event) => ...) */
function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(el, e);
  });
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
const amountOf = (p) => Number(p.amount_due || 0);
const sumAmount = (list) => list.reduce((s, p) => s + amountOf(p), 0);
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const measureText = (p) => (p.weight_kg ? formatWeight(p.weight_kg) : '—') + (p.volume_m3 ? ' · ' + formatVolume(p.volume_m3) : '');

function kpi(iconName, label, value, tone = '') {
  return '<div class="kpi ' + (tone ? 'kpi--' + tone : '') + '"><span class="kpi__icon">' + icon(iconName, 22) + '</span>' +
    '<span><span class="kpi__value">' + value + '</span><br><span class="kpi__label">' + esc(label) + '</span></span></div>';
}

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';


/* =====================================================================
 * 2. CHARGEMENT DES DONNÉES
 *    Les colis actifs sont lus d'un coup puis filtrés ici (recherche
 *    instantanée). Les colis livrés (nombreux) sont chargés à part.
 * ===================================================================== */
async function loadAll() {
  const [packages, users, shipments, today] = await Promise.all([
    fetchAll(() => supabase.from('packages').select('*')
      .in('status', ['in_transit', 'arrived_benin', 'available_agency'])
      .order('created_at', { ascending: false }).order('id')),
    fetchAll(() => supabase.from('users').select('id, full_name, email, phone, role').order('id')),
    supabase.from('shipments').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('packages').select('id', { count: 'exact', head: true })
      .eq('status', 'delivered').gte('delivered_at', startOfToday().toISOString()),
  ]);
  if (shipments.error) throw shipments.error;
  state.packages = packages;
  state.users = users;
  state.shipments = shipments.data;
  state.deliveredToday = today.count || 0;
  updateBadges();
}

async function loadDelivered() {
  const { data, error } = await supabase.from('packages').select('*')
    .eq('status', 'delivered').order('delivered_at', { ascending: false }).limit(300);
  if (error) throw error;
  state.delivered = data;
}

const transitList = () => state.packages.filter((p) => p.status === 'in_transit');
const arrivedList = () => state.packages.filter((p) => p.status === 'arrived_benin');
const availableList = () => state.packages.filter((p) => p.status === 'available_agency');

function updateBadges() {
  setBadge('arrivals', transitList().length);
  setBadge('agency', arrivedList().length);
  setBadge('delivery', availableList().length);
}


/* =====================================================================
 * 3. NAVIGATION
 * ===================================================================== */
const SECTIONS = {
  arrivals: { label: 'Arrivages',        icon: 'truck',       render: renderArrivals, mount: mountArrivals },
  agency:   { label: 'À l\'agence',      icon: 'package',     render: renderAgency,   mount: mountAgency },
  delivery: { label: 'Remise au client', icon: 'checkCircle', render: renderDelivery, mount: mountDelivery },
  history:  { label: 'Livrés',           icon: 'file',        render: renderHistory,  mount: mountHistory },
};

const NAV_GROUPS = [
  ['Arrivée à Cotonou', ['arrivals', 'agency']],
  ['Clients', ['delivery', 'history']],
];


/* =====================================================================
 * 4. SECTION : ARRIVAGES
 *    Deux façons de pointer : colis par colis (scan / saisie) ou depuis
 *    la fiche d'un lot. Quand tout est arrivé, on clôture l'arrivage.
 * ===================================================================== */

function searchPackages(q) {
  const needle = norm(q);
  if (!needle) return [];
  return state.packages.filter((p) => norm(p.supplier_tracking).includes(needle) || norm(p.reference).includes(needle));
}

/** Carte colis des résultats de recherche */
function arrivalCard(p) {
  const inTransit = p.status === 'in_transit';
  return '<button type="button" class="pkg" ' + (inTransit ? 'data-point="' : 'data-open-pkg="') + p.id + '">' +
    '<span class="pkg__icon pkg__icon--' + p.shipping_mode + '">' + icon(p.shipping_mode === 'air' ? 'plane' : 'ship', 24) + '</span>' +
    '<span class="pkg__body">' +
      '<span class="pkg__top"><strong class="pkg__ref">' + esc(p.supplier_tracking) + '</strong>' + statusBadge(p.status) + '</span>' +
      '<span class="pkg__client">' + esc(clientName(p.client_id)) + ' · ' + esc(p.reference) + '</span>' +
      '<span class="pkg__meta"><span>' + esc(modeLabel(p.shipping_mode)) + '</span>' +
      (shipmentById(p.shipment_id) ? '<span>Lot ' + esc(shipmentById(p.shipment_id).reference) + '</span>' : '') + '</span>' +
    '</span><span class="pkg__action">' + (inTransit ? 'Pointer l\'arrivée' : 'Voir') + '</span></button>';
}

function lotsInTransitHtml() {
  const lots = state.shipments.filter((s) => s.status === 'in_transit')
    .sort((a, b) => (a.eta || '9999').localeCompare(b.eta || '9999'));
  if (!lots.length) return emptyState('truck', 'Aucun lot en transit', 'Les lots apparaissent ici dès que l\'entrepôt de Chine déclare leur départ.');
  const today = startOfToday();
  return '<h2 class="section-title">Lots en route (' + lots.length + ')</h2>' +
    '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Référence</th><th>Type</th><th>Mode</th><th>N° transporteur</th>' +
    '<th class="t-right">Colis à pointer</th><th>Parti le</th><th>Arrivée estimée</th></tr></thead><tbody>' +
    lots.map((s) => {
      const late = s.eta && new Date(s.eta) < today;
      return '<tr class="row-link" tabindex="0" data-open-lot="' + s.id + '"><td class="t-strong">' + esc(s.reference) + '</td>' +
        '<td>' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + '</td><td>' + esc(modeLabel(s.mode)) + '</td>' +
        '<td class="t-mono">' + esc(s.carrier_ref || '—') + '</td>' +
        '<td class="t-right t-strong">' + lotPackages(s.id).filter((p) => p.status === 'in_transit').length + '</td>' +
        '<td>' + (s.departed_at ? formatDate(s.departed_at) : '—') + '</td>' +
        '<td>' + (s.eta ? formatDate(s.eta) : '—') + (late ? ' <span class="tag tag--late">En retard</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function arrivalResultsHtml() {
  const q = ui.arrQuery.trim();
  if (!q) return lotsInTransitHtml();
  const found = searchPackages(q);
  if (!found.length) {
    return emptyState('search', 'Aucun colis trouvé pour « ' + q + ' »',
      'Ce colis n\'est pas (ou plus) en route vers Cotonou : il est peut-être encore en Chine, ou déjà livré.');
  }
  return '<h2 class="section-title">' + found.length + ' résultat' + (found.length > 1 ? 's' : '') + '</h2>' +
    '<div class="pkg-list">' + found.slice(0, 30).map(arrivalCard).join('') + '</div>';
}

function arrivalKpisHtml() {
  return '<div class="grid grid--4 recv-kpis">' +
    kpi('truck', 'En route', transitList().length, 'accent') +
    kpi('clock', 'À contrôler', arrivedList().length, 'warn') +
    kpi('checkCircle', 'Disponibles à l\'agence', availableList().length, 'success') +
    kpi('check', 'Livrés aujourd\'hui', state.deliveredToday) + '</div>';
}

async function renderArrivals() {
  await loadAll();
  const canScan = canScanBarcodes();
  return pageHead('Arrivages', 'Pointez les colis à leur arrivée à Cotonou : par scan, par saisie, ou lot par lot.') +
    '<section class="scan-hero"><label class="scan-hero__label" for="arr-q">Pointer l\'arrivée d\'un colis (n° de suivi ou référence)</label>' +
    '<form class="scan-hero__form" id="arr-form" autocomplete="off">' +
      '<div class="input-group">' + icon('search', 20) +
        '<input class="input" id="arr-q" type="search" inputmode="text" autocapitalize="characters" spellcheck="false" ' +
        'placeholder="Scannez ou saisissez le numéro…" value="' + esc(ui.arrQuery) + '"></div>' +
      '<button class="btn btn--accent" type="submit">' + icon('check', 18) + ' Pointer</button>' +
      (canScan ? '<button class="btn btn--ghost" type="button" id="arr-scan">' + icon('scan', 18) + ' Scanner</button>' : '') +
    '</form><p class="scan-hero__hint">Avec une douchette, chaque scan pointe le colis aussitôt (touche Entrée).</p></section>' +
    '<div id="arr-kpis">' + arrivalKpisHtml() + '</div>' +
    '<div id="arr-results">' + arrivalResultsHtml() + '</div>';
}

/** Marque des colis « arrivés à Cotonou » */
async function pointArrival(ids) {
  const { data, error } = await supabase.from('packages').update({ status: 'arrived_benin' })
    .in('id', ids).select('id, reference, supplier_tracking, client_id');
  if (error) { toast(friendlyError(error), 'error', 6000); return null; }
  return data;
}

/** Met à jour KPI + résultats sans toucher au champ de saisie */
async function refreshArrivals() {
  await loadAll().catch(() => {});
  const kpis = $('#arr-kpis');
  const results = $('#arr-results');
  if (kpis) kpis.innerHTML = arrivalKpisHtml();
  if (results) results.innerHTML = arrivalResultsHtml();
}

function mountArrivals(view) {
  const input = $('#arr-q', view);
  const redraw = () => { $('#arr-results', view).innerHTML = arrivalResultsHtml(); };

  /** Un code (douchette, scan, Entrée) : un seul résultat en transit -> pointé aussitôt */
  const handleCode = async (code) => {
    ui.arrQuery = code;
    redraw();
    const found = searchPackages(code);
    if (!found.length) return toast('Aucun colis trouvé pour ' + code, 'error', 5000);
    if (found.length > 1) return;                                   // plusieurs : l'employé choisit dans la liste
    const p = found[0];
    if (p.status !== 'in_transit') return toast('Colis ' + p.supplier_tracking + ' : déjà « ' + statusLabel(p.status) + ' ».', 'info', 5000);
    const done = await pointArrival([p.id]);
    if (!done) return;
    toast('✔ Arrivé : ' + p.supplier_tracking + ' · ' + clientName(p.client_id), 'success', 4000);
    ui.arrQuery = '';
    input.value = '';
    await refreshArrivals();
    input.focus();
  };

  input.addEventListener('input', debounce(() => { ui.arrQuery = input.value; redraw(); }, 150));
  $('#arr-form', view).addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) handleCode(input.value); });
  $('#arr-scan', view)?.addEventListener('click', () => openScanner((code) => { input.value = code; handleCode(code); }));

  on(view, 'click', '[data-point]', async (el) => {
    const p = state.packages.find((x) => x.id === el.dataset.point);
    if (!p) return;
    const done = await pointArrival([p.id]);
    if (!done) return;
    toast('✔ Arrivé : ' + p.supplier_tracking + ' · ' + clientName(p.client_id), 'success');
    await refreshArrivals();
  });
  on(view, 'click', '[data-open-pkg]', (el) => openControlModal(el.dataset.openPkg));
  on(view, 'click', '[data-open-lot]', (el) => openLotModal(el.dataset.openLot));
  on(view, 'keydown', '[data-open-lot]', (el, e) => { if (e.key === 'Enter') openLotModal(el.dataset.openLot); });
  if (window.matchMedia('(pointer: fine)').matches) input.focus();   // poste fixe : prêt pour la douchette
}

/** Fiche d'un lot en transit : pointage colis par colis, ou clôture de l'arrivage */
function openLotModal(id) {
  const s = shipmentById(id);
  if (!s) return;
  const inLot = lotPackages(id);
  const waiting = inLot.filter((p) => p.status === 'in_transit');
  const open = s.status === 'in_transit';

  openModal(s.reference,
    '<div class="recv-head__row"><span class="badge badge--' + s.status + '">' + esc(SHIPMENT_STATUS_LABELS[s.status]) + '</span>' +
      '<span class="muted">' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + ' · ' + esc(modeLabel(s.mode)) + (s.carrier_ref ? ' · ' + esc(s.carrier_ref) : '') + '</span></div>' +
    '<div class="lot-totals"><div><strong>' + inLot.length + '</strong><small>Colis dans le lot</small></div>' +
      '<div><strong>' + (inLot.length - waiting.length) + '</strong><small>Pointés</small></div>' +
      '<div><strong>' + waiting.length + '</strong><small>Non pointés</small></div></div>' +
    (inLot.length
      ? '<div class="table-wrap"><table class="table data-table"><tbody>' + inLot.map((p) =>
          '<tr><td class="t-mono t-strong">' + esc(p.supplier_tracking) + '<span class="t-sub">' + esc(clientName(p.client_id)) + '</span></td>' +
          '<td>' + esc(measureText(p)) + '</td>' +
          '<td class="t-right">' + (p.status === 'in_transit'
            ? '<button type="button" class="btn btn--primary btn--sm" data-lot-point="' + p.id + '">Pointer</button>'
            : '<span class="arrival-state arrival-state--ok">' + icon('check', 14) + ' Arrivé</span>') + '</td></tr>').join('') + '</tbody></table></div>'
      : '<p class="muted">Aucun colis actif dans ce lot.</p>') +
    '<div class="modal__actions" style="justify-content:space-between"><button type="button" class="btn btn--ghost" id="lot-close">Fermer</button>' +
      (open ? '<button type="button" class="btn btn--accent" id="lot-finish">' + icon('checkCircle', 18) + ' Clôturer l\'arrivage</button>' : '<span></span>') + '</div>',
    { kind: 'lot', id });

  $('#lot-close').addEventListener('click', closeModal);
  const reopen = async () => { await router.refresh({ keepScroll: true }); openLotModal(id); };

  on($('#modal-body'), 'click', '[data-lot-point]', async (el) => {
    el.disabled = true;
    const done = await pointArrival([el.dataset.lotPoint]);
    if (done) reopen(); else el.disabled = false;
  });

  $('#lot-finish')?.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Clôturer l\'arrivage ?',
      message: waiting.length
        ? waiting.length + ' colis ne sont pas encore pointés : ils seront aussi marqués « arrivés ». Clôturez seulement si tout le lot est bien là.'
        : 'Tous les colis sont pointés. Le lot ' + s.reference + ' passera « arrivé à Cotonou ».',
      confirmLabel: 'Clôturer', danger: waiting.length > 0,
    });
    if (!ok) return;
    const { error } = await supabase.from('shipments').update({ status: 'arrived' }).eq('id', id);    // les colis suivent automatiquement
    if (error) return toast(friendlyError(error), 'error', 6000);
    closeModal();
    toast('Lot ' + s.reference + ' arrivé : colis à contrôler dans « À l\'agence »', 'success', 5000);
    router.refresh({ keepScroll: true });
  });
}


/* =====================================================================
 * 5. SECTION : À L'AGENCE
 *    « À contrôler » : colis arrivés, à vérifier puis mettre à disposition.
 *    « Disponibles » : colis prêts à être retirés par le client.
 * ===================================================================== */

function agencyList() {
  const q = norm(ui.agencyQuery);
  const base = ui.agencyTab === 'control' ? arrivedList() : availableList();
  return base.filter((p) => !q || norm(p.supplier_tracking).includes(q) || norm(p.reference).includes(q) || norm(clientName(p.client_id)).includes(q));
}

function agencyTableHtml() {
  const list = agencyList();
  const control = ui.agencyTab === 'control';
  if (!list.length) {
    return emptyState(control ? 'check' : 'package',
      control ? 'Aucun colis à contrôler' : 'Aucun colis disponible',
      control ? 'Les colis arrivés de Chine apparaissent ici pour contrôle.' : 'Les colis mis à disposition apparaissent ici en attendant le retrait par le client.');
  }
  const allChecked = list.every((p) => ui.selected.has(p.id));
  return '<p class="result-count">' + list.length + ' colis</p><div class="table-wrap"><table class="table data-table"><thead><tr>' +
    (control ? '<th class="t-check"><input class="check" type="checkbox" id="sel-all" aria-label="Tout sélectionner"' + (allChecked ? ' checked' : '') + '></th>' : '') +
    '<th>N° de suivi</th><th>Client</th><th>Mode</th><th>Poids / Volume</th>' +
    (control ? '<th>Photos</th><th>Arrivé le</th>' : '<th class="t-right">Montant</th><th>Paiement</th><th>Disponible depuis</th>') +
    '</tr></thead><tbody>' + list.map((p) =>
      '<tr class="row-link' + (ui.selected.has(p.id) ? ' is-selected' : '') + '" tabindex="0" data-open-pkg="' + p.id + '">' +
      (control ? '<td class="t-check"><input class="check" type="checkbox" data-sel="' + p.id + '" aria-label="Sélectionner ' + esc(p.reference) + '"' + (ui.selected.has(p.id) ? ' checked' : '') + '></td>' : '') +
      '<td class="t-mono t-strong">' + esc(p.supplier_tracking) + '<span class="t-sub">' + esc(p.reference) + '</span></td>' +
      '<td>' + esc(clientName(p.client_id)) + '</td><td>' + esc(modeLabel(p.shipping_mode)) + '</td><td>' + esc(measureText(p)) + '</td>' +
      (control
        ? '<td>' + (p.photos?.length ? '<span class="tag tag--info">' + icon('camera', 13) + ' ' + p.photos.length + '</span>' : '—') + '</td><td>' + formatDate(p.arrived_at, true) + '</td>'
        : '<td class="t-right t-strong">' + (p.amount_due != null ? formatMoney(p.amount_due) : '—') + '</td>' +
          '<td><span class="badge badge--' + p.payment_status + '">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span></td><td>' + formatDate(p.available_at, true) + '</td>') +
      '</tr>').join('') + '</tbody></table></div>';
}

function bulkBarHtml() {
  const n = ui.selected.size;
  if (!n || ui.agencyTab !== 'control') return '';
  return '<div class="bulk-bar"><span><strong>' + n + '</strong> colis sélectionné' + (n > 1 ? 's' : '') + '</span>' +
    '<span class="actions"><button type="button" class="btn btn--ghost btn--sm" id="bulk-clear">Désélectionner</button>' +
    '<button type="button" class="btn btn--accent btn--sm" id="bulk-available">' + icon('checkCircle', 16) + ' Mettre à disposition</button></span></div>';
}

async function renderAgency() {
  await loadAll();
  const ids = new Set(arrivedList().map((p) => p.id));
  ui.selected.forEach((id) => { if (!ids.has(id)) ui.selected.delete(id); });

  const tabs = { control: ['À contrôler', arrivedList().length], ready: ['Disponibles', availableList().length] };
  return pageHead('À l\'agence', 'Contrôlez les colis arrivés, puis mettez-les à disposition : le client est informé en temps réel.') +
    '<div class="chips" id="agency-tabs" style="margin-bottom:14px">' + Object.entries(tabs).map(([k, [label, n]]) =>
      '<button class="chip" type="button" data-tab="' + k + '" aria-pressed="' + (ui.agencyTab === k) + '">' + label + '<span class="chip__count">' + n + '</span></button>').join('') + '</div>' +
    '<div class="filters filters--tight"><div class="input-group">' + icon('search', 18) +
      '<input class="input" id="agency-q" type="search" placeholder="N° de suivi, référence, client…" value="' + esc(ui.agencyQuery) + '" aria-label="Rechercher"></div></div>' +
    '<div id="agency-table">' + agencyTableHtml() + '</div><div id="bulk-slot">' + bulkBarHtml() + '</div>';
}

function mountAgency(view) {
  const redraw = () => { $('#agency-table', view).innerHTML = agencyTableHtml(); $('#bulk-slot', view).innerHTML = bulkBarHtml(); };

  on(view, 'click', '[data-tab]', (el) => { ui.agencyTab = el.dataset.tab; ui.selected.clear(); router.refresh({ keepScroll: true }); });
  $('#agency-q', view).addEventListener('input', debounce((e) => { ui.agencyQuery = e.target.value; redraw(); }, 200));

  on(view, 'change', '[data-sel]', (el) => { el.checked ? ui.selected.add(el.dataset.sel) : ui.selected.delete(el.dataset.sel); redraw(); });
  on(view, 'change', '#sel-all', (el) => { agencyList().forEach((p) => (el.checked ? ui.selected.add(p.id) : ui.selected.delete(p.id))); redraw(); });
  on(view, 'click', '[data-open-pkg]', (el, e) => { if (!e.target.closest('input')) openControlModal(el.dataset.openPkg); });
  on(view, 'keydown', '[data-open-pkg]', (el, e) => { if (e.key === 'Enter' && !e.target.closest('input')) openControlModal(el.dataset.openPkg); });
  on(view, 'click', '#bulk-clear', () => { ui.selected.clear(); redraw(); });

  on(view, 'click', '#bulk-available', async () => {
    const ids = [...ui.selected];
    const ok = await askConfirm({
      title: 'Mettre à disposition ?',
      message: ids.length + ' colis passeront « disponibles à l\'agence » et les clients seront informés.',
      confirmLabel: 'Mettre à disposition',
    });
    if (!ok) return;
    const { error } = await supabase.from('packages').update({ status: 'available_agency' }).in('id', ids);
    if (error) return toast(friendlyError(error), 'error', 6000);
    ui.selected.clear();
    toast(ids.length + ' colis disponible' + (ids.length > 1 ? 's' : '') + ' à l\'agence', 'success');
    router.refresh({ keepScroll: true });
  });
}

/** Fiche de contrôle : photos prises en Chine, observation, mise à disposition */
async function openControlModal(id) {
  const p = pkgById(id);
  if (!p) return;
  const lot = shipmentById(p.shipment_id);
  const client = userById(p.client_id);
  const control = p.status === 'arrived_benin';
  const editable = ['arrived_benin', 'available_agency'].includes(p.status);

  openModal(control ? 'Contrôle à l\'arrivée' : p.reference,
    '<div class="recv-head"><div class="recv-head__row"><span class="recv-head__track">' + esc(p.supplier_tracking) + '</span>' + statusBadge(p.status) + '</div>' +
      '<div class="callout">' + icon('user', 18) + '<span><strong>' + esc(clientName(p.client_id)) + '</strong>' +
        (client?.phone ? ' · ' + esc(client.phone) : '') + '<br>' + esc(p.reference) + ' · ' + esc(modeLabel(p.shipping_mode)) +
        (p.description ? '<br>« ' + esc(p.description) + ' »' : '') + '</span></div></div>' +
    '<dl class="kv"><div><dt>Poids</dt><dd>' + formatWeight(p.weight_kg) + '</dd></div><div><dt>Volume</dt><dd>' + formatVolume(p.volume_m3) + '</dd></div>' +
      '<div><dt>Lot</dt><dd>' + esc(lot?.reference || '—') + '</dd></div>' +
      '<div><dt>Montant à payer</dt><dd>' + (p.amount_due != null ? formatMoney(p.amount_due) : 'À définir par l\'administrateur') + '</dd></div>' +
      '<div><dt>Paiement</dt><dd><span class="badge badge--' + p.payment_status + '">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span>' +
        (p.payment_method ? ' ' + esc(PAYMENT_METHOD_LABELS[p.payment_method]) : '') + '</dd></div></dl>' +
    '<div id="ctl-photos"></div>' +
    (editable
      ? '<form class="form" id="ctl-form"><label class="field"><span class="field__label">Observation à l\'arrivée (visible par le client)</span>' +
          '<textarea class="textarea" name="note" maxlength="300" style="min-height:80px" placeholder="Ex : carton légèrement abîmé, contenu intact">' + esc(p.delivery_note || '') + '</textarea></label>' +
        '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="ctl-cancel">Fermer</button>' +
          '<button type="submit" class="btn btn--ghost" data-act="save">Enregistrer la note</button>' +
          (control
            ? '<button type="submit" class="btn btn--accent" data-act="available">' + icon('checkCircle', 18) + ' Mettre à disposition</button>'
            : '<a class="btn btn--primary" href="#/delivery?q=' + encodeURIComponent(p.supplier_tracking) + '" id="ctl-deliver">Remettre au client</a>') + '</div></form>'
      : '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="ctl-cancel">Fermer</button></div>'),
    { kind: 'control', id });

  $('#ctl-cancel')?.addEventListener('click', closeModal);
  $('#ctl-deliver')?.addEventListener('click', closeModal);

  $('#ctl-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const act = e.submitter?.dataset.act || 'save';
    const note = String(new FormData(e.target).get('note')).trim() || null;
    const payload = act === 'available' ? { status: 'available_agency', delivery_note: note } : { delivery_note: note };
    const btn = e.submitter;
    setBusy(btn, true, 'Enregistrement…');
    const { error } = await supabase.from('packages').update(payload).eq('id', id);
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error', 6000);
    closeModal();
    toast(act === 'available' ? 'Colis disponible : le client est informé' : 'Note enregistrée', 'success');
    router.refresh({ keepScroll: true });
  });

  // Photos prises à l'entrepôt en Chine : l'agence compare l'état à l'arrivée
  if (p.photos?.length) {
    const { data } = await supabase.storage.from(APP.photosBucket).createSignedUrls(p.photos, APP.signedUrlTtl);
    const urls = (data || []).filter((d) => d.signedUrl).map((d) => d.signedUrl);
    const box = $('#ctl-photos');
    if (box && urls.length) box.innerHTML = '<p class="detail-section-title">Photos prises à l\'entrepôt en Chine</p><div class="photo-grid">' +
      urls.map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="Photo du colis ' + esc(p.reference) + '" loading="lazy"></a>').join('') + '</div>';
  }
}


/* =====================================================================
 * 6. SECTION : REMISE AU CLIENT
 *    Recherche par nom, téléphone, email ou n° de colis. Un client peut
 *    retirer plusieurs colis d'un coup. Les colis sont marqués livrés
 *    seulement si le paiement est encaissé et le receveur identifié
 *    (règle garantie par la base de données).
 * ===================================================================== */

function groupAvailable() {
  const map = new Map();
  availableList().forEach((p) => {
    if (!map.has(p.client_id)) map.set(p.client_id, []);
    map.get(p.client_id).push(p);
  });
  return [...map.entries()].map(([cid, pkgs]) => ({ cid, client: userById(cid), pkgs }))
    .sort((a, b) => Math.min(...a.pkgs.map((p) => +new Date(p.available_at || 0))) - Math.min(...b.pkgs.map((p) => +new Date(p.available_at || 0))));
}

function matchGroups(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return groupAvailable();
  const code = norm(q);
  const digits = q.replace(/\D/g, '');
  return groupAvailable().filter((g) =>
    (g.client?.full_name || '').toLowerCase().includes(needle) ||
    (g.client?.email || '').toLowerCase().includes(needle) ||
    (digits.length >= 4 && (g.client?.phone || '').replace(/\D/g, '').includes(digits)) ||
    g.pkgs.some((p) => norm(p.supplier_tracking).includes(code) || norm(p.reference).includes(code)));
}

function deliveryResultsHtml() {
  const q = ui.delQuery.trim();
  const groups = matchGroups(q);

  if (!groups.length) {
    // Le colis existe peut-être mais n'a pas encore été contrôlé / mis à disposition
    const code = norm(q);
    const pending = q ? arrivedList().filter((p) => norm(p.supplier_tracking).includes(code) || norm(p.reference).includes(code) ||
      clientName(p.client_id).toLowerCase().includes(q.toLowerCase())) : [];
    return (pending.length
      ? '<div class="alert alert--warn" style="margin-bottom:14px">' + icon('alert') + '<span><strong>' + pending.length + ' colis</strong> correspondant à cette recherche ' +
        (pending.length > 1 ? 'sont arrivés mais n\'ont pas encore été mis' : 'est arrivé mais n\'a pas encore été mis') + ' à disposition.</span>' +
        '<a class="btn btn--accent btn--sm" href="#/agency">Contrôler</a></div>'
      : '') +
      emptyState(q ? 'search' : 'checkCircle', q ? 'Aucun retrait pour « ' + q + ' »' : 'Aucun colis à remettre',
        q ? 'Aucun colis disponible ne correspond à cette recherche.' : 'Les colis mis à disposition apparaissent ici, regroupés par client.');
  }

  return '<h2 class="section-title">' + groups.length + ' client' + (groups.length > 1 ? 's' : '') + ' · ' + groups.reduce((n, g) => n + g.pkgs.length, 0) + ' colis à remettre</h2>' +
    '<div class="client-grid">' + groups.map((g) => {
      const due = sumAmount(g.pkgs.filter((p) => p.payment_status !== 'paid'));
      const name = g.client?.full_name || g.client?.email || 'Client inconnu';
      return '<button type="button" class="client-card" data-deliver="' + g.cid + '">' +
        '<span class="client-card__top"><span class="client-card__avatar">' + esc(initials(name)) + '</span>' +
        '<span class="client-card__who"><strong>' + esc(name) + '</strong><small>' + esc(g.client?.phone || g.client?.email || '') + '</small></span></span>' +
        '<span class="client-card__stats"><span>' + g.pkgs.length + ' colis disponible' + (g.pkgs.length > 1 ? 's' : '') + '</span>' +
        '<span class="client-card__due">' + (due > 0 ? formatMoney(due) : '<span class="tag tag--ok">Réglé</span>') + '</span></span>' +
        '<span class="client-card__cta">Remettre au client →</span></button>';
    }).join('') + '</div>';
}

async function renderDelivery(params) {
  if (params?.q !== undefined) ui.delQuery = params.q;            // lien depuis la fiche d'un colis
  await loadAll();
  const canScan = canScanBarcodes();
  return pageHead('Remise au client', 'Retrouvez le client (nom, téléphone, n° de colis), encaissez, puis validez la remise.') +
    '<section class="scan-hero"><label class="scan-hero__label" for="del-q">Client ou colis</label>' +
    '<form class="scan-hero__form" id="del-form" autocomplete="off">' +
      '<div class="input-group">' + icon('search', 20) +
        '<input class="input" id="del-q" type="search" placeholder="Nom, téléphone, email ou n° de colis…" value="' + esc(ui.delQuery) + '"></div>' +
      '<button class="btn btn--accent" type="submit">' + icon('search', 18) + ' Rechercher</button>' +
      (canScan ? '<button class="btn btn--ghost" type="button" id="del-scan">' + icon('scan', 18) + ' Scanner</button>' : '') +
    '</form><p class="scan-hero__hint">Scanner l\'étiquette d\'un colis ouvre directement le dossier de son client.</p></section>' +
    '<div id="del-results">' + deliveryResultsHtml() + '</div>';
}

function mountDelivery(view) {
  const input = $('#del-q', view);
  const redraw = () => { $('#del-results', view).innerHTML = deliveryResultsHtml(); };

  const search = (value, openIfSingle) => {
    ui.delQuery = value;
    redraw();
    const groups = matchGroups(value);
    if (openIfSingle && groups.length === 1 && value.trim()) openDeliveryModal(groups[0].cid);
  };

  input.addEventListener('input', debounce(() => { ui.delQuery = input.value; redraw(); }, 150));
  $('#del-form', view).addEventListener('submit', (e) => { e.preventDefault(); search(input.value, true); });
  $('#del-scan', view)?.addEventListener('click', () => openScanner((code) => { input.value = code; search(code, true); }));
  on(view, 'click', '[data-deliver]', (el) => openDeliveryModal(el.dataset.deliver));
}

function openDeliveryModal(clientId) {
  const client = userById(clientId);
  const pkgs = availableList().filter((p) => p.client_id === clientId);
  if (!pkgs.length) return toast('Aucun colis disponible pour ce client.', 'error');
  const name = client?.full_name || client?.email || 'Client';
  // Un colis non payé dont le montant n'est pas calculé ne peut pas être encaissé
  const blocked = (p) => p.payment_status !== 'paid' && p.amount_due == null;

  openModal('Remise au client',
    '<div class="callout">' + icon('user', 18) + '<span><strong>' + esc(name) + '</strong>' +
      (client?.phone ? ' · ' + esc(client.phone) : '') + (client?.email ? '<br>' + esc(client.email) : '') + '</span></div>' +
    '<form class="form" id="del-modal-form" novalidate>' +
      '<div><p class="detail-section-title">Colis à remettre</p><div class="lot-pick">' + pkgs.map((p) =>
        '<label class="' + (blocked(p) ? 'pick-row--blocked' : '') + '"><input class="check" type="checkbox" data-pick="' + p.id + '"' + (blocked(p) ? ' disabled' : ' checked') + '>' +
        '<span class="lot-pick__main"><strong>' + esc(p.supplier_tracking) + '</strong><small>' + esc(p.reference) + ' · ' + esc(modeLabel(p.shipping_mode)) + ' · ' + esc(measureText(p)) +
          (p.description ? ' · ' + esc(p.description) : '') + '</small></span>' +
        '<span class="pick-row__amount">' + (blocked(p) ? '<small class="muted">Montant à définir</small>' : formatMoney(p.amount_due)) +
          '<span class="badge badge--' + p.payment_status + '">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span></span></label>').join('') + '</div>' +
        (pkgs.some(blocked) ? '<p class="field__hint" style="margin-top:8px">Certains colis n\'ont pas de montant : demandez à l\'administrateur de le calculer avant la remise.</p>' : '') + '</div>' +

      '<div id="pay-panel"></div>' +

      '<div class="form-grid">' +
        '<label class="field span-2"><span class="field__label">Nom de la personne qui retire les colis *</span>' +
          '<input class="input" name="receiver" required maxlength="120" value="' + esc(name) + '" autocomplete="off"></label>' +
        '<label class="field span-2"><span class="field__label">Note (facultatif)</span>' +
          '<input class="input" name="note" maxlength="300" placeholder="Ex : pièce d\'identité vérifiée, retiré par le frère du client"></label>' +
      '</div>' +
      '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="del-cancel">Annuler</button>' +
        '<button type="submit" class="btn btn--accent">' + icon('checkCircle', 18) + ' Valider la remise</button></div></form>',
    { kind: 'delivery', id: clientId });

  const form = $('#del-modal-form');
  $('#del-cancel').addEventListener('click', closeModal);

  const picked = () => [...form.querySelectorAll('[data-pick]:checked')].map((el) => pkgs.find((p) => p.id === el.dataset.pick)).filter(Boolean);

  /** Panneau de paiement : recalculé à chaque case cochée */
  const refreshPay = () => {
    const sel = picked();
    const toCollect = sumAmount(sel.filter((p) => p.payment_status !== 'paid'));
    const already = sumAmount(sel.filter((p) => p.payment_status === 'paid'));
    const previous = form.elements.method?.value || 'on_delivery';
    const confirmed = form.elements.collected?.checked || false;

    $('#pay-panel').innerHTML = toCollect > 0
      ? '<div class="pay-panel"><div class="pay-panel__total"><span><span class="pay-panel__label">À encaisser</span><br><span class="pay-panel__amount">' + formatMoney(toCollect) + '</span></span>' +
          (already > 0 ? '<span class="pay-panel__sub">+ ' + formatMoney(already) + ' déjà réglé</span>' : '') + '</div>' +
        '<label class="field"><span class="field__label">Mode de paiement</span><select class="select" name="method">' +
          Object.entries(PAYMENT_METHOD_LABELS).map(([k, l]) => '<option value="' + k + '"' + (k === previous ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>' +
        '<label class="switch"><input type="checkbox" name="collected"' + (confirmed ? ' checked' : '') + '><span class="switch__ui"></span><span>J\'ai encaissé ' + formatMoney(toCollect) + '</span></label></div>'
      : '<div class="pay-panel pay-panel--settled"><div class="pay-panel__total"><span><span class="pay-panel__label">Paiement</span><br>' +
        '<strong>' + (sel.length ? 'Tout est déjà réglé : rien à encaisser.' : 'Sélectionnez au moins un colis.') + '</strong></span></div></div>';
  };
  form.addEventListener('change', (e) => { if (e.target.matches('[data-pick]')) refreshPay(); });
  refreshPay();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = picked();
    const fd = new FormData(form);
    const receiver = String(fd.get('receiver')).trim();
    const note = String(fd.get('note')).trim() || null;
    const unpaid = sel.filter((p) => p.payment_status !== 'paid');

    if (!sel.length) return toast('Cochez au moins un colis à remettre.', 'error');
    if (!receiver) return toast('Indiquez le nom de la personne qui retire les colis.', 'error');
    if (unpaid.length && !form.elements.collected?.checked) return toast('Confirmez l\'encaissement avant de valider.', 'error');

    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Validation…');
    const delivered = [];
    let failure = null;

    // Deux groupes : à encaisser (paiement validé en même temps) et déjà payés
    const batches = [
      [unpaid, { status: 'delivered', payment_status: 'paid', payment_method: String(fd.get('method') || 'on_delivery'), delivered_to: receiver, delivery_note: note }],
      [sel.filter((p) => p.payment_status === 'paid'), { status: 'delivered', delivered_to: receiver, delivery_note: note }],
    ];
    for (const [list, payload] of batches) {
      if (!list.length) continue;
      const { data, error } = await supabase.from('packages').update(payload).in('id', list.map((p) => p.id)).select();
      if (error) { failure = error; break; }
      delivered.push(...data);
    }
    setBusy(btn, false);

    if (failure) {
      toast((delivered.length ? delivered.length + ' colis livrés, mais une erreur est survenue : ' : '') + friendlyError(failure), 'error', 8000);
      return router.refresh({ keepScroll: true });
    }

    await router.refresh({ keepScroll: true });
    openReceiptModal({ client, pkgs: delivered, receiver, note });
  });
}

/** Confirmation de remise + impression du reçu */
function openReceiptModal(receipt) {
  openModal('Remise enregistrée',
    '<div class="alert alert--success">' + icon('checkCircle') + '<span><strong>' + receipt.pkgs.length + ' colis remis</strong> à ' + esc(receipt.receiver) +
      ' · total encaissé : ' + formatMoney(sumAmount(receipt.pkgs)) + '</span></div>' +
    '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="rcpt-close">Fermer</button>' +
      '<button type="button" class="btn btn--primary" id="rcpt-print">' + icon('printer', 18) + ' Imprimer le reçu</button></div>', { kind: 'receipt' });
  $('#rcpt-close').addEventListener('click', closeModal);
  $('#rcpt-print').addEventListener('click', () => printReceipt(receipt));
}

/** Reçu imprimable (ou enregistrable en PDF) dans un nouvel onglet */
function printReceipt({ client, pkgs, receiver, note }) {
  const w = window.open('', '_blank');
  if (!w) return toast('Autorisez les pop-ups pour afficher le reçu.', 'error');
  const when = pkgs[0]?.delivered_at || new Date().toISOString();
  const rows = pkgs.map((p) => '<tr><td>' + esc(p.supplier_tracking) + '<br><span class="muted">' + esc(p.reference) + (p.description ? ' · ' + esc(p.description) : '') + '</span></td>' +
    '<td>' + esc(modeLabel(p.shipping_mode)) + '</td><td style="text-align:right">' + (p.amount_due != null ? formatMoney(p.amount_due) : '—') + '</td></tr>').join('');

  w.document.open();
  w.document.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Reçu de remise</title>' +
    '<style>body{font-family:system-ui,Arial,sans-serif;color:#0f172a;max-width:720px;margin:40px auto;padding:0 20px}h1{margin:0}' +
    'table{width:100%;border-collapse:collapse;margin:22px 0}td,th{padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}' +
    '.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0b1f4b;padding-bottom:16px}.muted{color:#64748b;font-size:.9em}' +
    '.total td{font-size:1.15rem;font-weight:800;border-bottom:0}.sign{display:flex;gap:40px;margin-top:60px}.sign div{flex:1;border-top:1px solid #0f172a;padding-top:6px;font-size:.9em}' +
    '@media print{button{display:none}}</style></head><body>' +
    '<div class="head"><div><h1>' + esc(state.company || APP.name) + '</h1><p class="muted">Agence de Cotonou</p></div>' +
    '<div style="text-align:right"><h2 style="margin:0">REÇU DE REMISE</h2><p class="muted">' + formatDate(when, true) + '</p></div></div>' +
    '<p><strong>Client :</strong> ' + esc(client?.full_name || client?.email || '—') + (client?.phone ? ' · ' + esc(client.phone) : '') + '<br>' +
    '<strong>Retiré par :</strong> ' + esc(receiver) + (note ? '<br><span class="muted">' + esc(note) + '</span>' : '') + '</p>' +
    '<table><thead><tr><th>Colis</th><th>Mode</th><th style="text-align:right">Fret</th></tr></thead><tbody>' + rows + '</tbody>' +
    '<tfoot><tr class="total"><td colspan="2">Total réglé</td><td style="text-align:right">' + formatMoney(sumAmount(pkgs)) + '</td></tr></tfoot></table>' +
    '<div class="sign"><div>Signature du receveur</div><div>Cachet de l\'agence</div></div>' +
    '<button onclick="window.print()" style="margin-top:30px;padding:10px 18px;font-size:1rem">Imprimer / Enregistrer en PDF</button></body></html>');
  w.document.close();
}


/* =====================================================================
 * 7. SECTION : LIVRÉS (historique + réimpression des reçus)
 * ===================================================================== */
function historyTableHtml() {
  const needle = norm(ui.histQuery);
  const text = ui.histQuery.trim().toLowerCase();
  const list = state.delivered.filter((p) => !needle ||
    norm(p.supplier_tracking).includes(needle) || norm(p.reference).includes(needle) ||
    clientName(p.client_id).toLowerCase().includes(text) || (p.delivered_to || '').toLowerCase().includes(text));

  if (!list.length) {
    return state.delivered.length ? emptyState('search', 'Aucun résultat', 'Aucune livraison ne correspond à cette recherche.')
      : emptyState('file', 'Aucune livraison', 'Les colis remis aux clients apparaissent ici.');
  }
  return '<p class="result-count">' + list.length + ' livraison' + (list.length > 1 ? 's' : '') + ' (300 dernières)</p><div class="table-wrap"><table class="table data-table"><thead><tr>' +
    '<th>N° de suivi</th><th>Client</th><th>Retiré par</th><th class="t-right">Montant</th><th>Paiement</th><th>Livré le</th></tr></thead><tbody>' +
    list.map((p) => '<tr class="row-link" tabindex="0" data-open-done="' + p.id + '"><td class="t-mono t-strong">' + esc(p.supplier_tracking) + '<span class="t-sub">' + esc(p.reference) + '</span></td>' +
      '<td>' + esc(clientName(p.client_id)) + '</td><td>' + esc(p.delivered_to || '—') + '</td>' +
      '<td class="t-right t-strong">' + (p.amount_due != null ? formatMoney(p.amount_due) : '—') + '</td>' +
      '<td>' + (p.payment_method ? esc(PAYMENT_METHOD_LABELS[p.payment_method]) : '—') + '</td><td>' + formatDate(p.delivered_at, true) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

async function renderHistory() {
  await Promise.all([loadAll(), loadDelivered()]);
  return pageHead('Colis livrés', 'Historique des remises. Cliquez sur une ligne pour réimprimer le reçu.') +
    '<div class="filters filters--tight"><div class="input-group">' + icon('search', 18) +
    '<input class="input" id="hist-q" type="search" placeholder="N° de suivi, client, receveur…" value="' + esc(ui.histQuery) + '" aria-label="Rechercher"></div></div>' +
    '<div id="hist-table">' + historyTableHtml() + '</div>';
}

function mountHistory(view) {
  $('#hist-q', view).addEventListener('input', debounce((e) => { ui.histQuery = e.target.value; $('#hist-table', view).innerHTML = historyTableHtml(); }, 200));
  const open = (id) => {
    const p = state.delivered.find((x) => x.id === id);
    if (!p) return;
    openModal(p.reference,
      '<dl class="kv"><div><dt>N° de suivi</dt><dd>' + esc(p.supplier_tracking) + '</dd></div><div><dt>Client</dt><dd>' + esc(clientName(p.client_id)) + '</dd></div>' +
      '<div><dt>Retiré par</dt><dd>' + esc(p.delivered_to || '—') + '</dd></div><div><dt>Livré le</dt><dd>' + formatDate(p.delivered_at, true) + '</dd></div>' +
      '<div><dt>Montant</dt><dd>' + (p.amount_due != null ? formatMoney(p.amount_due) : '—') + '</dd></div>' +
      '<div><dt>Paiement</dt><dd>' + (p.payment_method ? esc(PAYMENT_METHOD_LABELS[p.payment_method]) : '—') + '</dd></div>' +
      (p.delivery_note ? '<div><dt>Note</dt><dd>' + esc(p.delivery_note) + '</dd></div>' : '') + '</dl>' +
      '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="done-close">Fermer</button>' +
      '<button type="button" class="btn btn--primary" id="done-print">' + icon('printer', 18) + ' Réimprimer le reçu</button></div>', { kind: 'done' });
    $('#done-close').addEventListener('click', closeModal);
    $('#done-print').addEventListener('click', () => printReceipt({ client: userById(p.client_id), pkgs: [p], receiver: p.delivered_to || '—', note: p.delivery_note }));
  };
  on(view, 'click', '[data-open-done]', (el) => open(el.dataset.openDone));
  on(view, 'keydown', '[data-open-done]', (el, e) => { if (e.key === 'Enter') open(el.dataset.openDone); });
}


/* =====================================================================
 * 8. TEMPS RÉEL & DÉMARRAGE
 * ===================================================================== */

/** Un colis ou un lot a changé (entrepôt Chine, client, autre employé...) */
const onLiveChange = debounce(async () => {
  if ($('#modal').open) return;                                   // jamais sous un formulaire ouvert
  if (document.activeElement?.matches('input, textarea, select')) {
    // L'employé est en train de saisir : on met à jour les données sans toucher au champ
    await loadAll().catch(() => {});
    const id = router.route.id;
    if (id === 'arrivals') { $('#arr-kpis').innerHTML = arrivalKpisHtml(); $('#arr-results').innerHTML = arrivalResultsHtml(); }
    if (id === 'delivery') $('#del-results').innerHTML = deliveryResultsHtml();
    return;
  }
  router.refresh({ keepScroll: true });
}, 800);

async function bootBenin(profile) {
  state.profile = profile;

  renderNav(NAV_GROUPS, SECTIONS);
  bindDrawer();
  bindModalBasics();

  supabase.from('app_settings').select('value').eq('key', 'company_name').maybeSingle().then(({ data }) => {
    if (!data?.value) return;
    state.company = data.value;
    $$('.js-company').forEach((el) => (el.textContent = data.value));
    document.title = 'Agence Bénin — ' + data.value;
  });

  router = createRouter({
    sections: SECTIONS,
    defaultId: 'arrivals',
    onChange: (id) => highlightNav(id),
  });

  ['packages', 'shipments'].forEach((t) => subscribeToTable(t, onLiveChange));

  if (!location.hash) history.replaceState(null, '', '#/arrivals');
  await router.navigate();
}

initPage({ allowedRoles: [ROLES.BENIN, ROLES.ADMIN], onReady: bootBenin });
