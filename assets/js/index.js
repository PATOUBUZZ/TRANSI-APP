/* =====================================================================
 *  index.js  |  Interface CLIENT : Single Page Application (SPA)
 * =====================================================================
 *  Aucune section ne recharge la page : le routeur (hash #/section)
 *  charge les données avec fetch/async/await (Supabase), génère le HTML
 *  de la section et l'injecte dans <main id="view">.
 *
 *  Plan du fichier :
 *   1. Imports & état            8. Sections : Accueil
 *   2. Icônes SVG                9. Sections : Mes colis (+ détail / suivi)
 *   3. Utilitaires UI           10. Sections : Déclarer un colis
 *   4. Accès aux données        11. Sections : Tarifs & Calcul de fret
 *   5. En-tête, bandeau, menu   12. Sections : Factures
 *   6. Modales                  13. Sections : Annonces, Adresses, Contact, Profil
 *   7. Routeur                  14. Temps réel & démarrage
 * ===================================================================== */


/* =====================================================================
 * 1. IMPORTS & ÉTAT
 * ===================================================================== */
import {
  supabase, initPage, signOut, subscribeToTable, getPhotoUrls,
  escapeHtml as esc, friendlyError, formatMoney, formatDate, formatWeight,
  formatVolume, statusLabel, modeLabel, statusBadge, debounce, toast,
} from './plateforms.js';

import {
  APP, ROLES, STATUS_ORDER, STATUS_DATE_FIELD, SHIPPING_MODES,
  PAYMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS, DISPUTE_STATUS_LABELS,
  SHIPMENT_STATUS_LABELS, SHIPMENT_KIND_LABELS,
} from './config.js';

/** Données chargées depuis Supabase (source de vérité côté navigateur) */
const state = {
  profile: null,
  packages: [],        // colis du client (RLS : uniquement les siens)
  rates: {},           // { air: {...}, sea: {...} } tarifs actifs
  ratesAt: 0,          // horodatage du dernier chargement des tarifs
  settings: {},        // paramètres gérés par l'admin (app_settings)
  announcements: [],   // annonces actives (bandeau + page infos)
  disputes: [],        // litiges ouverts par le client
};

/** État de l'interface (conservé quand une section est ré-affichée) */
const ui = {
  current: null,       // id de la section affichée
  params: {},          // paramètres de l'URL (#/chat?pkg=...)
  pkgFilter: 'all',
  pkgQuery: '',
  calcMode: 'air',
};

/** Valeurs de repli si app_settings est vide ou indisponible */
const DEFAULT_SETTINGS = {
  company_name: APP.name,
  whatsapp_number: '',
  support_phone: '',
  support_email: '',
  china_address: 'L\'adresse de l\'entrepôt en Chine sera bientôt disponible.',
  benin_address: 'L\'adresse de l\'agence au Bénin sera bientôt disponible.',
  benin_hours: '',
  air_delay: '',
  sea_delay: '',
  rates_note: 'Tarifs indicatifs : le montant final est calculé après pesée et mesure à l\'entrepôt en Chine.',
};
const setting = (key) => state.settings[key] || DEFAULT_SETTINGS[key] || '';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Statuts considérés « en cours » (ni disponible, ni livré) */
const IN_PROGRESS = ['declared', 'received_china', 'in_transit', 'arrived_benin'];


/* =====================================================================
 * 2. ICÔNES SVG (style Feather, héritent de currentColor)
 * ===================================================================== */
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  plus: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  plusSimple: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8.01" y2="10"/><line x1="12" y1="10" x2="12.01" y2="10"/><line x1="16" y1="10" x2="16.01" y2="10"/><line x1="8" y1="14" x2="8.01" y2="14"/><line x1="12" y1="14" x2="12.01" y2="14"/><line x1="16" y1="14" x2="16.01" y2="14"/><line x1="8" y1="18" x2="16" y2="18"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  megaphone: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plane: '<path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  ship: '<path d="M2 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M4 14l2-8h12l2 8"/><path d="M12 6V2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  card: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
};

/** Retourne le SVG d'une icône : icon('home', 20) */
const icon = (name, size = 20) =>
  '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  (ICONS[name] || '') + '</svg>';


/* =====================================================================
 * 3. UTILITAIRES UI
 * ===================================================================== */

/** Convertit un champ saisi en nombre (accepte la virgule décimale). */
const num = (v) => parseFloat(String(v ?? '').replace(',', '.')) || 0;

/** Nombre lisible : 1234.5 -> « 1 234,5 » */
const fmtNum = (n, digits = 2) =>
  Number(n).toLocaleString(APP.locale, { maximumFractionDigits: digits });

const firstName = () => (state.profile.full_name || '').split(' ')[0] || '';

/** En-tête de page : titre, sous-titre et actions facultatives */
function pageHead(title, sub = '', actions = '') {
  return '<div class="page-head"><div><h1 class="page-title">' + esc(title) + '</h1>' +
    (sub ? '<p class="page-sub">' + esc(sub) + '</p>' : '') + '</div>' + actions + '</div>';
}

/** État vide : icône + message + action facultative */
function emptyState(iconName, title, text, actionHtml = '') {
  return '<div class="empty"><span class="empty__icon">' + icon(iconName, 26) + '</span>' +
    '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' + actionHtml + '</div>';
}

/** Squelette de chargement affiché pendant l'attente des données */
const skeleton = () =>
  '<div class="skeleton skeleton--title"></div><div class="skeleton-grid">' +
  '<div class="skeleton skeleton--card"></div>'.repeat(4) + '</div>';

/** Active / désactive un bouton pendant une requête */
const busyHtml = new WeakMap();   // mémorise le contenu d'origine du bouton (icône comprise)

function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
  if (busy) {
    if (!busyHtml.has(btn)) busyHtml.set(btn, btn.innerHTML);
    if (label) btn.textContent = label;
  } else if (busyHtml.has(btn)) {
    btn.innerHTML = busyHtml.get(btn);
    busyHtml.delete(btn);
  }
}

/** Copie un texte dans le presse-papiers */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié dans le presse-papiers', 'success', 2200);
  } catch {
    toast('Copie impossible : sélectionnez le texte manuellement.', 'error');
  }
}

/** Numéro WhatsApp nettoyé (chiffres uniquement) */
const waNumber = () => setting('whatsapp_number').replace(/\D/g, '');

/** Lien WhatsApp avec un message pré-rempli */
function waLink(extra = '') {
  const text = 'Bonjour, je suis ' + (state.profile.full_name || state.profile.email) +
    ' (' + state.profile.email + ').' + (extra ? ' ' + extra : '');
  return 'https://wa.me/' + waNumber() + '?text=' + encodeURIComponent(text);
}


/* =====================================================================
 * 4. ACCÈS AUX DONNÉES (Supabase) — la RLS filtre côté serveur
 * ===================================================================== */

async function loadPackages() {
  const { data, error } = await supabase
    .from('packages').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  state.packages = data;
}

/** Tarifs actifs, rechargés au plus toutes les 60 s */
async function loadRates(force = false) {
  if (!force && Date.now() - state.ratesAt < 60000 && Object.keys(state.rates).length) return;
  const { data, error } = await supabase.from('rates').select('*').eq('active', true);
  if (error) throw error;
  state.rates = Object.fromEntries(data.map((r) => [r.mode, r]));
  state.ratesAt = Date.now();
}

async function loadSettings() {
  const { data, error } = await supabase.from('app_settings').select('key, value');
  if (error) throw error;
  state.settings = Object.fromEntries(data.map((s) => [s.key, s.value]));
}

