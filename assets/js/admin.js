/* =====================================================================
 *  admin.js  |  Portail ADMINISTRATEUR
 * =====================================================================
 *  Accès : rôle « admin » uniquement (garde initPage + RLS Supabase).
 *  Les adresses Gmail autorisées vivent dans la table authorized_staff
 *  et se gèrent ici (section « Équipe ») ou par SQL.
 *
 *  Plan du fichier :
 *   1. Imports, état, utilitaires    7. Finances (+ export CSV)
 *   2. Chargement des données        8. Tarifs
 *   3. Navigation & routeur          9. Annonces
 *   4. Vue d'ensemble               10. Paramètres de l'entreprise
 *   5. Colis (liste + éditeur)      11. Équipe (liste blanche Gmail)
 *   6. Lots / conteneurs / vols     12. Clients, litiges, journal, démarrage
 * ===================================================================== */


/* =====================================================================
 * 1. IMPORTS, ÉTAT, UTILITAIRES
 * ===================================================================== */
import {
  supabase, initPage, subscribeToTable, fetchAll,
  escapeHtml as esc, friendlyError, formatMoney, formatDate, formatWeight, formatVolume,
  statusLabel, modeLabel, statusBadge, debounce, toast, icon, num,
  pageHead, emptyState, setBusy, openModal, closeModal, bindModalBasics, askConfirm,
  renderNav, highlightNav, setBadge, bindDrawer, createRouter, $, $$,
} from './plateforms.js';

import {
  ROLES, ROLE_LABELS, STATUS_ORDER, STATUS_LABELS, SHIPPING_MODES,
  PAYMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS, SHIPMENT_STATUS_LABELS,
  SHIPMENT_KIND_LABELS, DISPUTE_STATUS_LABELS,
} from './config.js';

/** Données chargées à la demande (l'admin veut toujours des chiffres frais) */
const state = {
  profile: null,
  packages: [],
  users: [],
  shipments: [],
  staff: [],           // liste blanche authorized_staff (section Équipe)
  announcements: [],   // annonces (section Annonces)
  disputes: [],        // litiges (section Litiges)
  settingsName: '',    // nom de l'entreprise (en-tête)
};

/** État des filtres, conservé quand on revient sur une section */
const ui = {
  pkg: { q: '', status: '', mode: '', pay: '', limit: 100 },
  clientQuery: '',
  disputeFilter: 'open',
  logEntity: '',
  logLimit: 100,
};

let router = null;   // créé au démarrage (section 12)

const userById = (id) => state.users.find((u) => u.id === id);
const userLabel = (id) => {
  const u = userById(id);
  return u ? (u.full_name || u.email) : '—';
};
const shipmentById = (id) => state.shipments.find((s) => s.id === id);

/** Délégation d'événements : on(view, 'click', '[data-x]', (el, event) => ...) */
function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(el, e);
  });
}

/** Valeur numérique d'un champ de formulaire (vide -> null) */
const numOrNull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : num(v));
const textOrNull = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim());

/** ISO <-> valeur d'un <input type="datetime-local"> */
const toLocalInput = (iso) =>
  iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

/** Export CSV compatible Excel (BOM, séparateur « ; », anti-injection de formules) */
function downloadCsv(filename, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/** Cartes d'indicateurs (mêmes styles que l'espace client) */
function kpi(iconName, label, value, href = '', tone = '') {
  const tag = href ? 'a' : 'div';
  return '<' + tag + ' class="kpi ' + (tone ? 'kpi--' + tone : '') + '"' + (href ? ' href="' + href + '"' : '') + '>' +
    '<span class="kpi__icon">' + icon(iconName, 22) + '</span>' +
    '<span><span class="kpi__value">' + value + '</span><br><span class="kpi__label">' + esc(label) + '</span></span></' + tag + '>';
}

/** Barre horizontale : bar('Libellé', 12, 40, 'accent') */
function bar(label, value, max, tone = '', display = value) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return '<div class="bar"><span class="bar__label">' + esc(label) + '</span>' +
    '<span class="bar__track"><span class="bar__fill ' + (tone ? 'bar__fill--' + tone : '') + '" style="width:' + pct + '%"></span></span>' +
    '<span class="bar__value">' + display + '</span></div>';
}

const sumAmount = (list) => list.reduce((s, p) => s + Number(p.amount_due || 0), 0);

/** Options <option> à partir d'un objet { valeur: libellé } */
const options = (map, selected = '', blank = '') =>
  (blank ? '<option value="">' + esc(blank) + '</option>' : '') +
  Object.entries(map).map(([v, l]) => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(l) + '</option>').join('');

const switchHtml = (name, checked, label, disabled = false) =>
  '<label class="switch"><input type="checkbox" name="' + name + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
  '<span class="switch__ui"></span><span>' + esc(label) + '</span></label>';


/* =====================================================================
 * 2. CHARGEMENT DES DONNÉES
 * ===================================================================== */
async function loadPackages() {
  state.packages = await fetchAll(() =>
    supabase.from('packages').select('*').order('created_at', { ascending: false }).order('id'));
}

async function loadUsers() {
  state.users = await fetchAll(() =>
    supabase.from('users').select('*').order('created_at', { ascending: false }).order('id'));
}

async function loadShipments() {
  const { data, error } = await supabase.from('shipments').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  state.shipments = data;
}

/** Charge plusieurs jeux de données en parallèle */
const load = (...fns) => Promise.all(fns.map((f) => f()));

/** Pastille « litiges à traiter » dans le menu */
async function refreshDisputeBadge() {
  const { count } = await supabase.from('disputes').select('id', { count: 'exact', head: true })
    .in('status', ['open', 'in_review']);
  setBadge('disputes', count || 0);
}


/* =====================================================================
 * 3. NAVIGATION
 * ===================================================================== */
const SECTIONS = {
  overview:      { label: 'Vue d\'ensemble', icon: 'home',      render: renderOverview },
  finance:       { label: 'Finances',        icon: 'chart',     render: renderFinance,       mount: mountFinance },
  packages:      { label: 'Colis',           icon: 'package',   render: renderPackages,      mount: mountPackages },
  shipments:     { label: 'Lots & conteneurs', icon: 'layers',  render: renderShipments,     mount: mountShipments },
  disputes:      { label: 'Litiges',         icon: 'alert',     render: renderDisputes,      mount: mountDisputes },
  rates:         { label: 'Tarifs',          icon: 'tag',       render: renderRates,         mount: mountRates },
  announcements: { label: 'Annonces',        icon: 'megaphone', render: renderAnnouncements, mount: mountAnnouncements },
  settings:      { label: 'Paramètres',      icon: 'sliders',   render: renderSettings,      mount: mountSettings },
  team:          { label: 'Équipe & accès',  icon: 'shield',    render: renderTeam,          mount: mountTeam },
  clients:       { label: 'Clients',         icon: 'user',      render: renderClients,       mount: mountClients },
  logs:          { label: 'Journal d\'audit', icon: 'list',     render: renderLogs,          mount: mountLogs },
};

const NAV_GROUPS = [
  ['Pilotage', ['overview', 'finance']],
  ['Logistique', ['packages', 'shipments', 'disputes']],
  ['Contenu du site', ['rates', 'announcements', 'settings']],
  ['Utilisateurs', ['team', 'clients']],
  ['Sécurité', ['logs']],
];


/* =====================================================================
 * 4. VUE D'ENSEMBLE
 * ===================================================================== */