async function loadAnnouncements() {
  const { data, error } = await supabase
    .from('announcements').select('*')
    .order('sort_order', { ascending: true }).order('created_at', { ascending: false });
  if (error) throw error;
  state.announcements = data;
}

async function loadDisputes() {
  const { data, error } = await supabase
    .from('disputes').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  state.disputes = data;
}

/** Ajoute ou remplace un colis dans l'état local (sans doublon) */
function upsertPackage(pkg) {
  const i = state.packages.findIndex((p) => p.id === pkg.id);
  if (i >= 0) state.packages[i] = pkg; else state.packages.unshift(pkg);
}

const findPackage = (id) => state.packages.find((p) => p.id === id);

/** Estimation du fret : quantité (kg ou m³) x tarif actif du mode */
function estimateFreight(mode, quantity) {
  const rate = state.rates[mode]?.price_per_unit;
  if (rate == null || !(quantity > 0)) return null;
  return Math.round(quantity * rate);
}


/* =====================================================================
 * 5. EN-TÊTE, BANDEAU D'ANNONCES, MENU
 * ===================================================================== */

/** Nom de l'entreprise (géré par l'admin) dans l'en-tête et l'onglet */
function applyBranding() {
  const name = setting('company_name');
  $$('.js-company').forEach((el) => (el.textContent = name));
  document.title = 'Espace Client — ' + name;
}

/** Adapte --topbar-h à la hauteur réelle (en-tête + bandeau éventuel) */
function syncTopbar() {
  document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px');
}

/** Bandeau défilant : annonces de type 'ticker' (modifiables depuis l'admin) */
function renderTicker() {
  const ticker = $('#ticker');
  const items = state.announcements.filter((a) => a.kind === 'ticker');

  if (!items.length) {
    ticker.hidden = true;
    return syncTopbar();
  }

  const group = items.map((a) =>
    '<span class="ticker__item">' + icon('megaphone', 15) + esc(a.message) + '</span>').join('');
  // Deux groupes identiques => défilement infini sans coupure
  $('#ticker-track').innerHTML =
    '<div class="ticker__group">' + group + '</div>' +
    '<div class="ticker__group" aria-hidden="true">' + group + '</div>';

  ticker.hidden = false;
  syncTopbar();

  // Vitesse constante (~60 px/s) quelle que soit la longueur des annonces
  requestAnimationFrame(() => {
    const width = $('.ticker__group').scrollWidth;
    $('#ticker-track').style.setProperty('--ticker-duration', Math.max(18, width / 60) + 's');
  });
}

/** Sections de l'application (voir routeur ci-dessous) */
const SECTIONS = {
  dashboard:     { label: 'Accueil',            icon: 'home',      render: renderDashboard },
  declare:       { label: 'Enregistrer un colis', icon: 'plus',    render: renderDeclare,   mount: mountDeclare },
  packages:      { label: 'Mes colis & suivi',  icon: 'package',   render: renderPackages,  mount: mountPackages },
  invoices:      { label: 'Factures',           icon: 'file',      render: renderInvoices,  mount: mountInvoices },
  rates:         { label: 'Tarifs',             icon: 'tag',       render: renderRates },
  calculator:    { label: 'Calcul de fret',     icon: 'calc',      render: renderCalculator, mount: mountCalculator },
  announcements: { label: 'Infos & annonces',   icon: 'megaphone', render: renderAnnouncements },
  address:       { label: 'Nos adresses',       icon: 'pin',       render: renderAddress },
  chat:          { label: 'Discuter avec nous', icon: 'chat',      render: renderChat,      mount: mountChat },
  profile:       { label: 'Mon profil',         icon: 'user',      render: renderProfile,   mount: mountProfile },
};

/** Construit le menu latéral et la barre du bas */
function buildNav() {
  const groups = [
    ['Mon espace', ['dashboard', 'declare', 'packages', 'invoices']],
    ['Tarifs & outils', ['rates', 'calculator']],
    ['Infos & contact', ['announcements', 'address', 'chat']],
    ['Compte', ['profile']],
  ];
  $('#nav').innerHTML = groups.map(([title, ids]) =>
    '<div class="nav-group"><p class="nav-group__title">' + title + '</p>' +
    ids.map((id) =>
      '<a class="nav-link" href="#/' + id + '" data-nav="' + id + '">' + icon(SECTIONS[id].icon) +
      '<span>' + SECTIONS[id].label + '</span><span class="nav-badge" data-badge="' + id + '" hidden></span></a>'
    ).join('') + '</div>').join('');

  $('#bottom-nav').innerHTML =
    bottomItem('dashboard', 'Accueil') +
    bottomItem('packages', 'Colis') +
    '<a class="bottom-nav__item bottom-nav__item--fab" href="#/declare" data-nav="declare" aria-label="Enregistrer un colis">' +
      '<span class="bottom-nav__fab">' + icon('plusSimple', 24) + '</span></a>' +
    bottomItem('calculator', 'Fret') +
    '<button type="button" class="bottom-nav__item" id="btn-more">' + icon('menu') + 'Menu</button>';
}

function bottomItem(id, label) {
  return '<a class="bottom-nav__item" href="#/' + id + '" data-nav="' + id + '">' + icon(SECTIONS[id].icon) +
    '<span>' + label + '</span>' +
    (id === 'packages' ? '<i class="bottom-nav__dot" data-badge-dot hidden></i>' : '') + '</a>';
}

/** Met en évidence la section courante dans les deux menus */
function highlightNav(id) {
  $$('[data-nav]').forEach((a) => {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** Pastille : nombre de colis disponibles à l'agence */
function updateBadges() {
  const ready = state.packages.filter((p) => p.status === 'available_agency').length;
  const badge = $('[data-badge="packages"]');
  if (badge) { badge.textContent = ready; badge.hidden = !ready; }
  const dot = $('[data-badge-dot]');
  if (dot) dot.hidden = !ready;
}

/** Tiroir du menu (mobile) */
function toggleDrawer(open) {
  $('#sidebar').classList.toggle('is-open', open);
  $('#overlay').hidden = !open;
  $('#btn-menu').setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
}

/** Écouteurs globaux de la coque (menu, clics délégués, redimensionnement) */
function bindShell() {
  $('#btn-menu').addEventListener('click', () => toggleDrawer(true));
  $('#overlay').addEventListener('click', () => toggleDrawer(false));
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-more')) toggleDrawer(true);
    if (e.target.closest('#sidebar a')) toggleDrawer(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleDrawer(false); });
  window.addEventListener('resize', debounce(() => { syncTopbar(); if (innerWidth >= 1024) toggleDrawer(false); }, 150));

  // Clics délégués dans la zone dynamique (valable pour toutes les sections)
  $('#view').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-pkg]');
    if (open) return openPackageModal(open.dataset.openPkg);
    const copy = e.target.closest('[data-copy]');
    if (copy) return copyText(copy.dataset.copy);
    const inv = e.target.closest('[data-invoice]');
    if (inv) return printInvoice(findPackage(inv.dataset.invoice));
  });
}


/* =====================================================================
 * 6. MODALES (détail colis, confirmation)
 * ===================================================================== */
const modal = () => $('#modal');

function openModal(title, bodyHtml, pkgId = '', mode = 'view') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  modal().dataset.pkg = pkgId;
  modal().dataset.mode = mode;
  if (!modal().open) modal().showModal();
}

function closeModal() {
  if (modal().open) modal().close();
  modal().dataset.pkg = '';
}

/** Confirmation : retourne une Promise<boolean> */
function askConfirm({ title, message, confirmLabel = 'Confirmer', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = message;
    const ok = $('#confirm-ok');
    ok.textContent = confirmLabel;
    ok.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

function bindModals() {
  $('#modal-close').addEventListener('click', closeModal);
  // Clic sur le fond sombre = fermeture
  modal().addEventListener('click', (e) => { if (e.target === modal()) closeModal(); });
  modal().addEventListener('close', () => { modal().dataset.pkg = ''; });

  // Actions à l'intérieur de la fiche colis
  $('#modal-body').addEventListener('click', async (e) => {
    if (e.target.closest('a[href^="#/"]')) return closeModal();      // lien vers une autre section
    const act = e.target.closest('[data-act]')?.dataset.act;
    const pkg = findPackage(modal().dataset.pkg);
    if (!act || !pkg) return;

    if (act === 'edit') showPackageModal(pkg, 'edit');
    if (act === 'back') showPackageModal(pkg, 'view');
    if (act === 'cancel') {
      const ok = await askConfirm({
        title: 'Annuler ce colis ?',
        message: 'Le colis ' + pkg.reference + ' sera supprimé de votre liste. Cette action est définitive.',
        confirmLabel: 'Supprimer', danger: true,
      });
      if (!ok) return;
      const { error } = await supabase.from('packages').delete().eq('id', pkg.id);
      if (error) return toast(friendlyError(error), 'error');
      state.packages = state.packages.filter((p) => p.id !== pkg.id);
      closeModal(); updateBadges(); renderCurrent({ keepScroll: true });
      toast('Colis supprimé', 'success');
    }
  });

  // Enregistrement de la modification d'un colis
  $('#modal-body').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const pkg = findPackage(modal().dataset.pkg);
    if (!pkg || form.id !== 'edit-form') return;
    const fd = new FormData(form);
    const tracking = String(fd.get('tracking')).replace(/\s+/g, '').toUpperCase();
    if (tracking.length < 6) return toast('Le numéro de suivi semble trop court.', 'error');

    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const { data, error } = await supabase.from('packages').update({
      supplier_tracking: tracking,
      description: String(fd.get('description')).trim() || null,
      shipping_mode: fd.get('mode'),
    }).eq('id', pkg.id).select().single();
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');

    upsertPackage(data);
    showPackageModal(data, 'view');
    renderCurrent({ keepScroll: true });
    toast('Colis mis à jour', 'success');
  });
}


/* =====================================================================
 * 7. ROUTEUR : chargement dynamique des sections, sans rechargement
 *    URL : #/section  ou  #/section?cle=valeur
 * ===================================================================== */
let navToken = 0;   // protège contre les réponses tardives d'une navigation précédente

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, query = ''] = raw.split('?');
  return { id: SECTIONS[id] ? id : 'dashboard', params: Object.fromEntries(new URLSearchParams(query)) };
}

/** Charge et affiche la section demandée par l'URL */
async function navigate() {
  const { id, params } = parseRoute();
  ui.current = id;
  ui.params = params;
  // Arrivée sur « Mes colis » depuis le menu : on repart d'une liste complète
  if (id === 'packages' && !params.filter) { ui.pkgFilter = 'all'; ui.pkgQuery = ''; }
  highlightNav(id);
  toggleDrawer(false);

  $('#view').innerHTML = skeleton();
  await renderCurrent({ keepScroll: false });
}

/**
 * (Re)génère la section courante.
 *   keepScroll = true  -> mise à jour discrète (temps réel), sans squelette
 */
async function renderCurrent({ keepScroll = false } = {}) {
  const token = ++navToken;
  const section = SECTIONS[ui.current];
  const view = $('#view');
  const scrollY = window.scrollY;

  try {
    const html = await section.render(ui.params);        // fetch + génération du HTML
    if (token !== navToken) return;                       // une autre navigation a pris le relais
    view.innerHTML = html;
    if (section.mount) await section.mount(view, ui.params);
  } catch (err) {
    if (token !== navToken) return;
    console.error('[section ' + ui.current + ']', err);
    view.innerHTML = '<div class="alert alert--error">' + icon('alert') +
      '<span>' + esc(friendlyError(err)) + '</span>' +
      '<button class="btn btn--ghost btn--sm" id="btn-retry" type="button">Réessayer</button></div>';
    $('#btn-retry')?.addEventListener('click', () => navigate());
  }

  if (!keepScroll) { window.scrollTo(0, 0); view.focus({ preventScroll: true }); }
  else window.scrollTo(0, scrollY);
}


/* =====================================================================
 * 8. SECTION : ACCUEIL (tableau de bord)
 * ===================================================================== */

function kpi(iconName, label, value, href, tone = '') {
  return '<a class="kpi ' + (tone ? 'kpi--' + tone : '') + '" href="' + href + '">' +
    '<span class="kpi__icon">' + icon(iconName, 22) + '</span>' +
    '<span><span class="kpi__value">' + value + '</span><br><span class="kpi__label">' + esc(label) + '</span></span></a>';
}

async function renderDashboard() {
  const all = state.packages;
  const inProgress = all.filter((p) => IN_PROGRESS.includes(p.status));
  const ready = all.filter((p) => p.status === 'available_agency');
  const delivered = all.filter((p) => p.status === 'delivered');
  const unpaid = all.filter((p) => p.payment_status === 'unpaid' && p.amount_due != null);
  const totalDue = unpaid.reduce((sum, p) => sum + Number(p.amount_due), 0);
  const recent = [...all].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 5);
  const news = state.announcements.filter((a) => a.kind === 'info').slice(0, 2);

  const readyAlert = ready.length
    ? '<div class="alert alert--warn" style="margin-bottom:16px">' + icon('checkCircle') +
      '<span><strong>' + ready.length + ' colis ' + (ready.length > 1 ? 'sont disponibles' : 'est disponible') +
      '</strong> à l\'agence. Présentez-vous pour le retrait.</span>' +
      '<a class="btn btn--accent btn--sm" href="#/packages?filter=ready">Voir</a></div>'
    : '';

  return '' +
    '<section class="hero">' +
      '<div><h1>Bonjour' + (firstName() ? ' ' + esc(firstName()) : '') + ' 👋</h1>' +
      '<p>Suivez vos colis en temps réel, de l\'entrepôt en Chine jusqu\'à Cotonou.</p></div>' +
      '<div class="hero__actions">' +
        '<a class="btn btn--accent" href="#/declare">' + icon('plusSimple', 18) + ' Enregistrer un colis</a>' +
        '<a class="btn btn--ghost" href="#/calculator">' + icon('calc', 18) + ' Calculer un fret</a>' +
      '</div>' +
    '</section>' +
    '<div style="height:18px"></div>' + readyAlert +
    '<div class="grid grid--4">' +
      kpi('package', 'Colis en cours', inProgress.length, '#/packages?filter=active') +
      kpi('checkCircle', 'Disponibles à l\'agence', ready.length, '#/packages?filter=ready', 'warn') +
      kpi('card', 'Montant à payer', formatMoney(totalDue), '#/invoices', 'accent') +
      kpi('check', 'Colis livrés', delivered.length, '#/packages?filter=delivered', 'success') +
    '</div>' +

    '<h2 class="section-title">Dernières mises à jour <a href="#/packages">Tout voir</a></h2>' +
    (recent.length
      ? '<div class="pkg-list">' + recent.map(packageCard).join('') + '</div>'
      : emptyState('package', 'Aucun colis pour le moment',
          'Enregistrez votre premier colis avec le numéro de suivi de votre fournisseur.',
          '<a class="btn btn--primary" href="#/declare">Enregistrer un colis</a>')) +

    (news.length
      ? '<h2 class="section-title">Infos & annonces <a href="#/announcements">Tout voir</a></h2>' +
        '<div class="stack">' + news.map(newsCard).join('') + '</div>'
      : '') +

    '<h2 class="section-title">Besoin d\'aide ?</h2>' +
    '<div class="grid grid--3">' + contactCards() + '</div>';
}