async function renderOverview() {
  await load(loadPackages, loadUsers, loadShipments);
  const pk = state.packages;
  const clients = state.users.filter((u) => u.role === 'client');
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const inTransit = pk.filter((p) => p.status === 'in_transit').length;
  const atAgency = pk.filter((p) => p.status === 'available_agency').length;
  const toCollect = sumAmount(pk.filter((p) => p.payment_status === 'unpaid' && p.amount_due != null && p.status !== 'declared'));
  const collectedMonth = sumAmount(pk.filter((p) => p.payment_status === 'paid' && p.paid_at && new Date(p.paid_at) >= monthStart));
  const toReceive = pk.filter((p) => p.status === 'declared').length;

  const { count: openDisputes } = await supabase.from('disputes').select('id', { count: 'exact', head: true })
    .in('status', ['open', 'in_review']);

  const counts = STATUS_ORDER.map((s) => [s, pk.filter((p) => p.status === s).length]);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const recent = pk.slice(0, 8);
  const openLots = state.shipments.filter((s) => ['preparing', 'in_transit'].includes(s.status));

  const alerts = [];
  if (openDisputes) alerts.push('<div class="alert alert--warn">' + icon('alert') + '<span><strong>' + openDisputes + ' litige' + (openDisputes > 1 ? 's' : '') + '</strong> à traiter.</span><a class="btn btn--accent btn--sm" href="#/disputes">Traiter</a></div>');
  if (!pk.length) alerts.push('<div class="alert">' + icon('alert') + '<span>Aucun colis pour l\'instant. Les colis apparaissent dès que les clients les déclarent.</span></div>');

  return pageHead('Vue d\'ensemble', 'Activité en temps réel de ' + (state.settingsName || 'l\'entreprise') + '.',
      '<div class="actions"><a class="btn btn--primary" href="#/shipments">' + icon('plusSimple', 18) + ' Nouveau lot</a></div>') +
    (alerts.length ? '<div class="stack" style="margin-bottom:18px">' + alerts.join('') + '</div>' : '') +
    '<div class="grid grid--4">' +
      kpi('package', 'Colis au total', pk.length, '#/packages') +
      kpi('truck', 'En transit', inTransit, '#/packages', '') +
      kpi('checkCircle', 'Disponibles à l\'agence', atAgency, '#/packages', 'warn') +
      kpi('user', 'Clients inscrits', clients.length, '#/clients', 'success') +
    '</div><div style="height:16px"></div>' +
    '<div class="grid grid--4">' +
      kpi('clock', 'Colis à réceptionner', toReceive, '#/packages') +
      kpi('card', 'Reste à encaisser', formatMoney(toCollect), '#/finance', 'accent') +
      kpi('chart', 'Encaissé ce mois', formatMoney(collectedMonth), '#/finance', 'success') +
      kpi('layers', 'Lots en cours', openLots.length, '#/shipments') +
    '</div>' +

    '<div class="split" style="margin-top:24px">' +
      '<section class="card"><h2 class="card__title">Colis par statut</h2><p class="card__sub" style="margin-bottom:16px">Répartition actuelle</p>' +
        '<div class="bars">' + counts.map(([s, n]) => bar(statusLabel(s), n, max, s === 'available_agency' ? 'accent' : s === 'delivered' ? 'success' : '')).join('') + '</div></section>' +
      '<section class="card"><h2 class="card__title">Lots en cours</h2><p class="card__sub" style="margin-bottom:8px">En préparation ou en transit</p>' +
        (openLots.length
          ? openLots.slice(0, 6).map((s) => '<div class="stat-line"><span><strong>' + esc(s.reference) + '</strong><br><small class="muted">' +
              esc(modeLabel(s.mode)) + (s.eta ? ' · ETA ' + formatDate(s.eta) : '') + '</small></span>' +
              '<span class="badge badge--' + s.status + '">' + esc(SHIPMENT_STATUS_LABELS[s.status]) + '</span></div>').join('')
          : '<p class="muted">Aucun lot en cours.</p>') + '</section>' +
    '</div>' +

    '<h2 class="section-title">Derniers colis <a href="#/packages">Tout voir</a></h2>' +
    (recent.length ? packageTable(recent) : emptyState('package', 'Aucun colis', 'Les colis déclarés par les clients apparaîtront ici.'));
}


/* =====================================================================
 * 5. COLIS : LISTE, FILTRES, ÉDITEUR
 * ===================================================================== */