/* =====================================================================
 * 9. SECTION : MES COLIS & SUIVI
 * ===================================================================== */

const FILTERS = {
  all:       { label: 'Tous',        test: () => true },
  active:    { label: 'En cours',    test: (p) => IN_PROGRESS.includes(p.status) },
  ready:     { label: 'À l\'agence', test: (p) => p.status === 'available_agency' },
  delivered: { label: 'Livrés',      test: (p) => p.status === 'delivered' },
};

/** Carte résumé d'un colis (liste) */
function packageCard(p) {
  const pct = Math.round((STATUS_ORDER.indexOf(p.status) / (STATUS_ORDER.length - 1)) * 100);
  return '<button type="button" class="pkg" data-open-pkg="' + p.id + '">' +
    '<span class="pkg__icon pkg__icon--' + p.shipping_mode + '">' + icon(p.shipping_mode === 'air' ? 'plane' : 'ship', 24) + '</span>' +
    '<span class="pkg__body">' +
      '<span class="pkg__top"><strong class="pkg__ref">' + esc(p.reference) + '</strong>' + statusBadge(p.status) + '</span>' +
      '<span class="pkg__track">' + esc(p.supplier_tracking) + '</span>' +
      (p.description ? '<span class="pkg__desc">' + esc(p.description) + '</span>' : '') +
      '<span class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
      '<span class="pkg__meta"><span>' + modeLabel(p.shipping_mode) + '</span>' +
        '<span>' + (p.amount_due != null ? formatMoney(p.amount_due) : 'Montant après pesée') + '</span>' +
        '<span>Maj ' + formatDate(p.updated_at) + '</span></span>' +
    '</span>' + icon('chevron', 18) + '</button>';
}

/** Liste filtrée selon la pastille active et la recherche */
function packageListHtml() {
  const q = ui.pkgQuery.trim().toLowerCase();
  const list = state.packages.filter((p) =>
    FILTERS[ui.pkgFilter].test(p) &&
    (!q || [p.reference, p.supplier_tracking, p.description].some((v) => (v || '').toLowerCase().includes(q))));

  if (list.length) return list.map(packageCard).join('');
  return state.packages.length
    ? emptyState('search', 'Aucun résultat', 'Aucun colis ne correspond à ce filtre ou à cette recherche.')
    : emptyState('package', 'Aucun colis enregistré',
        'Déclarez votre premier colis avec le numéro de suivi de votre fournisseur.',
        '<a class="btn btn--primary" href="#/declare">Enregistrer un colis</a>');
}

function chipsHtml() {
  return Object.entries(FILTERS).map(([key, f]) =>
    '<button type="button" class="chip" data-filter="' + key + '" aria-pressed="' + (ui.pkgFilter === key) + '">' +
    f.label + '<span class="chip__count">' + state.packages.filter(f.test).length + '</span></button>').join('');
}

async function renderPackages(params) {
  if (params.filter && FILTERS[params.filter]) ui.pkgFilter = params.filter;
  return pageHead('Mes colis & suivi', 'Cliquez sur un colis pour voir son suivi détaillé, en temps réel.',
      '<a class="btn btn--primary" href="#/declare">' + icon('plusSimple', 18) + ' Nouveau colis</a>') +
    '<div class="toolbar">' +
      '<div class="input-group">' + icon('search', 18) +
        '<input class="input" id="pkg-search" type="search" placeholder="Rechercher : référence, suivi, description…" ' +
        'value="' + esc(ui.pkgQuery) + '" aria-label="Rechercher un colis"></div>' +
      '<div class="chips" id="pkg-chips" role="group" aria-label="Filtres">' + chipsHtml() + '</div>' +
    '</div>' +
    '<div class="pkg-list" id="pkg-list">' + packageListHtml() + '</div>';
}

function mountPackages(view) {
  $('#pkg-search', view).addEventListener('input', debounce((e) => {
    ui.pkgQuery = e.target.value;
    $('#pkg-list').innerHTML = packageListHtml();
  }, 200));
  $('#pkg-chips', view).addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    ui.pkgFilter = chip.dataset.filter;
    refreshPackageList();
  });
}

/** Rafraîchit uniquement liste + pastilles (garde le focus de la recherche) */
function refreshPackageList() {
  const list = $('#pkg-list');
  if (!list) return;
  list.innerHTML = packageListHtml();
  $('#pkg-chips').innerHTML = chipsHtml();
}

/* ----- Fiche détaillée d'un colis : frise de suivi, mesures, photos ----- */

function timelineHtml(p) {
  const current = STATUS_ORDER.indexOf(p.status);
  return '<ol class="timeline" aria-label="Étapes du colis">' + STATUS_ORDER.map((s, i) => {
    const done = i <= current;
    const date = p[STATUS_DATE_FIELD[s]];
    return '<li class="timeline__step' + (done ? ' is-done' : '') + (i === current ? ' is-current' : '') + '">' +
      '<span class="timeline__dot">' + (done ? icon('check', 14) : '') + '</span>' +
      '<span class="timeline__text"><strong>' + esc(statusLabel(s)) + '</strong>' +
      '<small>' + (done && date ? formatDate(date, true) : done ? '' : 'En attente') + '</small></span></li>';
  }).join('') + '</ol>';
}

function kvRow(label, valueHtml) {
  return '<div><dt>' + esc(label) + '</dt><dd>' + valueHtml + '</dd></div>';
}

function packageDetailHtml(p) {
  const unit = SHIPPING_MODES[p.shipping_mode]?.unit;
  const canEdit = p.status === 'declared';
  return '' +
    '<div>' + timelineHtml(p) + '</div>' +
    '<div><p class="detail-section-title">Informations</p><dl class="kv">' +
      kvRow('Référence', esc(p.reference)) +
      kvRow('N° de suivi fournisseur', esc(p.supplier_tracking)) +
      (p.description ? kvRow('Description', esc(p.description)) : '') +
      kvRow('Mode d\'expédition', esc(modeLabel(p.shipping_mode))) +
      kvRow('Poids', formatWeight(p.weight_kg)) +
      kvRow('Volume', formatVolume(p.volume_m3)) +
      kvRow('Tarif appliqué', p.rate_applied != null ? formatMoney(p.rate_applied) + ' / ' + unit : '—') +
      kvRow('Montant à payer', '<strong>' + (p.amount_due != null ? formatMoney(p.amount_due) : 'Après pesée') + '</strong>') +
      kvRow('Paiement', '<span class="badge badge--' + p.payment_status + '">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span>' +
        (p.payment_method ? ' ' + esc(PAYMENT_METHOD_LABELS[p.payment_method]) : '')) +
      (p.delivered_to ? kvRow('Retiré par', esc(p.delivered_to)) : '') +
      (p.delivery_note ? kvRow('Note de livraison', esc(p.delivery_note)) : '') +
    '</dl></div>' +
    '<div id="pkg-lot"></div><div id="pkg-photos"></div>' +
    '<div class="modal__actions">' +
      '<a class="btn btn--ghost" href="#/chat?pkg=' + p.id + '">' + icon('alert', 18) + ' Signaler un problème</a>' +
      (canEdit ? '<button type="button" class="btn btn--ghost" data-act="edit">Modifier</button>' +
                 '<button type="button" class="btn btn--danger-ghost" data-act="cancel">Annuler le colis</button>' : '') +
    '</div>';
}

function packageEditHtml(p) {
  return '<form class="form" id="edit-form">' +
    '<label class="field"><span class="field__label">N° de suivi fournisseur</span>' +
      '<input class="input" name="tracking" required minlength="6" value="' + esc(p.supplier_tracking) + '"></label>' +
    '<label class="field"><span class="field__label">Description</span>' +
      '<textarea class="textarea" name="description" maxlength="300">' + esc(p.description || '') + '</textarea></label>' +
    '<label class="field"><span class="field__label">Mode d\'expédition</span>' +
      '<select class="select" name="mode">' +
        Object.entries(SHIPPING_MODES).map(([k, m]) =>
          '<option value="' + k + '"' + (p.shipping_mode === k ? ' selected' : '') + '>' + m.label + '</option>').join('') +
      '</select></label>' +
    '<div class="modal__actions">' +
      '<button type="button" class="btn btn--ghost" data-act="back">Retour</button>' +
      '<button type="submit" class="btn btn--primary">Enregistrer</button></div></form>';
}

function showPackageModal(p, mode = 'view') {
  openModal(mode === 'edit' ? 'Modifier le colis' : p.reference,
    mode === 'edit' ? packageEditHtml(p) : packageDetailHtml(p), p.id, mode);
  if (mode === 'view') hydratePackageModal(p);
}

function openPackageModal(id) {
  const p = findPackage(id);
  if (p) showPackageModal(p);
}

/** Compléments chargés après l'ouverture : lot / vol et photos de l'entrepôt */
async function hydratePackageModal(p) {
  const stillOpen = () => modal().open && modal().dataset.pkg === p.id && modal().dataset.mode === 'view';

  if (p.shipment_id) {
    supabase.from('shipments').select('reference, kind, carrier_ref, eta, status')
      .eq('id', p.shipment_id).maybeSingle().then(({ data }) => {
        const box = $('#pkg-lot');
        if (!data || !box || !stillOpen()) return;
        box.innerHTML = '<p class="detail-section-title">Expédition</p><dl class="kv">' +
          kvRow(SHIPMENT_KIND_LABELS[data.kind] || 'Lot', esc(data.reference)) +
          (data.carrier_ref ? kvRow('Réf. transporteur', esc(data.carrier_ref)) : '') +
          kvRow('Statut du lot', esc(SHIPMENT_STATUS_LABELS[data.status] || data.status)) +
          (data.eta ? kvRow('Arrivée estimée', formatDate(data.eta)) : '') + '</dl>';
      });
  }

  if (p.photos?.length) {
    try {
      const urls = await getPhotoUrls(p.photos);
      const box = $('#pkg-photos');
      if (!box || !stillOpen() || !urls.length) return;
      box.innerHTML = '<p class="detail-section-title">Photos de votre colis</p><div class="photo-grid">' +
        urls.map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) +
          '" alt="Photo du colis ' + esc(p.reference) + '" loading="lazy"></a>').join('') + '</div>';
    } catch (err) { console.warn('[photos]', err); }
  }
}


/* =====================================================================
 * 10. SECTION : ENREGISTRER UN COLIS
 * ===================================================================== */

async function renderDeclare() {
  await loadRates().catch(() => {});
  const choice = (mode, checked) => {
    const m = SHIPPING_MODES[mode];
    const rate = state.rates[mode];
    const delay = setting(mode + '_delay');
    return '<label class="choice"><input type="radio" name="mode" value="' + mode + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="choice__box">' + icon(mode === 'air' ? 'plane' : 'ship', 26) +
      '<span class="choice__title">' + m.label + '</span>' +
      '<span class="choice__meta">' + (rate ? formatMoney(rate.price_per_unit) + ' / ' + m.unit : 'Tarif bientôt disponible') +
      (delay ? ' · ' + esc(delay) : '') + '</span></span></label>';
  };

  return pageHead('Enregistrer un colis', 'Indiquez le numéro de suivi donné par votre fournisseur. Nous le réceptionnerons à l\'entrepôt en Chine.') +
    '<div class="grid grid--2" style="align-items:start">' +
    '<form class="card form" id="declare-form" novalidate>' +
      '<div class="field"><label class="field__label" for="d-tracking">N° de suivi du fournisseur *</label>' +
        '<input class="input" id="d-tracking" name="tracking" required minlength="6" maxlength="60" autocomplete="off" ' +
        'autocapitalize="characters" placeholder="Ex : SF1234567890123">' +
        '<span class="field__hint">Disponible dans votre commande (Alibaba, 1688, Taobao, AliExpress…).</span>' +
        '<span class="field__error" id="d-error" role="alert" hidden></span></div>' +
      '<div class="field"><label class="field__label" for="d-desc">Description du contenu</label>' +
        '<textarea class="textarea" id="d-desc" name="description" maxlength="300" ' +
        'placeholder="Ex : 2 cartons de chaussures, 1 machine à coudre…"></textarea></div>' +
      '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="field__label" style="margin-bottom:8px">Mode d\'expédition *</legend>' +
        '<div class="choice-grid">' + choice('air', true) + choice('sea', false) + '</div></fieldset>' +
      '<button class="btn btn--accent btn--block" type="submit">' + icon('plusSimple', 18) + ' Enregistrer le colis</button>' +
    '</form>' +
    '<aside class="card stack"><h2 class="card__title">Comment ça marche ?</h2>' +
      '<ol class="stack" style="counter-reset:s">' + [
        'Vous commandez chez votre fournisseur et nous donnez le numéro de suivi ici.',
        'À l\'arrivée en Chine, nous pesons, mesurons et photographions votre colis.',
        'Le montant est calculé automatiquement selon notre tarif.',
        'Suivez le transport en temps réel, puis récupérez votre colis à l\'agence de Cotonou.',
      ].map((t, i) => '<li style="display:flex;gap:12px"><span class="kpi__icon" style="width:30px;height:30px;border-radius:50%;font-weight:800;font-size:.85rem">' +
        (i + 1) + '</span><span>' + t + '</span></li>').join('') + '</ol>' +
      '<a class="btn btn--ghost" href="#/address">' + icon('pin', 18) + ' Voir l\'adresse de livraison en Chine</a>' +
    '</aside></div>';
}

function mountDeclare(view) {
  const form = $('#declare-form', view);
  const errorBox = $('#d-error', view);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const tracking = String(fd.get('tracking')).replace(/\s+/g, '').toUpperCase();

    errorBox.hidden = true;
    if (tracking.length < 6) {
      errorBox.textContent = 'Saisissez un numéro de suivi valide (6 caractères minimum).';
      errorBox.hidden = false;
      return $('#d-tracking').focus();
    }

    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const { data, error } = await supabase.from('packages').insert({
      client_id: state.profile.id,
      supplier_tracking: tracking,
      description: String(fd.get('description')).trim() || null,
      shipping_mode: fd.get('mode'),
    }).select().single();
    setBusy(btn, false);

    if (error) {
      errorBox.textContent = friendlyError(error);
      errorBox.hidden = false;
      return;
    }
    upsertPackage(data);
    updateBadges();
    toast('Colis ' + data.reference + ' enregistré ✔', 'success');
    location.hash = '#/packages';
  });
}


/* =====================================================================
 * 11. SECTIONS : TARIFS & CALCUL DE FRET
 * ===================================================================== */