/** Tableau de colis (réutilisé par la vue d'ensemble et la liste complète) */
function packageTable(list) {
  return '<div class="table-wrap"><table class="table data-table"><thead><tr>' +
    '<th>Référence</th><th>Client</th><th>N° de suivi</th><th>Mode</th><th>Statut</th>' +
    '<th class="t-right">Montant</th><th>Paiement</th><th>Mise à jour</th></tr></thead><tbody>' +
    list.map((p) =>
      '<tr class="row-link" tabindex="0" data-open-pkg="' + p.id + '">' +
      '<td class="t-strong">' + esc(p.reference) + '</td>' +
      '<td>' + esc(userLabel(p.client_id)) + '</td>' +
      '<td class="t-mono">' + esc(p.supplier_tracking) + '</td>' +
      '<td>' + esc(modeLabel(p.shipping_mode)) + '</td>' +
      '<td>' + statusBadge(p.status) + '</td>' +
      '<td class="t-right t-strong">' + (p.amount_due != null ? formatMoney(p.amount_due) : '—') + '</td>' +
      '<td><span class="badge badge--' + p.payment_status + '">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span></td>' +
      '<td>' + formatDate(p.updated_at) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

function filteredPackages() {
  const { q, status, mode, pay } = ui.pkg;
  const needle = q.trim().toLowerCase();
  return state.packages.filter((p) =>
    (!status || p.status === status) &&
    (!mode || p.shipping_mode === mode) &&
    (!pay || p.payment_status === pay) &&
    (!needle || [p.reference, p.supplier_tracking, p.description, userLabel(p.client_id), userById(p.client_id)?.email]
      .some((v) => (v || '').toLowerCase().includes(needle))));
}

function packagesTableHtml() {
  const list = filteredPackages();
  if (!list.length) return emptyState('search', 'Aucun colis trouvé', 'Modifiez vos filtres ou votre recherche.');
  const shown = list.slice(0, ui.pkg.limit);
  return '<p class="result-count">' + list.length + ' colis' + (list.length > shown.length ? ' (' + shown.length + ' affichés)' : '') + '</p>' +
    packageTable(shown) +
    (list.length > shown.length ? '<div class="more-row"><button class="btn btn--ghost" type="button" id="pkg-more">Afficher plus</button></div>' : '');
}

async function renderPackages() {
  await load(loadPackages, loadUsers, loadShipments);
  return pageHead('Colis', 'Tous les colis de tous les clients. Cliquez sur une ligne pour modifier.',
      '<div class="actions"><button class="btn btn--ghost" type="button" id="pkg-export">' + icon('file', 18) + ' Exporter en CSV</button></div>') +
    '<div class="filters">' +
      '<div class="input-group">' + icon('search', 18) + '<input class="input" id="pkg-q" type="search" placeholder="Référence, suivi, client, email…" value="' + esc(ui.pkg.q) + '" aria-label="Rechercher"></div>' +
      '<select class="select" id="pkg-status" aria-label="Statut">' + options(STATUS_LABELS, ui.pkg.status, 'Tous les statuts') + '</select>' +
      '<select class="select" id="pkg-mode" aria-label="Mode">' + options(Object.fromEntries(Object.entries(SHIPPING_MODES).map(([k, m]) => [k, m.label])), ui.pkg.mode, 'Aérien et maritime') + '</select>' +
      '<select class="select" id="pkg-pay" aria-label="Paiement">' + options(PAYMENT_STATUS_LABELS, ui.pkg.pay, 'Tous les paiements') + '</select>' +
    '</div><div id="pkg-table">' + packagesTableHtml() + '</div>';
}

function mountPackages(view) {
  const redraw = () => { $('#pkg-table', view).innerHTML = packagesTableHtml(); };
  $('#pkg-q', view).addEventListener('input', debounce((e) => { ui.pkg.q = e.target.value; ui.pkg.limit = 100; redraw(); }, 200));
  [['status', '#pkg-status'], ['mode', '#pkg-mode'], ['pay', '#pkg-pay']].forEach(([key, sel]) =>
    $(sel, view).addEventListener('change', (e) => { ui.pkg[key] = e.target.value; ui.pkg.limit = 100; redraw(); }));

  on(view, 'click', '#pkg-more', () => { ui.pkg.limit += 100; redraw(); });
  on(view, 'click', '[data-open-pkg]', (el) => openPackageEditor(el.dataset.openPkg));
  on(view, 'keydown', '[data-open-pkg]', (el, e) => { if (e.key === 'Enter') openPackageEditor(el.dataset.openPkg); });

  $('#pkg-export', view).addEventListener('click', () => {
    const rows = [['Référence', 'Client', 'Email', 'N° suivi', 'Description', 'Mode', 'Statut', 'Poids (kg)', 'Volume (m3)',
      'Tarif', 'Montant', 'Paiement', 'Mode de paiement', 'Créé le', 'Livré le']];
    filteredPackages().forEach((p) => rows.push([
      p.reference, userLabel(p.client_id), userById(p.client_id)?.email || '', p.supplier_tracking, p.description || '',
      modeLabel(p.shipping_mode), statusLabel(p.status), p.weight_kg ?? '', p.volume_m3 ?? '',
      p.rate_applied ?? '', p.amount_due ?? '', PAYMENT_STATUS_LABELS[p.payment_status],
      p.payment_method ? PAYMENT_METHOD_LABELS[p.payment_method] : '', formatDate(p.created_at), p.delivered_at ? formatDate(p.delivered_at) : '']));
    downloadCsv('colis-' + new Date().toISOString().slice(0, 10) + '.csv', rows);
  });
}

/** Résumé lisible d'une ligne du journal (utilisé par l'historique et le journal) */
const ENTITY_LABELS = {
  packages: 'Colis', shipments: 'Lot', rates: 'Tarif', authorized_staff: 'Accès équipe',
  disputes: 'Litige', announcements: 'Annonce', app_settings: 'Paramètre',
};
const ACTION_LABELS = { insert: 'Création', update: 'Modification', delete: 'Suppression', status_change: 'Changement de statut' };

function logSummary(l) {
  const o = l.old_data || {};
  const n = l.new_data || {};
  if (l.action === 'status_change') {
    const dict = l.entity_type === 'shipments' ? SHIPMENT_STATUS_LABELS : STATUS_LABELS;
    return (dict[o.status] || o.status) + ' → ' + (dict[n.status] || n.status);
  }
  if (l.action === 'insert') return n.reference || n.email || n.key || n.subject || n.message || n.price_per_unit || '';
  if (l.action === 'delete') return o.reference || o.email || o.key || o.subject || '';
  const ignore = new Set(['updated_at']);
  const changed = Object.keys(n).filter((k) => !ignore.has(k) && JSON.stringify(n[k]) !== JSON.stringify(o[k]));
  return changed.length ? 'Champs : ' + changed.join(', ') : '';
}

/** Éditeur complet d'un colis (l'admin peut tout corriger) */
async function openPackageEditor(id) {
  const p = state.packages.find((x) => x.id === id);
  if (!p) return;
  if (!state.shipments.length) await loadShipments().catch(() => {});

  const lots = state.shipments.filter((s) => s.status !== 'closed' || s.id === p.shipment_id);
  const lotOptions = '<option value="">— Aucun —</option>' + lots.map((s) =>
    '<option value="' + s.id + '"' + (s.id === p.shipment_id ? ' selected' : '') + '>' + esc(s.reference) + ' · ' + esc(modeLabel(s.mode)) + ' · ' + esc(SHIPMENT_STATUS_LABELS[s.status]) + '</option>').join('');
  const client = userById(p.client_id);

  openModal(p.reference,
    '<div class="callout">' + icon('user', 18) + '<span><strong>' + esc(client?.full_name || 'Client') + '</strong> · ' + esc(client?.email || '') +
      (client?.phone ? ' · ' + esc(client.phone) : '') + '</span></div>' +
    '<form class="form" id="pkg-form"><div class="form-grid">' +
      '<span class="form-section">Déclaration</span>' +
      '<label class="field"><span class="field__label">N° de suivi fournisseur</span><input class="input" name="supplier_tracking" required minlength="6" value="' + esc(p.supplier_tracking) + '"></label>' +
      '<label class="field"><span class="field__label">Mode d\'expédition</span><select class="select" name="shipping_mode">' +
        options(Object.fromEntries(Object.entries(SHIPPING_MODES).map(([k, m]) => [k, m.label])), p.shipping_mode) + '</select></label>' +
      '<label class="field span-2"><span class="field__label">Description</span><textarea class="textarea" name="description" maxlength="300" style="min-height:70px">' + esc(p.description || '') + '</textarea></label>' +

      '<span class="form-section">Logistique</span>' +
      '<label class="field"><span class="field__label">Statut</span><select class="select" name="status">' + options(STATUS_LABELS, p.status) + '</select></label>' +
      '<label class="field"><span class="field__label">Lot / conteneur / vol</span><select class="select" name="shipment_id">' + lotOptions + '</select></label>' +
      '<label class="field"><span class="field__label">Poids (kg)</span><input class="input" name="weight_kg" inputmode="decimal" value="' + (p.weight_kg ?? '') + '"></label>' +
      '<label class="field"><span class="field__label">Volume (m³)</span><input class="input" name="volume_m3" inputmode="decimal" value="' + (p.volume_m3 ?? '') + '">' +
        '<span class="field__hint">Recalculé automatiquement si les 3 dimensions sont renseignées.</span></label>' +
      '<label class="field"><span class="field__label">Longueur (cm)</span><input class="input" name="length_cm" inputmode="decimal" value="' + (p.length_cm ?? '') + '"></label>' +
      '<label class="field"><span class="field__label">Largeur (cm)</span><input class="input" name="width_cm" inputmode="decimal" value="' + (p.width_cm ?? '') + '"></label>' +
      '<label class="field"><span class="field__label">Hauteur (cm)</span><input class="input" name="height_cm" inputmode="decimal" value="' + (p.height_cm ?? '') + '"></label>' +

      '<span class="form-section">Facturation</span>' +
      '<div class="field"><span class="field__label">Tarif appliqué / Montant</span><input class="input" readonly value="' +
        esc(p.amount_due != null ? formatMoney(p.amount_due) + ' (tarif ' + formatMoney(p.rate_applied) + ')' : 'Calculé après pesée') + '"></div>' +
      '<label class="field"><span class="field__label">Paiement</span><select class="select" name="payment_status">' + options(PAYMENT_STATUS_LABELS, p.payment_status) + '</select></label>' +
      '<label class="field"><span class="field__label">Mode de paiement</span><select class="select" name="payment_method">' + options(PAYMENT_METHOD_LABELS, p.payment_method || '', '—') + '</select></label>' +

      '<span class="form-section">Livraison</span>' +
      '<label class="field"><span class="field__label">Retiré par</span><input class="input" name="delivered_to" maxlength="120" value="' + esc(p.delivered_to || '') + '"></label>' +
      '<label class="field"><span class="field__label">Note de livraison</span><input class="input" name="delivery_note" maxlength="300" value="' + esc(p.delivery_note || '') + '"></label>' +
    '</div>' +
    '<div class="modal__actions" style="justify-content:space-between">' +
      '<button type="button" class="btn btn--danger-ghost" id="pkg-delete">' + icon('trash', 16) + ' Supprimer</button>' +
      '<span class="actions"><button type="button" class="btn btn--ghost" id="pkg-cancel">Fermer</button>' +
      '<button type="submit" class="btn btn--primary">Enregistrer</button></span></div></form>' +
    '<div><p class="detail-section-title">Historique</p><div class="history" id="pkg-history"><p class="muted">Chargement…</p></div></div>',
    { kind: 'package', id: p.id });

  const form = $('#pkg-form');
  $('#pkg-cancel').addEventListener('click', closeModal);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const tracking = String(fd.get('supplier_tracking')).replace(/\s+/g, '').toUpperCase();
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const { data, error } = await supabase.from('packages').update({
      supplier_tracking: tracking,
      shipping_mode: fd.get('shipping_mode'),
      description: textOrNull(fd.get('description')),
      status: fd.get('status'),
      shipment_id: fd.get('shipment_id') || null,
      weight_kg: numOrNull(fd.get('weight_kg')),
      volume_m3: numOrNull(fd.get('volume_m3')),
      length_cm: numOrNull(fd.get('length_cm')),
      width_cm: numOrNull(fd.get('width_cm')),
      height_cm: numOrNull(fd.get('height_cm')),
      payment_status: fd.get('payment_status'),
      payment_method: fd.get('payment_method') || null,
      delivered_to: textOrNull(fd.get('delivered_to')),
      delivery_note: textOrNull(fd.get('delivery_note')),
    }).eq('id', p.id).select().single();
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error', 6000);

    const i = state.packages.findIndex((x) => x.id === p.id);
    if (i >= 0) state.packages[i] = data;
    closeModal();
    toast('Colis ' + data.reference + ' mis à jour', 'success');
    router.refresh({ keepScroll: true });
  });

  $('#pkg-delete').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Supprimer ce colis ?',
      message: 'Le colis ' + p.reference + ' et ses litiges seront supprimés définitivement. Cette action est irréversible.',
      confirmLabel: 'Supprimer', danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('packages').delete().eq('id', p.id);
    if (error) return toast(friendlyError(error), 'error');
    state.packages = state.packages.filter((x) => x.id !== p.id);
    closeModal();
    toast('Colis supprimé', 'success');
    router.refresh({ keepScroll: true });
  });

  // Historique des modifications de ce colis (table logs)
  const { data: logs } = await supabase.from('logs').select('*')
    .eq('entity_type', 'packages').eq('entity_id', p.id).order('created_at', { ascending: false }).limit(15);
  const box = $('#pkg-history');
  if (box) box.innerHTML = logs?.length
    ? logs.map((l) => '<div class="log-item"><span class="log-item__when">' + formatDate(l.created_at, true) + '</span><span class="log-item__what"><strong>' +
        esc(ACTION_LABELS[l.action] || l.action) + ' — ' + esc(logSummary(l)) + '</strong><small>' + esc(l.actor_email || 'système') + '</small></span></div>').join('')
    : '<p class="muted">Aucun historique.</p>';
}