async function renderRates() {
  await loadRates(true);
  const card = (mode) => {
    const m = SHIPPING_MODES[mode];
    const rate = state.rates[mode];
    const delay = setting(mode + '_delay');
    return '<article class="rate-card rate-card--' + mode + '">' + icon(mode === 'air' ? 'plane' : 'ship', 34) +
      '<span class="rate-card__mode">Fret ' + m.label.toLowerCase() + '</span>' +
      '<span class="rate-card__price">' + (rate ? formatMoney(rate.price_per_unit) + ' <small>/ ' + m.unit + '</small>' : '—') + '</span>' +
      (delay ? '<span class="rate-card__delay">' + icon('clock', 15) + ' Délai : ' + esc(delay) + '</span>' : '') + '</article>';
  };

  const examples = (mode, quantities) => {
    const m = SHIPPING_MODES[mode];
    if (!state.rates[mode]) return '';
    return '<div class="table-wrap"><table class="table"><thead><tr><th>' + m.label + ' — quantité</th><th>Estimation</th></tr></thead><tbody>' +
      quantities.map((q) => '<tr><td>' + fmtNum(q) + ' ' + m.unit + '</td><td><strong>' + formatMoney(estimateFreight(mode, q)) + '</strong></td></tr>').join('') +
      '</tbody></table></div>';
  };

  return pageHead('Tarifs', 'Nos tarifs de transport de la Chine vers Cotonou.',
      '<a class="btn btn--primary" href="#/calculator">' + icon('calc', 18) + ' Calculer mon fret</a>') +
    '<div class="grid grid--2">' + card('air') + card('sea') + '</div>' +
    '<p class="muted" style="margin-top:14px">' + esc(setting('rates_note')) + '</p>' +
    '<h2 class="section-title">Exemples d\'estimation</h2>' +
    '<div class="grid grid--2">' + examples('air', [1, 5, 10, 25, 50]) + examples('sea', [0.1, 0.25, 0.5, 1, 2]) + '</div>';
}

async function renderCalculator() {
  await loadRates(true);
  const mode = ui.calcMode;
  const m = SHIPPING_MODES[mode];

  const fields = mode === 'air'
    ? '<div class="field"><label class="field__label" for="c-weight">Poids total (kg)</label>' +
      '<input class="input" id="c-weight" inputmode="decimal" placeholder="Ex : 12,5" autocomplete="off">' +
      '<span class="field__hint">Le poids réel est mesuré à l\'entrepôt en Chine.</span></div>'
    : '<div class="field"><label class="field__label">Dimensions d\'un carton (cm)</label>' +
      '<div class="field-row">' +
        '<input class="input" id="c-l" inputmode="decimal" placeholder="Longueur" aria-label="Longueur en cm">' +
        '<input class="input" id="c-w" inputmode="decimal" placeholder="Largeur" aria-label="Largeur en cm">' +
        '<input class="input" id="c-h" inputmode="decimal" placeholder="Hauteur" aria-label="Hauteur en cm">' +
        '<input class="input" id="c-n" inputmode="numeric" placeholder="Quantité" value="1" aria-label="Nombre de cartons">' +
      '</div></div>' +
      '<div class="divider">ou</div>' +
      '<div class="field"><label class="field__label" for="c-volume">Volume total connu (m³)</label>' +
      '<input class="input" id="c-volume" inputmode="decimal" placeholder="Ex : 0,8" autocomplete="off"></div>';

  return pageHead('Calcul de fret', 'Estimez le coût de transport avant même de commander.') +
    '<div class="tabs" role="tablist" style="margin-bottom:18px">' +
      Object.entries(SHIPPING_MODES).map(([k, mm]) =>
        '<button class="tab" role="tab" type="button" data-calc-mode="' + k + '" aria-selected="' + (mode === k) + '">' +
        icon(k === 'air' ? 'plane' : 'ship', 18) + mm.label + '</button>').join('') + '</div>' +
    '<div class="calc"><form class="card form" id="calc-form" novalidate>' + fields + '</form>' +
    '<aside class="result" aria-live="polite" id="calc-result"><span class="result__label">Estimation</span>' +
    '<span class="result__amount">—</span><p class="result__note">Saisissez vos données pour obtenir une estimation (' + m.unit + ').</p></aside></div>';
}

function mountCalculator(view) {
  $$('[data-calc-mode]', view).forEach((tab) => tab.addEventListener('click', () => {
    ui.calcMode = tab.dataset.calcMode;
    renderCurrent({ keepScroll: true });
  }));

  const form = $('#calc-form', view);
  const update = () => {
    const mode = ui.calcMode;
    const m = SHIPPING_MODES[mode];
    let quantity = 0;
    let detail = '';

    if (mode === 'air') {
      quantity = num($('#c-weight').value);
      detail = fmtNum(quantity) + ' kg';
    } else {
      const direct = num($('#c-volume').value);
      const qty = Math.max(1, Math.round(num($('#c-n').value)) || 1);
      quantity = direct > 0 ? direct : (num($('#c-l').value) * num($('#c-w').value) * num($('#c-h').value) / 1e6) * qty;
      quantity = Math.round(quantity * 10000) / 10000;
      detail = fmtNum(quantity, 4) + ' m³';
    }

    const rate = state.rates[mode]?.price_per_unit;
    const amount = estimateFreight(mode, quantity);
    $('#calc-result').innerHTML = '<span class="result__label">Estimation du fret ' + m.label.toLowerCase() + '</span>' +
      '<span class="result__amount">' + (amount != null ? formatMoney(amount) : '—') + '</span>' +
      (rate == null ? '<p class="result__note">Le tarif ' + m.label.toLowerCase() + ' n\'est pas encore disponible.</p>'
        : quantity > 0
          ? '<dl class="result__lines"><div><dt>Quantité retenue</dt><dd>' + detail + '</dd></div>' +
            '<div><dt>Tarif</dt><dd>' + formatMoney(rate) + ' / ' + m.unit + '</dd></div></dl>' +
            '<p class="result__note">Estimation indicative : le montant final est calculé après pesée à l\'entrepôt.</p>'
          : '<p class="result__note">Saisissez vos données pour obtenir une estimation (' + m.unit + ').</p>');
  };
  form.addEventListener('input', update);
  update();
}


/* =====================================================================
 * 12. SECTION : FACTURES
 * ===================================================================== */

function invoicesList() {
  return state.packages.filter((p) => p.amount_due != null)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

async function renderInvoices() {
  const list = invoicesList();
  const due = list.filter((p) => p.payment_status === 'unpaid').reduce((s, p) => s + Number(p.amount_due), 0);
  const paid = list.filter((p) => p.payment_status === 'paid').reduce((s, p) => s + Number(p.amount_due), 0);

  return pageHead('Factures & paiements', 'Le montant apparaît dès que votre colis a été pesé à l\'entrepôt.') +
    '<div class="invoice-summary">' +
      kpi('card', 'Reste à payer', formatMoney(due), '#/invoices', 'accent') +
      kpi('checkCircle', 'Déjà réglé', formatMoney(paid), '#/invoices', 'success') +
      kpi('file', 'Factures', list.length, '#/invoices') +
    '</div>' +
    (list.length
      ? '<div class="stack" id="invoice-list">' + list.map((p) =>
          '<article class="invoice"><span class="pkg__icon pkg__icon--' + p.shipping_mode + '">' + icon(p.shipping_mode === 'air' ? 'plane' : 'ship', 22) + '</span>' +
          '<div class="invoice__main"><strong>' + esc(p.reference) + '</strong>' +
          '<small class="muted">' + esc(p.supplier_tracking) + ' · ' + (p.weight_kg ? formatWeight(p.weight_kg) : formatVolume(p.volume_m3)) + '</small></div>' +
          '<div style="text-align:right"><div class="invoice__amount">' + formatMoney(p.amount_due) + '</div>' +
          '<span class="badge badge--' + p.payment_status + '">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span></div>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-invoice="' + p.id + '">' + icon('printer', 16) + ' Facture</button></article>').join('') + '</div>'
      : emptyState('file', 'Aucune facture pour le moment',
          'Votre première facture sera générée automatiquement après la pesée de votre colis en Chine.'));
}

function mountInvoices() { /* clics gérés par la délégation globale (data-invoice) */ }

/** Ouvre une facture imprimable (ou enregistrable en PDF) dans un nouvel onglet */
function printInvoice(p) {
  if (!p) return;
  const w = window.open('', '_blank');
  if (!w) return toast('Autorisez les pop-ups pour afficher la facture.', 'error');
  const unit = SHIPPING_MODES[p.shipping_mode].unit;
  const qty = p.shipping_mode === 'air' ? formatWeight(p.weight_kg) : formatVolume(p.volume_m3);
  const row = (a, b) => '<tr><td>' + a + '</td><td style="text-align:right">' + b + '</td></tr>';

  w.document.open();
  w.document.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Facture ' + esc(p.reference) + '</title>' +
    '<style>body{font-family:system-ui,Arial,sans-serif;color:#0f172a;max-width:720px;margin:40px auto;padding:0 20px}' +
    'h1{margin:0}table{width:100%;border-collapse:collapse;margin:24px 0}td{padding:10px 8px;border-bottom:1px solid #e2e8f0}' +
    '.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0b1f4b;padding-bottom:16px}' +
    '.total td{font-size:1.2rem;font-weight:800;border-bottom:0}.muted{color:#64748b}' +
    '.stamp{display:inline-block;padding:4px 12px;border-radius:99px;font-weight:700;background:' +
    (p.payment_status === 'paid' ? '#dcfce7;color:#15803d' : '#fef3c7;color:#b45309') + '}' +
    '@media print{button{display:none}}</style></head><body>' +
    '<div class="head"><div><h1>' + esc(setting('company_name')) + '</h1><p class="muted">Transit & logistique Chine – Bénin</p></div>' +
    '<div style="text-align:right"><h2 style="margin:0">FACTURE</h2><p class="muted">' + esc(p.reference) + '<br>' +
    formatDate(p.paid_at || p.updated_at) + '</p></div></div>' +
    '<p><strong>Client :</strong> ' + esc(state.profile.full_name || '') + '<br><span class="muted">' + esc(state.profile.email) + '</span></p>' +
    '<table>' + row('N° de suivi fournisseur', esc(p.supplier_tracking)) + row('Description', esc(p.description || '—')) +
    row('Mode d\'expédition', esc(modeLabel(p.shipping_mode))) + row('Quantité facturée', qty) +
    row('Tarif', formatMoney(p.rate_applied) + ' / ' + unit) +
    '<tr class="total"><td>Total à payer</td><td style="text-align:right">' + formatMoney(p.amount_due) + '</td></tr></table>' +
    '<p>Statut : <span class="stamp">' + PAYMENT_STATUS_LABELS[p.payment_status] + '</span></p>' +
    '<button onclick="window.print()" style="margin-top:20px;padding:10px 18px;font-size:1rem">Imprimer / Enregistrer en PDF</button>' +
    '</body></html>');
  w.document.close();
}


/* =====================================================================
 * 13. SECTIONS : ANNONCES, ADRESSES, CONTACT, PROFIL
 * ===================================================================== */

function newsCard(a) {
  return '<article class="news"><span class="news__icon">' + icon('megaphone', 22) + '</span><div>' +
    '<h3>' + esc(a.title || 'Annonce') + '</h3><p>' + esc(a.message) + '</p>' +
    '<small>' + formatDate(a.created_at) + '</small></div></article>';
}

async function renderAnnouncements() {
  await loadAnnouncements();
  return pageHead('Infos & annonces', 'Les dernières nouvelles de ' + setting('company_name') + '.') +
    (state.announcements.length
      ? '<div class="stack">' + [...state.announcements].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(newsCard).join('') + '</div>'
      : emptyState('megaphone', 'Aucune annonce pour le moment', 'Les informations importantes (fermetures, nouveaux tarifs…) apparaîtront ici.'));
}

async function renderAddress() {
  await loadSettings().catch(() => {});
  const fill = (txt) => txt.replaceAll('{{name}}', state.profile.full_name || state.profile.email)
                           .replaceAll('{{phone}}', state.profile.phone || '');
  const china = fill(setting('china_address'));
  const benin = setting('benin_address');
  const block = (iconName, title, text, copy = true) =>
    '<article class="card address-card"><div class="address-card__head"><span class="kpi__icon">' + icon(iconName, 20) + '</span>' +
    '<h2 class="card__title" style="margin:0">' + title + '</h2></div><pre class="address-box">' + esc(text) + '</pre>' +
    (copy ? '<button type="button" class="btn btn--ghost" data-copy="' + esc(text) + '">' + icon('copy', 18) + ' Copier l\'adresse</button>' : '') + '</article>';

  return pageHead('Nos adresses', 'Utilisez l\'adresse en Chine comme adresse de livraison chez votre fournisseur.') +
    '<div class="alert" style="margin-bottom:16px">' + icon('alert') +
    '<span>Indiquez toujours <strong>votre nom complet</strong> sur le colis : il nous permet de l\'identifier à l\'arrivée.</span></div>' +
    '<div class="grid grid--2">' + block('plane', 'Entrepôt en Chine', china) +
    block('pin', 'Agence au Bénin (retrait)', benin + (setting('benin_hours') ? '\n\nHoraires : ' + setting('benin_hours') : '')) + '</div>';
}

/** Cartes de contact (réutilisées sur l'accueil et la page contact) */
function contactCards() {
  const cards = [];
  if (waNumber()) cards.push('<a class="contact-card contact-card--wa" href="' + esc(waLink()) + '" target="_blank" rel="noopener">' +
    '<span class="kpi__icon">' + icon('chat', 22) + '</span><span><strong>WhatsApp</strong><small>Réponse rapide</small></span></a>');
  if (setting('support_phone')) cards.push('<a class="contact-card" href="tel:' + esc(setting('support_phone').replace(/[^\d+]/g, '')) + '">' +
    '<span class="kpi__icon">' + icon('phone', 22) + '</span><span><strong>Appeler</strong><small>' + esc(setting('support_phone')) + '</small></span></a>');
  if (setting('support_email')) cards.push('<a class="contact-card" href="mailto:' + esc(setting('support_email')) + '">' +
    '<span class="kpi__icon">' + icon('mail', 22) + '</span><span><strong>Écrire</strong><small>' + esc(setting('support_email')) + '</small></span></a>');
  return cards.length ? cards.join('') :
    '<p class="muted">Les moyens de contact seront bientôt disponibles.</p>';
}