/* =====================================================================
 * 6. LOTS / CONTENEURS / VOLS
 *    Quand un lot passe « en transit » ou « arrivé », ses colis suivent
 *    automatiquement (trigger shipments_cascade dans schema.sql).
 * ===================================================================== */
async function renderShipments() {
  await load(loadShipments, loadPackages, loadUsers);
  const countFor = (id) => state.packages.filter((p) => p.shipment_id === id).length;

  return pageHead('Lots, conteneurs & vols', 'Regroupez les colis réceptionnés en Chine ; le statut du lot met à jour tous ses colis.',
      '<div class="actions"><button class="btn btn--primary" type="button" id="ship-new">' + icon('plusSimple', 18) + ' Nouveau lot</button></div>') +
    (state.shipments.length
      ? '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Référence</th><th>Type</th><th>Mode</th><th>N° transporteur</th>' +
        '<th>Statut</th><th class="t-right">Colis</th><th>ETA</th><th>Créé le</th></tr></thead><tbody>' +
        state.shipments.map((s) => '<tr class="row-link" tabindex="0" data-open-ship="' + s.id + '"><td class="t-strong">' + esc(s.reference) + '</td>' +
          '<td>' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + '</td><td>' + esc(modeLabel(s.mode)) + '</td>' +
          '<td class="t-mono">' + esc(s.carrier_ref || '—') + '</td>' +
          '<td><span class="badge badge--' + s.status + '">' + esc(SHIPMENT_STATUS_LABELS[s.status]) + '</span></td>' +
          '<td class="t-right t-strong">' + countFor(s.id) + '</td><td>' + (s.eta ? formatDate(s.eta) : '—') + '</td><td>' + formatDate(s.created_at) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : emptyState('layers', 'Aucun lot', 'Créez un lot pour regrouper les colis à expédier.',
          '<button class="btn btn--primary" type="button" id="ship-new-empty">Créer un lot</button>'));
}

function mountShipments(view) {
  on(view, 'click', '#ship-new, #ship-new-empty', () => openShipmentEditor());
  on(view, 'click', '[data-open-ship]', (el) => openShipmentEditor(el.dataset.openShip));
  on(view, 'keydown', '[data-open-ship]', (el, e) => { if (e.key === 'Enter') openShipmentEditor(el.dataset.openShip); });
}

function openShipmentEditor(id) {
  const s = id ? shipmentById(id) : null;
  const inLot = s ? state.packages.filter((p) => p.shipment_id === s.id) : [];

  openModal(s ? s.reference : 'Nouveau lot',
    '<form class="form" id="ship-form"><div class="form-grid">' +
      '<label class="field"><span class="field__label">Mode *</span><select class="select" name="mode" required>' +
        options(Object.fromEntries(Object.entries(SHIPPING_MODES).map(([k, m]) => [k, m.label])), s?.mode || 'sea') + '</select></label>' +
      '<label class="field"><span class="field__label">Type</span><select class="select" name="kind">' + options(SHIPMENT_KIND_LABELS, s?.kind || 'lot') + '</select></label>' +
      '<label class="field"><span class="field__label">N° conteneur / LTA / vol</span><input class="input" name="carrier_ref" maxlength="60" value="' + esc(s?.carrier_ref || '') + '"></label>' +
      '<label class="field"><span class="field__label">Arrivée estimée (ETA)</span><input class="input" type="date" name="eta" value="' + esc(s?.eta || '') + '"></label>' +
      (s ? '<label class="field span-2"><span class="field__label">Statut du lot</span><select class="select" name="status">' + options(SHIPMENT_STATUS_LABELS, s.status) + '</select>' +
        '<span class="field__hint">« En transit » et « Arrivé » mettent automatiquement à jour tous les colis du lot.</span></label>' : '') +
      '<label class="field span-2"><span class="field__label">Notes</span><textarea class="textarea" name="notes" style="min-height:70px">' + esc(s?.notes || '') + '</textarea></label>' +
    '</div>' +
    '<div class="modal__actions" style="justify-content:space-between">' +
      (s ? '<button type="button" class="btn btn--danger-ghost" id="ship-delete">' + icon('trash', 16) + ' Supprimer</button>' : '<span></span>') +
      '<span class="actions"><button type="button" class="btn btn--ghost" id="ship-cancel">Fermer</button>' +
      '<button type="submit" class="btn btn--primary">' + (s ? 'Enregistrer' : 'Créer le lot') + '</button></span></div></form>' +
    (s ? '<div><p class="detail-section-title">Colis du lot (' + inLot.length + ')</p>' +
      (inLot.length ? '<div class="table-wrap"><table class="table data-table"><tbody>' + inLot.map((p) =>
        '<tr><td class="t-strong">' + esc(p.reference) + '</td><td>' + esc(userLabel(p.client_id)) + '</td><td>' + statusBadge(p.status) +
        '</td><td class="t-right">' + (p.weight_kg ? formatWeight(p.weight_kg) : formatVolume(p.volume_m3)) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="muted">Aucun colis dans ce lot. Rattachez-les depuis l\'entrepôt Chine ou la fiche colis.</p>') + '</div>' : ''),
    { kind: 'shipment' });

  $('#ship-cancel').addEventListener('click', closeModal);
  const form = $('#ship-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      mode: fd.get('mode'), kind: fd.get('kind'),
      carrier_ref: textOrNull(fd.get('carrier_ref')),
      eta: fd.get('eta') || null,
      notes: textOrNull(fd.get('notes')),
      ...(s ? { status: fd.get('status') } : {}),
    };
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const { error } = s
      ? await supabase.from('shipments').update(payload).eq('id', s.id)
      : await supabase.from('shipments').insert(payload);
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error', 6000);
    closeModal();
    toast(s ? 'Lot mis à jour' : 'Lot créé', 'success');
    router.refresh({ keepScroll: true });
  });

  $('#ship-delete')?.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Supprimer ce lot ?',
      message: 'Les ' + inLot.length + ' colis du lot seront simplement détachés (ils ne sont pas supprimés).',
      confirmLabel: 'Supprimer', danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('shipments').delete().eq('id', s.id);
    if (error) return toast(friendlyError(error), 'error');
    closeModal();
    toast('Lot supprimé', 'success');
    router.refresh({ keepScroll: true });
  });
}


/* =====================================================================
 * 7. FINANCES
 * ===================================================================== */
async function renderFinance() {
  await load(loadPackages, loadUsers);
  const billed = state.packages.filter((p) => p.amount_due != null);
  const paid = billed.filter((p) => p.payment_status === 'paid');
  const unpaid = billed.filter((p) => p.payment_status === 'unpaid');

  // 6 derniers mois d'encaissements (selon paid_at)
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
      label: d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }), total: 0 });
  }
  paid.forEach((p) => {
    if (!p.paid_at) return;
    const d = new Date(p.paid_at);
    const m = months.find((x) => x.key === d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    if (m) m.total += Number(p.amount_due);
  });
  const maxMonth = Math.max(1, ...months.map((m) => m.total));

  const byMode = Object.keys(SHIPPING_MODES).map((k) => [k, sumAmount(paid.filter((p) => p.shipping_mode === k))]);
  const maxMode = Math.max(1, ...byMode.map(([, v]) => v));
  const unpaidList = unpaid.filter((p) => p.status !== 'declared')
    .sort((a, b) => STATUS_ORDER.indexOf(b.status) - STATUS_ORDER.indexOf(a.status));

  return pageHead('Finances', 'Montants calculés automatiquement à partir des tarifs actifs au moment de la pesée.',
      '<div class="actions"><button class="btn btn--ghost" type="button" id="fin-export">' + icon('file', 18) + ' Exporter les impayés (CSV)</button></div>') +
    '<div class="grid grid--4">' +
      kpi('file', 'Total facturé', formatMoney(sumAmount(billed))) +
      kpi('checkCircle', 'Encaissé', formatMoney(sumAmount(paid)), '', 'success') +
      kpi('card', 'Reste à encaisser', formatMoney(sumAmount(unpaid)), '', 'accent') +
      kpi('package', 'Colis facturés', billed.length) +
    '</div>' +
    '<div class="split" style="margin-top:24px">' +
      '<section class="card"><h2 class="card__title">Encaissements des 6 derniers mois</h2><p class="card__sub" style="margin-bottom:16px">Selon la date de validation du paiement</p>' +
        '<div class="bars">' + months.map((m) => bar(m.label, m.total, maxMonth, 'success', formatMoney(m.total))).join('') + '</div></section>' +
      '<section class="card"><h2 class="card__title">Encaissé par mode</h2><p class="card__sub" style="margin-bottom:16px">Depuis le début</p>' +
        '<div class="bars">' + byMode.map(([k, v]) => bar(SHIPPING_MODES[k].label, v, maxMode, k === 'air' ? '' : 'accent', formatMoney(v))).join('') + '</div></section>' +
    '</div>' +
    '<h2 class="section-title">Paiements à valider (' + unpaidList.length + ')</h2>' +
    (unpaidList.length
      ? '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Référence</th><th>Client</th><th>Statut</th><th class="t-right">Montant</th><th></th></tr></thead><tbody>' +
        unpaidList.map((p) => '<tr><td class="t-strong">' + esc(p.reference) + '</td><td>' + esc(userLabel(p.client_id)) + '</td><td>' + statusBadge(p.status) +
          '</td><td class="t-right t-strong">' + formatMoney(p.amount_due) + '</td>' +
          '<td><button class="btn btn--primary btn--sm" type="button" data-pay="' + p.id + '">Valider le paiement</button></td></tr>').join('') + '</tbody></table></div>'
      : emptyState('checkCircle', 'Tout est encaissé', 'Aucun paiement en attente pour les colis déjà réceptionnés.'));
}

function mountFinance(view) {
  on(view, 'click', '[data-pay]', (el) => openPayModal(el.dataset.pay));
  $('#fin-export', view).addEventListener('click', () => {
    const rows = [['Référence', 'Client', 'Email', 'Statut', 'Mode', 'Montant', 'Devise']];
    state.packages.filter((p) => p.payment_status === 'unpaid' && p.amount_due != null).forEach((p) => rows.push([
      p.reference, userLabel(p.client_id), userById(p.client_id)?.email || '', statusLabel(p.status),
      modeLabel(p.shipping_mode), p.amount_due, p.currency]));
    downloadCsv('impayes-' + new Date().toISOString().slice(0, 10) + '.csv', rows);
  });
}

function openPayModal(id) {
  const p = state.packages.find((x) => x.id === id);
  if (!p) return;
  openModal('Valider le paiement',
    '<form class="form" id="pay-form">' +
      '<div class="kv"><div><dt>Colis</dt><dd>' + esc(p.reference) + '</dd></div><div><dt>Client</dt><dd>' + esc(userLabel(p.client_id)) + '</dd></div>' +
      '<div><dt>Montant</dt><dd>' + formatMoney(p.amount_due) + '</dd></div></div>' +
      '<label class="field"><span class="field__label">Mode de paiement</span><select class="select" name="payment_method">' + options(PAYMENT_METHOD_LABELS, 'on_delivery') + '</select></label>' +
      '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="pay-cancel">Annuler</button>' +
      '<button type="submit" class="btn btn--primary">Confirmer l\'encaissement</button></div></form>', { kind: 'pay' });

  $('#pay-cancel').addEventListener('click', closeModal);
  $('#pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    setBusy(btn, true, 'Validation…');
    const { data, error } = await supabase.from('packages')
      .update({ payment_status: 'paid', payment_method: new FormData(e.target).get('payment_method') })
      .eq('id', id).select().single();
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');
    const i = state.packages.findIndex((x) => x.id === id);
    if (i >= 0) state.packages[i] = data;
    closeModal();
    toast('Paiement de ' + formatMoney(data.amount_due) + ' validé', 'success');
    router.refresh({ keepScroll: true });
  });
}


/* =====================================================================
 * 8. TARIFS
 *    Un seul tarif actif par mode : en créer un nouveau désactive
 *    l'ancien (trigger rates_single_active). L'historique est conservé ;
 *    les colis déjà pesés gardent leur tarif (rate_applied).
 * ===================================================================== */
async function renderRates() {
  const { data, error } = await supabase.from('rates').select('*').order('effective_from', { ascending: false });
  if (error) throw error;
  const active = Object.fromEntries(data.filter((r) => r.active).map((r) => [r.mode, r]));

  const card = (mode) => {
    const m = SHIPPING_MODES[mode];
    const r = active[mode];
    return '<article class="card rate-edit"><div><span class="tag tag--info">' + icon(mode === 'air' ? 'plane' : 'ship', 14) + ' ' + esc(m.label) + '</span></div>' +
      '<div><span class="kpi__value">' + (r ? formatMoney(r.price_per_unit) : 'Non défini') + '</span><span class="muted"> / ' + m.unit + '</span>' +
      (r ? '<br><small class="muted">En vigueur depuis le ' + formatDate(r.effective_from) + '</small>' : '') + '</div>' +
      '<form class="inline-form" data-rate-form="' + mode + '"><label class="field"><span class="field__label">Nouveau tarif (par ' + m.unit + ')</span>' +
      '<input class="input" name="price" inputmode="decimal" required placeholder="Ex : 10000"></label>' +
      '<button class="btn btn--primary" type="submit">Appliquer</button></form></article>';
  };

  return pageHead('Tarifs', 'Aérien : prix par kg · Maritime : prix par m³. Les nouveaux tarifs s\'appliquent aux prochaines pesées.') +
    '<div class="grid grid--2">' + card('air') + card('sea') + '</div>' +
    '<h2 class="section-title">Historique des tarifs</h2>' +
    (data.length
      ? '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Mode</th><th class="t-right">Prix</th><th>Depuis le</th><th>État</th></tr></thead><tbody>' +
        data.map((r) => '<tr><td>' + esc(modeLabel(r.mode)) + '</td><td class="t-right t-strong">' + formatMoney(r.price_per_unit) + ' / ' + SHIPPING_MODES[r.mode].unit +
          '</td><td>' + formatDate(r.effective_from, true) + '</td><td>' + (r.active ? '<span class="tag tag--ok">Actif</span>' : '<span class="tag">Ancien</span>') + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<p class="muted">Aucun tarif enregistré : définissez-en un ci-dessus pour permettre le calcul des montants.</p>');
}

function mountRates(view) {
  $$('[data-rate-form]', view).forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = form.dataset.rateForm;
    const price = num(new FormData(form).get('price'));
    if (!(price > 0)) return toast('Saisissez un prix supérieur à 0.', 'error');
    const ok = await askConfirm({
      title: 'Appliquer ce tarif ?',
      message: 'Nouveau tarif ' + SHIPPING_MODES[mode].label.toLowerCase() + ' : ' + formatMoney(price) + ' / ' + SHIPPING_MODES[mode].unit +
        '. Il remplace le tarif actuel pour les prochaines pesées.',
      confirmLabel: 'Appliquer',
    });
    if (!ok) return;
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, '…');
    const { error } = await supabase.from('rates').insert({ mode, price_per_unit: price, active: true });
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');
    toast('Tarif mis à jour', 'success');
    router.refresh({ keepScroll: true });
  }));
}


/* =====================================================================
 * 9. ANNONCES (bandeau défilant + page « Infos & annonces » du client)
 * ===================================================================== */