async function renderChat(params) {
  await loadDisputes().catch(() => {});
  const options = state.packages.map((p) =>
    '<option value="' + p.id + '"' + (params.pkg === p.id ? ' selected' : '') + '>' + esc(p.reference) + ' — ' + esc(p.supplier_tracking) + '</option>').join('');

  return pageHead('Discuter avec nous', 'Une question ? Notre équipe vous répond.') +
    '<div class="grid grid--3">' + contactCards() + '</div>' +
    '<h2 class="section-title">Signaler un problème sur un colis</h2>' +
    (state.packages.length
      ? '<form class="card form" id="dispute-form">' +
        '<label class="field"><span class="field__label">Colis concerné *</span><select class="select" name="package" required>' + options + '</select></label>' +
        '<label class="field"><span class="field__label">Objet *</span><input class="input" name="subject" required maxlength="120" placeholder="Ex : colis endommagé, retard, erreur de poids…"></label>' +
        '<label class="field"><span class="field__label">Détails</span><textarea class="textarea" name="description" maxlength="1000" placeholder="Décrivez la situation le plus précisément possible."></textarea></label>' +
        '<button class="btn btn--primary" type="submit" style="justify-self:start">Envoyer le signalement</button></form>'
      : '<p class="muted">Enregistrez d\'abord un colis pour pouvoir signaler un problème.</p>') +
    (state.disputes.length
      ? '<h2 class="section-title">Mes signalements</h2><div class="stack">' + state.disputes.map((d) => {
          const p = findPackage(d.package_id);
          return '<article class="dispute"><div class="dispute__top"><strong>' + esc(d.subject) + '</strong>' +
            '<span class="badge badge--' + d.status + '">' + esc(DISPUTE_STATUS_LABELS[d.status]) + '</span></div>' +
            '<small class="muted">' + (p ? esc(p.reference) + ' · ' : '') + formatDate(d.created_at, true) + '</small>' +
            (d.description ? '<p>' + esc(d.description) + '</p>' : '') +
            (d.resolution ? '<div class="alert alert--success">' + icon('checkCircle') + '<span><strong>Réponse :</strong> ' + esc(d.resolution) + '</span></div>' : '') +
            '</article>';
        }).join('') + '</div>'
      : '');
}

function mountChat(view) {
  const form = $('#dispute-form', view);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Envoi…');
    const { error } = await supabase.from('disputes').insert({
      package_id: fd.get('package'),
      opened_by: state.profile.id,
      subject: String(fd.get('subject')).trim(),
      description: String(fd.get('description')).trim() || null,
    });
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');
    toast('Signalement envoyé. Nous revenons vers vous rapidement.', 'success');
    renderCurrent({ keepScroll: true });
  });
}

async function renderProfile() {
  const p = state.profile;
  const total = state.packages.length;
  const delivered = state.packages.filter((x) => x.status === 'delivered').length;

  return pageHead('Mon profil', 'Ces informations nous aident à vous joindre à l\'arrivée de vos colis.') +
    '<div class="profile">' +
    '<aside class="card profile__card">' +
      '<img class="avatar profile__avatar" ' + (p.avatar_url ? 'src="' + esc(p.avatar_url) + '"' : '') + ' alt="" referrerpolicy="no-referrer">' +
      '<span class="profile__name">' + esc(p.full_name || 'Sans nom') + '</span><span class="muted">' + esc(p.email) + '</span>' +
      '<div class="profile__stats"><div><strong>' + total + '</strong><small>Colis</small></div><div><strong>' + delivered + '</strong><small>Livrés</small></div></div>' +
      '<p class="muted" style="margin-top:8px"><small>Membre depuis le ' + formatDate(p.created_at) + '</small></p>' +
    '</aside>' +
    '<form class="card form" id="profile-form">' +
      '<label class="field"><span class="field__label">Nom complet</span><input class="input" name="full_name" required maxlength="80" value="' + esc(p.full_name || '') + '"></label>' +
      '<label class="field"><span class="field__label">Téléphone / WhatsApp</span><input class="input" name="phone" type="tel" maxlength="30" placeholder="+229 00 00 00 00" value="' + esc(p.phone || '') + '">' +
        '<span class="field__hint">Utilisé pour vous prévenir de l\'arrivée de vos colis.</span></label>' +
      '<label class="field"><span class="field__label">Adresse Gmail (connexion Google)</span><input class="input" value="' + esc(p.email) + '" readonly></label>' +
      '<div class="modal__actions" style="justify-content:space-between">' +
        '<button type="button" class="btn btn--ghost" id="btn-logout-profile">' + icon('logout', 18) + ' Se déconnecter</button>' +
        '<button type="submit" class="btn btn--primary">Enregistrer</button></div>' +
    '</form></div>';
}

function mountProfile(view) {
  $('#btn-logout-profile', view).addEventListener('click', signOut);
  const form = $('#profile-form', view);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const { data, error } = await supabase.from('users').update({
      full_name: String(fd.get('full_name')).trim(),
      phone: String(fd.get('phone')).trim() || null,
    }).eq('id', state.profile.id).select().single();
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error');
    state.profile = data;
    $$('.js-user-name').forEach((el) => (el.textContent = data.full_name || data.email));
    toast('Profil mis à jour', 'success');
    renderCurrent({ keepScroll: true });
  });
}


/* =====================================================================
 * 14. TEMPS RÉEL & DÉMARRAGE
 * ===================================================================== */

/** Re-génère l'écran concerné après un changement reçu en temps réel */
const scheduleRerender = debounce(() => {
  if (ui.current === 'packages') refreshPackageList();
  else if (['dashboard', 'invoices'].includes(ui.current)) renderCurrent({ keepScroll: true });
}, 250);

/** Un colis du client a changé (action d'un employé Chine ou Bénin) */
function onPackageChange(payload) {
  if (payload.eventType === 'DELETE') {
    state.packages = state.packages.filter((p) => p.id !== payload.old.id);
  } else {
    const next = payload.new;
    const prev = findPackage(next.id);
    if (prev && prev.status !== next.status) {
      toast('Colis ' + next.reference + ' : ' + statusLabel(next.status), 'success', 6000);
    }
    upsertPackage(next);

    // Fiche ouverte : mise à jour immédiate (sauf pendant une modification)
    if (modal().open && modal().dataset.pkg === next.id && modal().dataset.mode === 'view') {
      showPackageModal(next, 'view');
    }
  }
  updateBadges();
  scheduleRerender();
}

function startRealtime(userId) {
  subscribeToTable('packages', onPackageChange, 'client_id=eq.' + userId);

  // Annonces et paramètres : modifiés depuis l'admin, reflétés tout de suite
  subscribeToTable('announcements', async () => {
    await loadAnnouncements().catch(() => {});
    renderTicker();
    if (['dashboard', 'announcements'].includes(ui.current)) renderCurrent({ keepScroll: true });
  });
  subscribeToTable('app_settings', async () => {
    await loadSettings().catch(() => {});
    applyBranding();
    if (['dashboard', 'address', 'chat', 'rates', 'declare'].includes(ui.current)) renderCurrent({ keepScroll: true });
  });
}

/** Appelée par initPage() quand l'accès client est validé */
async function bootApp(profile) {
  state.profile = profile;
  buildNav();
  bindShell();
  bindModals();
  syncTopbar();
  $('#view').innerHTML = skeleton();

  // Chargement parallèle ; l'échec d'une table facultative n'empêche pas l'affichage
  const [pk, , ] = await Promise.allSettled([loadPackages(), loadSettings(), loadAnnouncements()]);
  if (pk.status === 'rejected') toast(friendlyError(pk.reason), 'error');

  applyBranding();
  renderTicker();
  updateBadges();
  startRealtime(profile.id);

  window.addEventListener('hashchange', navigate);
  if (!location.hash) history.replaceState(null, '', '#/dashboard');
  await navigate();
}

initPage({ allowedRoles: [ROLES.CLIENT], onReady: bootApp });