async function renderAnnouncements() {
  const { data, error } = await supabase.from('announcements').select('*')
    .order('kind').order('sort_order').order('created_at', { ascending: false });
  if (error) throw error;
  state.announcements = data;
  const now = Date.now();
  const live = (a) => a.active && (!a.starts_at || new Date(a.starts_at) <= now) && (!a.ends_at || new Date(a.ends_at) >= now);

  return pageHead('Annonces', 'Le bandeau défilant et la page « Infos & annonces » de l\'espace client sont alimentés ici.',
      '<div class="actions"><button class="btn btn--primary" type="button" id="ann-new">' + icon('plusSimple', 18) + ' Nouvelle annonce</button></div>') +
    (data.length
      ? '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Type</th><th>Message</th><th>Période</th><th>Ordre</th><th>État</th></tr></thead><tbody>' +
        data.map((a) => '<tr class="row-link" tabindex="0" data-open-ann="' + a.id + '">' +
          '<td><span class="tag tag--' + (a.kind === 'ticker' ? 'warn' : 'info') + '">' + (a.kind === 'ticker' ? 'Bandeau' : 'Info') + '</span></td>' +
          '<td class="t-wrap">' + (a.title ? '<span class="t-strong">' + esc(a.title) + '</span><span class="t-sub">' : '<span class="t-sub" style="color:inherit">') + esc(a.message.length > 110 ? a.message.slice(0, 110) + '…' : a.message) + '</span></td>' +
          '<td>' + (a.starts_at ? formatDate(a.starts_at) : 'Maintenant') + ' → ' + (a.ends_at ? formatDate(a.ends_at) : '∞') + '</td>' +
          '<td>' + a.sort_order + '</td>' +
          '<td>' + (live(a) ? '<span class="tag tag--ok">En ligne</span>' : a.active ? '<span class="tag tag--warn">Programmée / expirée</span>' : '<span class="tag tag--off">Désactivée</span>') + '</td></tr>').join('') +
        '</tbody></table></div>'
      : emptyState('megaphone', 'Aucune annonce', 'Créez une annonce de type « Bandeau » pour la faire défiler en haut de l\'espace client.',
          '<button class="btn btn--primary" type="button" id="ann-new-empty">Créer une annonce</button>'));
}

function mountAnnouncements(view) {
  on(view, 'click', '#ann-new, #ann-new-empty', () => openAnnouncementEditor());
  on(view, 'click', '[data-open-ann]', (el) => openAnnouncementEditor(el.dataset.openAnn));
  on(view, 'keydown', '[data-open-ann]', (el, e) => { if (e.key === 'Enter') openAnnouncementEditor(el.dataset.openAnn); });
}

function openAnnouncementEditor(id) {
  const a = id ? state.announcements.find((x) => x.id === id) : null;
  openModal(a ? 'Modifier l\'annonce' : 'Nouvelle annonce',
    '<form class="form" id="ann-form"><div class="form-grid">' +
      '<label class="field"><span class="field__label">Où l\'afficher ?</span><select class="select" name="kind">' +
        options({ ticker: 'Bandeau défilant (en haut)', info: 'Page « Infos & annonces »' }, a?.kind || 'ticker') + '</select></label>' +
      '<label class="field"><span class="field__label">Ordre d\'affichage</span><input class="input" name="sort_order" type="number" value="' + (a?.sort_order ?? 0) + '"></label>' +
      '<label class="field span-2"><span class="field__label">Titre (pour les infos)</span><input class="input" name="title" maxlength="120" value="' + esc(a?.title || '') + '"></label>' +
      '<label class="field span-2"><span class="field__label">Message *</span><textarea class="textarea" name="message" required maxlength="500">' + esc(a?.message || '') + '</textarea></label>' +
      '<label class="field"><span class="field__label">Début (facultatif)</span><input class="input" type="datetime-local" name="starts_at" value="' + toLocalInput(a?.starts_at) + '"></label>' +
      '<label class="field"><span class="field__label">Fin (facultatif)</span><input class="input" type="datetime-local" name="ends_at" value="' + toLocalInput(a?.ends_at) + '"></label>' +
      '<div class="span-2">' + switchHtml('active', a ? a.active : true, 'Annonce active') + '</div>' +
    '</div>' +
    '<div class="modal__actions" style="justify-content:space-between">' +
      (a ? '<button type="button" class="btn btn--danger-ghost" id="ann-delete">' + icon('trash', 16) + ' Supprimer</button>' : '<span></span>') +
      '<span class="actions"><button type="button" class="btn btn--ghost" id="ann-cancel">Fermer</button>' +
      '<button type="submit" class="btn btn--primary">Enregistrer</button></span></div></form>', { kind: 'announcement' });

  $('#ann-cancel').addEventListener('click', closeModal);
  const form = $('#ann-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      kind: fd.get('kind'),
      title: textOrNull(fd.get('title')),
      message: String(fd.get('message')).trim(),
      sort_order: parseInt(fd.get('sort_order'), 10) || 0,
      starts_at: fromLocalInput(fd.get('starts_at')),
      ends_at: fromLocalInput(fd.get('ends_at')),
      active: form.elements.active.checked,
    };
    if (payload.starts_at && payload.ends_at && payload.ends_at < payload.starts_at) {
      return toast('La date de fin doit être après la date de début.', 'error');
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const { error } = a
      ? await supabase.from('announcements').update(payload).eq('id', a.id)
      : await supabase.from('announcements').insert(payload);
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');
    closeModal();
    toast('Annonce enregistrée : visible tout de suite côté client', 'success');
    router.refresh({ keepScroll: true });
  });

  $('#ann-delete')?.addEventListener('click', async () => {
    if (!await askConfirm({ title: 'Supprimer l\'annonce ?', message: 'Elle disparaîtra de l\'espace client.', confirmLabel: 'Supprimer', danger: true })) return;
    const { error } = await supabase.from('announcements').delete().eq('id', a.id);
    if (error) return toast(friendlyError(error), 'error');
    closeModal();
    toast('Annonce supprimée', 'success');
    router.refresh({ keepScroll: true });
  });
}


/* =====================================================================
 * 10. PARAMÈTRES DE L'ENTREPRISE (table app_settings)
 * ===================================================================== */
const SETTING_GROUPS = [
  ['Identité & contact', ['company_name', 'whatsapp_number', 'support_phone', 'support_email']],
  ['Adresses', ['china_address', 'benin_address', 'benin_hours']],
  ['Délais & tarifs affichés', ['air_delay', 'sea_delay', 'rates_note']],
];
const LONG_SETTINGS = new Set(['china_address', 'benin_address', 'rates_note']);

async function renderSettings() {
  const { data, error } = await supabase.from('app_settings').select('*');
  if (error) throw error;
  const map = Object.fromEntries(data.map((s) => [s.key, s]));
  const known = new Set(SETTING_GROUPS.flatMap(([, keys]) => keys));
  const extra = data.filter((s) => !known.has(s.key)).map((s) => s.key);
  const groups = extra.length ? [...SETTING_GROUPS, ['Autres', extra]] : SETTING_GROUPS;

  return pageHead('Paramètres', 'Ces informations s\'affichent dans l\'espace client (en-tête, adresses, contact, délais).') +
    '<form class="stack" id="settings-form">' + groups.map(([title, keys]) =>
      '<section class="card setting-card"><h2 class="card__title">' + esc(title) + '</h2>' +
      keys.map((k) => {
        const s = map[k] || { key: k, value: '', label: k };
        return '<label class="setting-row"><span class="field__label">' + esc(s.label || k) + '</span>' +
          (LONG_SETTINGS.has(k)
            ? '<textarea class="textarea" name="' + esc(k) + '" data-original="' + esc(s.value) + '">' + esc(s.value) + '</textarea>'
            : '<input class="input" name="' + esc(k) + '" data-original="' + esc(s.value) + '" value="' + esc(s.value) + '">') + '</label>';
      }).join('') + '</section>').join('') +
    '<div class="callout">' + icon('alert', 18) + '<span>Dans l\'adresse de l\'entrepôt en Chine, <strong>{{name}}</strong> est remplacé automatiquement par le nom du client connecté.</span></div>' +
    '<div class="actions"><button class="btn btn--primary" type="submit">Enregistrer les paramètres</button></div></form>';
}

function mountSettings(view) {
  const form = $('#settings-form', view);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const changed = [...form.elements].filter((el) => el.name && el.value !== el.dataset.original);
    if (!changed.length) return toast('Aucune modification à enregistrer.', 'info');

    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    // upsert : crée la ligne si elle n'existe pas encore ; le libellé existant est conservé
    const { error } = await supabase.from('app_settings')
      .upsert(changed.map((el) => ({ key: el.name, value: el.value.trim() })), { onConflict: 'key', ignoreDuplicates: false });
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');
    changed.forEach((el) => { el.dataset.original = el.value; });
    toast(changed.length + ' paramètre' + (changed.length > 1 ? 's' : '') + ' enregistré' + (changed.length > 1 ? 's' : ''), 'success');
  });
}


/* =====================================================================
 * 11. ÉQUIPE & ACCÈS : LISTE BLANCHE GMAIL (table authorized_staff)
 *     Seuls les Gmail listés ici (et actifs) obtiennent un rôle admin /
 *     employé Chine / employé Bénin à leur connexion Google.
 * ===================================================================== */
const STAFF_ROLES = { admin: ROLE_LABELS.admin, china_staff: ROLE_LABELS.china_staff, benin_staff: ROLE_LABELS.benin_staff };

async function renderTeam() {
  const [{ data: staff, error }] = await Promise.all([
    supabase.from('authorized_staff').select('*').order('created_at', { ascending: false }),
    loadUsers(),
  ]);
  if (error) throw error;
  state.staff = staff;
  const me = state.profile.email;

  return pageHead('Équipe & accès', 'Seules les adresses Gmail listées ici peuvent ouvrir l\'administration, l\'entrepôt Chine et l\'agence Bénin.') +
    '<section class="card" style="margin-bottom:20px"><h2 class="card__title">Autoriser une adresse Gmail</h2>' +
    '<p class="card__sub" style="margin-bottom:14px">La personne se connecte ensuite avec Google : aucun mot de passe à créer.</p>' +
    '<form class="inline-form" id="staff-form">' +
      '<label class="field"><span class="field__label">Adresse Gmail *</span><input class="input" type="email" name="email" required placeholder="prenom.nom@gmail.com" autocomplete="off"></label>' +
      '<label class="field"><span class="field__label">Rôle *</span><select class="select" name="role">' + options(STAFF_ROLES, 'china_staff') + '</select></label>' +
      '<label class="field"><span class="field__label">Nom (facultatif)</span><input class="input" name="full_name" maxlength="80"></label>' +
      '<button class="btn btn--primary" type="submit">' + icon('plusSimple', 18) + ' Autoriser</button></form></section>' +
    (staff.length
      ? '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Adresse Gmail</th><th>Rôle</th><th>Connexion</th><th>Accès</th><th></th></tr></thead><tbody>' +
        staff.map((s) => {
          const u = state.users.find((x) => x.email === s.email);
          const self = s.email === me;
          return '<tr><td><div class="person"><span class="person__text"><strong>' + esc(s.email) + '</strong><small>' + esc(s.full_name || u?.full_name || '') + (self ? ' · vous' : '') + '</small></span></div></td>' +
            '<td><select class="select" data-staff-role="' + s.id + '" aria-label="Rôle"' + (self ? ' disabled' : '') + '>' + options(STAFF_ROLES, s.role) + '</select></td>' +
            '<td>' + (u ? '<span class="tag tag--ok">Déjà connecté</span>' : '<span class="tag">Jamais connecté</span>') + '</td>' +
            '<td>' + switchHtml('active', s.active, s.active ? 'Actif' : 'Désactivé', self).replace('<input', '<input data-staff-active="' + s.id + '"') + '</td>' +
            '<td><div class="row-actions"><button class="btn btn--danger-ghost" type="button" data-staff-del="' + s.id + '"' + (self ? ' disabled' : '') + ' aria-label="Retirer l\'accès">' + icon('trash', 16) + '</button></div></td></tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('shield', 'Aucune adresse autorisée', 'Ajoutez les Gmail de vos employés ci-dessus.'));
}

function mountTeam(view) {
  const reload = () => router.refresh({ keepScroll: true });

  $('#staff-form', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const email = String(fd.get('email')).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Adresse email invalide.', 'error');
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Ajout…');
    const { error } = await supabase.from('authorized_staff').insert({
      email, role: fd.get('role'), full_name: textOrNull(fd.get('full_name')),
    });
    setBusy(btn, false);
    if (error) return toast(error.code === '23505' ? 'Cette adresse est déjà dans la liste.' : friendlyError(error), 'error');
    toast(email + ' autorisé', 'success');
    reload();
  });

  on(view, 'change', '[data-staff-role]', async (el) => {
    const { error } = await supabase.from('authorized_staff').update({ role: el.value }).eq('id', el.dataset.staffRole);
    if (error) { toast(friendlyError(error), 'error'); return reload(); }
    toast('Rôle mis à jour : effet immédiat', 'success');
  });

  on(view, 'change', '[data-staff-active]', async (el) => {
    const { error } = await supabase.from('authorized_staff').update({ active: el.checked }).eq('id', el.dataset.staffActive);
    if (error) { toast(friendlyError(error), 'error'); return reload(); }
    toast(el.checked ? 'Accès réactivé' : 'Accès suspendu : la personne devient simple client', 'success');
    reload();
  });

  on(view, 'click', '[data-staff-del]', async (el) => {
    const s = state.staff.find((x) => x.id === el.dataset.staffDel);
    if (!s) return;
    if (!await askConfirm({
      title: 'Retirer cet accès ?',
      message: s.email + ' perdra immédiatement son accès (rôle : ' + ROLE_LABELS[s.role] + ') et redeviendra simple client.',
      confirmLabel: 'Retirer', danger: true })) return;
    const { error } = await supabase.from('authorized_staff').delete().eq('id', s.id);
    if (error) return toast(friendlyError(error), 'error');
    toast('Accès retiré', 'success');
    reload();
  });
}


/* =====================================================================
 * 12. CLIENTS, LITIGES, JOURNAL ET DÉMARRAGE
 * ===================================================================== */

/* ----- Clients ----- */
function clientsTableHtml() {
  const q = ui.clientQuery.trim().toLowerCase();
  const counts = {};
  state.packages.forEach((p) => { counts[p.client_id] = (counts[p.client_id] || 0) + 1; });
  const list = state.users.filter((u) => u.role === 'client' &&
    (!q || [u.full_name, u.email, u.phone].some((v) => (v || '').toLowerCase().includes(q))));

  if (!list.length) return emptyState('user', 'Aucun client', q ? 'Aucun résultat pour cette recherche.' : 'Les clients apparaissent à leur première connexion Google.');
  return '<p class="result-count">' + list.length + ' client' + (list.length > 1 ? 's' : '') + '</p>' +
    '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Client</th><th>Téléphone</th><th class="t-right">Colis</th><th>Inscrit le</th><th>Compte</th></tr></thead><tbody>' +
    list.map((u) => '<tr><td><div class="person">' +
      '<img class="avatar" alt="" ' + (u.avatar_url ? 'src="' + esc(u.avatar_url) + '"' : '') + ' referrerpolicy="no-referrer">' +
      '<span class="person__text"><strong>' + esc(u.full_name || 'Sans nom') + '</strong><small>' + esc(u.email) + '</small></span></div></td>' +
      '<td>' + esc(u.phone || '—') + '</td><td class="t-right t-strong">' + (counts[u.id] || 0) + '</td><td>' + formatDate(u.created_at) + '</td>' +
      '<td>' + switchHtml('active', u.active, u.active ? 'Actif' : 'Bloqué').replace('<input', '<input data-user-active="' + u.id + '"') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

async function renderClients() {
  await load(loadUsers, loadPackages);
  return pageHead('Clients', 'Comptes créés automatiquement à la première connexion Google.') +
    '<div class="filters filters--tight"><div class="input-group">' + icon('search', 18) +
    '<input class="input" id="client-q" type="search" placeholder="Nom, email, téléphone…" value="' + esc(ui.clientQuery) + '" aria-label="Rechercher un client"></div></div>' +
    '<div id="clients-table">' + clientsTableHtml() + '</div>';
}

function mountClients(view) {
  $('#client-q', view).addEventListener('input', debounce((e) => {
    ui.clientQuery = e.target.value;
    $('#clients-table', view).innerHTML = clientsTableHtml();
  }, 200));

  on(view, 'change', '[data-user-active]', async (el) => {
    const u = userById(el.dataset.userActive);
    if (!u) return;
    if (!el.checked && !await askConfirm({
      title: 'Bloquer ce client ?', message: (u.full_name || u.email) + ' ne pourra plus accéder à son espace tant que le compte est bloqué.',
      confirmLabel: 'Bloquer', danger: true })) { el.checked = true; return; }
    const { error } = await supabase.from('users').update({ active: el.checked }).eq('id', u.id);
    if (error) { el.checked = !el.checked; return toast(friendlyError(error), 'error'); }
    u.active = el.checked;
    toast(el.checked ? 'Compte réactivé' : 'Compte bloqué', 'success');
    $('#clients-table', view).innerHTML = clientsTableHtml();
  });
}

/* ----- Litiges ----- */
async function renderDisputes() {
  const { data, error } = await supabase.from('disputes')
    .select('*, client:users!opened_by(full_name,email), pkg:packages(reference,supplier_tracking)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  state.disputes = data;

  const f = ui.disputeFilter;
  const list = data.filter((d) => f === 'all' || (f === 'open' ? ['open', 'in_review'].includes(d.status) : d.status === f));
  const chips = { open: 'À traiter', resolved: 'Résolus', rejected: 'Rejetés', all: 'Tous' };

  return pageHead('Litiges', 'Signalements ouverts par les clients sur leurs colis.') +
    '<div class="chips" id="disp-chips" style="margin-bottom:14px">' + Object.entries(chips).map(([k, l]) =>
      '<button class="chip" type="button" data-disp-filter="' + k + '" aria-pressed="' + (f === k) + '">' + l +
      '<span class="chip__count">' + data.filter((d) => k === 'all' || (k === 'open' ? ['open', 'in_review'].includes(d.status) : d.status === k)).length + '</span></button>').join('') + '</div>' +
    (list.length
      ? '<div class="stack">' + list.map((d) =>
        '<article class="dispute"><div class="dispute__top"><strong>' + esc(d.subject) + '</strong><span class="badge badge--' + d.status + '">' + esc(DISPUTE_STATUS_LABELS[d.status]) + '</span></div>' +
        '<small class="muted">' + esc(d.client?.full_name || d.client?.email || 'Client') + ' · Colis ' + esc(d.pkg?.reference || '—') + ' · ' + formatDate(d.created_at, true) + '</small>' +
        (d.description ? '<p>' + esc(d.description) + '</p>' : '') +
        (d.resolution ? '<div class="alert alert--success">' + icon('checkCircle') + '<span><strong>Réponse :</strong> ' + esc(d.resolution) + '</span></div>' : '') +
        '<div><button class="btn btn--ghost btn--sm" type="button" data-disp="' + d.id + '">' + (['open', 'in_review'].includes(d.status) ? 'Traiter' : 'Modifier') + '</button></div></article>').join('') + '</div>'
      : emptyState('checkCircle', 'Aucun litige ici', 'Rien à traiter pour ce filtre.'));
}

function mountDisputes(view) {
  on(view, 'click', '[data-disp-filter]', (el) => { ui.disputeFilter = el.dataset.dispFilter; router.refresh({ keepScroll: true }); });
  on(view, 'click', '[data-disp]', (el) => {
    const d = state.disputes.find((x) => x.id === el.dataset.disp);
    if (!d) return;
    openModal('Traiter le litige',
      '<div class="callout">' + icon('user', 18) + '<span><strong>' + esc(d.client?.full_name || 'Client') + '</strong> · ' + esc(d.client?.email || '') + ' · Colis ' + esc(d.pkg?.reference || '—') + '</span></div>' +
      '<div><strong>' + esc(d.subject) + '</strong><p class="muted" style="white-space:pre-wrap">' + esc(d.description || 'Pas de détails.') + '</p></div>' +
      '<form class="form" id="disp-form">' +
        '<label class="field"><span class="field__label">Statut</span><select class="select" name="status">' + options(DISPUTE_STATUS_LABELS, d.status) + '</select></label>' +
        '<label class="field"><span class="field__label">Réponse au client</span><textarea class="textarea" name="resolution" maxlength="1000">' + esc(d.resolution || '') + '</textarea>' +
          '<span class="field__hint">Visible par le client dans « Discuter avec nous ».</span></label>' +
        '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="disp-cancel">Fermer</button><button type="submit" class="btn btn--primary">Enregistrer</button></div></form>',
      { kind: 'dispute' });
    $('#disp-cancel').addEventListener('click', closeModal);
    $('#disp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('[type="submit"]');
      setBusy(btn, true, 'Enregistrement…');
      const { error } = await supabase.from('disputes')
        .update({ status: fd.get('status'), resolution: textOrNull(fd.get('resolution')) }).eq('id', d.id);
      setBusy(btn, false);
      if (error) return toast(friendlyError(error), 'error');
      closeModal();
      toast('Litige mis à jour', 'success');
      refreshDisputeBadge();
      router.refresh({ keepScroll: true });
    });
  });
}

/* ----- Journal d'audit ----- */
async function renderLogs() {
  let query = supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(ui.logLimit);
  if (ui.logEntity) query = query.eq('entity_type', ui.logEntity);
  const { data, error } = await query;
  if (error) throw error;

  return pageHead('Journal d\'audit', 'Trace de chaque création, modification et changement de statut (non modifiable).') +
    '<div class="filters filters--tight"><select class="select" id="log-entity" aria-label="Type d\'élément">' +
      options(ENTITY_LABELS, ui.logEntity, 'Tous les éléments') + '</select></div>' +
    (data.length
      ? '<div class="log-list">' + data.map((l) =>
        '<div class="log-item"><span class="log-item__when">' + formatDate(l.created_at, true) + '</span><span class="log-item__what"><strong>' +
        esc(ENTITY_LABELS[l.entity_type] || l.entity_type) + ' · ' + esc(ACTION_LABELS[l.action] || l.action) + '</strong>' +
        '<small>' + esc(logSummary(l)) + '</small><small>Par ' + esc(l.actor_email || 'système') + (l.actor_role ? ' (' + esc(ROLE_LABELS[l.actor_role] || l.actor_role) + ')' : '') + '</small></span></div>').join('') + '</div>' +
        (data.length >= ui.logLimit ? '<div class="more-row"><button class="btn btn--ghost" type="button" id="log-more">Charger plus</button></div>' : '')
      : emptyState('list', 'Journal vide', 'Les actions apparaîtront ici dès les premières modifications.'));
}

function mountLogs(view) {
  $('#log-entity', view).addEventListener('change', (e) => { ui.logEntity = e.target.value; ui.logLimit = 100; router.refresh({ keepScroll: true }); });
  on(view, 'click', '#log-more', () => { ui.logLimit += 100; router.refresh({ keepScroll: true }); });
}

/* ----- Temps réel ----- */
const onLiveChange = debounce(async () => {
  refreshDisputeBadge();
  const id = router.route.id;
  if (['overview', 'finance', 'shipments', 'disputes'].includes(id)) {
    if (!$('#modal').open) router.refresh({ keepScroll: true });          // jamais sous un formulaire ouvert
  } else if (id === 'packages' && !$('#modal').open) {
    await loadPackages().catch(() => {});
    const box = $('#pkg-table');
    if (box) box.innerHTML = packagesTableHtml();
  }
}, 700);

/* ----- Démarrage ----- */
async function bootAdmin(profile) {
  state.profile = profile;

  renderNav(NAV_GROUPS, SECTIONS);
  bindDrawer();
  bindModalBasics();

  // Nom de l'entreprise dans l'en-tête (paramètre géré dans « Paramètres »)
  supabase.from('app_settings').select('value').eq('key', 'company_name').maybeSingle().then(({ data }) => {
    if (!data?.value) return;
    state.settingsName = data.value;
    $$('.js-company').forEach((el) => (el.textContent = data.value));
    document.title = 'Administration — ' + data.value;
  });

  router = createRouter({
    sections: SECTIONS,
    defaultId: 'overview',
    onChange: (id) => highlightNav(id),
  });

  ['packages', 'shipments', 'disputes'].forEach((t) => subscribeToTable(t, onLiveChange));
  refreshDisputeBadge();

  if (!location.hash) history.replaceState(null, '', '#/overview');
  await router.navigate();
}

initPage({ allowedRoles: [ROLES.ADMIN], onReady: bootAdmin });
