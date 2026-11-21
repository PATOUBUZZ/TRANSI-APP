/* =====================================================================
 *  entrepot-chine.js  |  Portail ENTREPÔT CHINE
 * =====================================================================
 *  Accès : rôle « china_staff » (l'admin peut aussi superviser).
 *  Ce que peut faire un employé de l'entrepôt (garanti par la RLS) :
 *    - voir les colis déclarés, réceptionnés et en transit
 *    - réceptionner : poids, dimensions / volume, photos
 *    - regrouper les colis dans des lots (conteneur / vol) et déclarer le départ
 *  Il ne peut PAS : modifier un tarif ou un montant, valider un paiement,
 *  créer un colis (c'est le client qui le déclare), ni toucher aux colis
 *  déjà arrivés au Bénin.
 *
 *  Plan du fichier :
 *   1. Imports, état, utilitaires    6. Section « En entrepôt »
 *   2. Chargement des données        7. Section « Lots & expéditions »
 *   3. Navigation                    8. Section « Expédiés »
 *   4. Section « Réception »         9. Temps réel & démarrage
 *   5. Fiche de réception (modale)
 * ===================================================================== */


/* =====================================================================
 * 1. IMPORTS, ÉTAT, UTILITAIRES
 * ===================================================================== */
import {
  supabase, initPage, subscribeToTable, fetchAll,
  escapeHtml as esc, friendlyError, formatMoney, formatDate, formatWeight, formatVolume,
  statusBadge, modeLabel, debounce, toast, icon, num, fmtNum,
  pageHead, emptyState, setBusy, openModal, closeModal, bindModalBasics, askConfirm,
  renderNav, highlightNav, setBadge, bindDrawer, createRouter, openScanner, canScanBarcodes, $, $$,
} from './plateforms.js';

import {
  APP, ROLES, SHIPPING_MODES, SHIPMENT_STATUS_LABELS, SHIPMENT_KIND_LABELS,
} from './config.js';

const state = {
  profile: null,
  packages: [],     // colis visibles : déclarés, réceptionnés, en transit
  users: [],        // profils clients (nom, téléphone)
  shipments: [],    // lots
  rates: {},        // tarifs actifs { air, sea } : sert uniquement à l'estimation
};

const ui = {
  recvQuery: '',
  recvLimit: 50,
  stockQuery: '', stockMode: '', stockLot: '',
  selected: new Set(),          // colis cochés dans « En entrepôt »
  lotFilter: 'preparing',
  sentQuery: '',
};

const MAX_PHOTOS = 8;
let router = null;

const userById = (id) => state.users.find((u) => u.id === id);
const clientName = (id) => userById(id)?.full_name || userById(id)?.email || 'Client inconnu';
const shipmentById = (id) => state.shipments.find((s) => s.id === id);
const pkgById = (id) => state.packages.find((p) => p.id === id);

/** Délégation d'événements : on(root, 'click', '[data-x]', (el, event) => ...) */
function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(el, e);
  });
}

const numOrNull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : num(v));
const norm = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
const round4 = (n) => Math.round(n * 10000) / 10000;

function kpi(iconName, label, value, tone = '') {
  return '<div class="kpi ' + (tone ? 'kpi--' + tone : '') + '"><span class="kpi__icon">' + icon(iconName, 22) + '</span>' +
    '<span><span class="kpi__value">' + value + '</span><br><span class="kpi__label">' + esc(label) + '</span></span></div>';
}

const modeOptions = (selected = '', blank = '') =>
  (blank ? '<option value="">' + esc(blank) + '</option>' : '') +
  Object.entries(SHIPPING_MODES).map(([k, m]) =>
    '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('');

/** Quantité facturable d'un colis : kg (aérien) ou m³ (maritime) */
const billable = (p) => (p.shipping_mode === 'air' ? p.weight_kg : p.volume_m3);
const measureText = (p) => (p.weight_kg ? formatWeight(p.weight_kg) : '—') + (p.volume_m3 ? ' · ' + formatVolume(p.volume_m3) : '');


/* =====================================================================
 * 2. CHARGEMENT DES DONNÉES
 *    Les colis ne sont lus qu'une fois par affichage, puis filtrés ici
 *    (recherche instantanée, sans appel réseau à chaque frappe).
 * ===================================================================== */
async function loadAll() {
  const [packages, users, shipments, rates] = await Promise.all([
    fetchAll(() => supabase.from('packages').select('*')
      .in('status', ['declared', 'received_china', 'in_transit'])
      .order('created_at', { ascending: false }).order('id')),
    fetchAll(() => supabase.from('users').select('id, full_name, email, phone, role').order('id')),
    supabase.from('shipments').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('rates').select('*').eq('active', true),
  ]);
  if (shipments.error) throw shipments.error;
  state.packages = packages;
  state.users = users;
  state.shipments = shipments.data;
  state.rates = Object.fromEntries((rates.data || []).map((r) => [r.mode, r]));
  updateBadges();
}

const declaredList = () => state.packages.filter((p) => p.status === 'declared');
const stockList = () => state.packages.filter((p) => p.status === 'received_china');
const sentList = () => state.packages.filter((p) => p.status === 'in_transit');

function updateBadges() {
  setBadge('receive', declaredList().length);
  setBadge('stock', stockList().length);
}


/* =====================================================================
 * 3. NAVIGATION
 * ===================================================================== */
const SECTIONS = {
  receive: { label: 'Réception',            icon: 'scale',   render: renderReceive, mount: mountReceive },
  stock:   { label: 'En entrepôt',          icon: 'package', render: renderStock,   mount: mountStock },
  lots:    { label: 'Lots & expéditions',   icon: 'layers',  render: renderLots,    mount: mountLots },
  sent:    { label: 'Expédiés',             icon: 'truck',   render: renderSent,    mount: mountSent },
};

const NAV_GROUPS = [
  ['Entrepôt', ['receive', 'stock']],
  ['Expéditions', ['lots', 'sent']],
];


/* =====================================================================
 * 4. SECTION : RÉCEPTION
 *    On saisit ou on scanne le n° de suivi fournisseur : le colis déclaré
 *    par le client s'affiche, on pèse, on mesure, on photographie.
 *    Une douchette USB se comporte comme un clavier (touche Entrée).
 * ===================================================================== */

/** Carte d'un colis dans les résultats */
function pkgCard(p) {
  const action = p.status === 'declared' ? 'Réceptionner' : p.status === 'received_china' ? 'Modifier' : 'Voir';
  return '<button type="button" class="pkg" data-open-pkg="' + p.id + '">' +
    '<span class="pkg__icon pkg__icon--' + p.shipping_mode + '">' + icon(p.shipping_mode === 'air' ? 'plane' : 'ship', 24) + '</span>' +
    '<span class="pkg__body">' +
      '<span class="pkg__top"><strong class="pkg__ref">' + esc(p.supplier_tracking) + '</strong>' + statusBadge(p.status) + '</span>' +
      '<span class="pkg__client">' + esc(clientName(p.client_id)) + ' · ' + esc(p.reference) + '</span>' +
      (p.description ? '<span class="pkg__desc">' + esc(p.description) + '</span>' : '') +
      '<span class="pkg__meta"><span>' + esc(modeLabel(p.shipping_mode)) + '</span><span>Déclaré le ' + formatDate(p.created_at) + '</span>' +
      (p.weight_kg || p.volume_m3 ? '<span>' + esc(measureText(p)) + '</span>' : '') + '</span>' +
    '</span><span class="pkg__action">' + action + '</span></button>';
}

/** Colis correspondant à la recherche (n° de suivi ou référence) */
function searchPackages(q) {
  const needle = norm(q);
  if (!needle) return [];
  return state.packages.filter((p) => norm(p.supplier_tracking).includes(needle) || norm(p.reference).includes(needle));
}

function receiveResultsHtml() {
  const q = ui.recvQuery.trim();

  if (!q) {
    const list = declaredList();
    if (!list.length) return emptyState('checkCircle', 'Aucun colis en attente', 'Tous les colis déclarés par les clients ont été réceptionnés.');
    const shown = list.slice(0, ui.recvLimit);
    return '<h2 class="section-title">Colis déclarés à réceptionner (' + list.length + ')</h2>' +
      '<div class="pkg-list">' + shown.map(pkgCard).join('') + '</div>' +
      (list.length > shown.length ? '<div class="more-row"><button class="btn btn--ghost" type="button" id="recv-more">Afficher plus</button></div>' : '');
  }

  const found = searchPackages(q);
  if (!found.length) {
    return emptyState('search', 'Aucun colis trouvé pour « ' + q + ' »',
      'Ce numéro n\'a pas été déclaré par un client (ou le colis est déjà parti). Demandez au client de le déclarer dans son espace, puis relancez la recherche.');
  }
  return '<h2 class="section-title">' + found.length + ' résultat' + (found.length > 1 ? 's' : '') + '</h2>' +
    '<div class="pkg-list">' + found.slice(0, 30).map(pkgCard).join('') + '</div>';
}

function receiveKpisHtml() {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const today = state.packages.filter((p) => p.received_china_at && new Date(p.received_china_at) >= startOfDay).length;
  return '<div class="grid grid--4 recv-kpis">' +
    kpi('clock', 'À réceptionner', declaredList().length, 'warn') +
    kpi('checkCircle', 'Réceptionnés aujourd\'hui', today, 'success') +
    kpi('package', 'En entrepôt', stockList().length) +
    kpi('truck', 'En transit', sentList().length, 'accent') + '</div>';
}

async function renderReceive() {
  await loadAll();
  const canScan = canScanBarcodes();
  return pageHead('Réception des colis', 'Recherchez un colis par son numéro de suivi fournisseur, puis pesez, mesurez et photographiez-le.') +
    '<section class="scan-hero"><label class="scan-hero__label" for="recv-q">N° de suivi fournisseur ou référence</label>' +
    '<form class="scan-hero__form" id="recv-form" autocomplete="off">' +
      '<div class="input-group">' + icon('search', 20) +
        '<input class="input" id="recv-q" type="search" inputmode="text" autocapitalize="characters" spellcheck="false" ' +
        'placeholder="Scannez ou saisissez le numéro…" value="' + esc(ui.recvQuery) + '" autofocus></div>' +
      '<button class="btn btn--accent" type="submit">' + icon('search', 18) + ' Rechercher</button>' +
      (canScan ? '<button class="btn btn--ghost" type="button" id="recv-scan">' + icon('scan', 18) + ' Scanner</button>' : '') +
    '</form><p class="scan-hero__hint">Une douchette USB fonctionne directement : scannez, la fiche s\'ouvre.</p></section>' +
    '<div id="recv-kpis">' + receiveKpisHtml() + '</div>' +
    '<div id="recv-results">' + receiveResultsHtml() + '</div>';
}

function mountReceive(view) {
  const input = $('#recv-q', view);
  const redraw = () => { $('#recv-results', view).innerHTML = receiveResultsHtml(); };

  input.addEventListener('input', debounce(() => { ui.recvQuery = input.value; ui.recvLimit = 50; redraw(); }, 150));

  // Entrée (ou douchette) : un seul résultat -> la fiche s'ouvre directement
  $('#recv-form', view).addEventListener('submit', (e) => {
    e.preventDefault();
    ui.recvQuery = input.value;
    redraw();
    const found = searchPackages(input.value);
    if (found.length === 1) openPackageModal(found[0].id);
    else if (!found.length && input.value.trim()) toast('Aucun colis déclaré avec ce numéro.', 'error');
  });

  $('#recv-scan', view)?.addEventListener('click', () => openScanner((code) => {
    input.value = code;
    ui.recvQuery = code;
    redraw();
    const found = searchPackages(code);
    if (found.length === 1) openPackageModal(found[0].id);
    else if (!found.length) toast('Code lu : ' + code + ' — aucun colis déclaré.', 'error', 6000);
  }));

  on(view, 'click', '[data-open-pkg]', (el) => openPackageModal(el.dataset.openPkg));
  on(view, 'click', '#recv-more', () => { ui.recvLimit += 50; redraw(); });
  if (window.matchMedia('(pointer: fine)').matches) input.focus();   // poste fixe : prêt pour la douchette
}

/* =====================================================================
 * 5. FICHE DE RÉCEPTION (modale)
 * ===================================================================== */

/** Compresse une photo (max 1600 px, JPEG) : rapide à envoyer, sous la limite du bucket */
async function compressImage(file, maxSide = 1600, quality = 0.82) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bitmap = await createImageBitmap(file); }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Photo illisible.');
  return blob;
}

/** Liens temporaires des photos déjà enregistrées : Map chemin -> URL */
async function signedPhotoMap(paths) {
  if (!paths.length) return new Map();
  const { data } = await supabase.storage.from(APP.photosBucket).createSignedUrls(paths, APP.signedUrlTtl);
  return new Map((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

/** Lit les mesures du formulaire et calcule le volume retenu */
function readMeasures(form) {
  const fd = new FormData(form);
  const weight = numOrNull(fd.get('weight_kg'));
  const L = numOrNull(fd.get('length_cm'));
  const W = numOrNull(fd.get('width_cm'));
  const H = numOrNull(fd.get('height_cm'));
  const qty = Math.max(1, parseInt(fd.get('qty'), 10) || 1);
  const direct = numOrNull(fd.get('volume_direct'));
  const dims = [L, W, H];
  const out = { weight, L, W, H, qty, volume: null, keepDims: false, error: null };

  if (direct != null) out.volume = direct;                                   // volume total saisi
  else if (dims.every((v) => v != null)) {
    out.volume = round4((L * W * H / 1e6) * qty);                            // m³ = L x l x h / 1 000 000
    out.keepDims = qty === 1;                                                // plusieurs cartons : on garde seulement le volume total
  } else if (dims.some((v) => v != null)) {
    out.error = 'Renseignez les 3 dimensions (longueur, largeur, hauteur), ou aucune.';
  }
  return out;
}

async function openPackageModal(id) {
  const p = pkgById(id);
  if (!p) return;
  const editable = ['declared', 'received_china'].includes(p.status);
  const client = userById(p.client_id);
  const lots = state.shipments.filter((s) => s.status === 'preparing' && s.mode === p.shipping_mode);
  const isSea = p.shipping_mode === 'sea';
  const hadDims = p.length_cm != null && p.width_cm != null && p.height_cm != null;

  // Photos : existantes (chemins Storage), à supprimer, nouvelles (fichiers)
  const existing = [...(p.photos || [])];
  const removed = new Set();
  const added = [];                       // { file, url }
  let signed = new Map();

  const header =
    '<div class="recv-head">' +
      '<div class="recv-head__row"><span class="recv-head__track">' + esc(p.supplier_tracking) + '</span>' + statusBadge(p.status) + '</div>' +
      '<div class="callout">' + icon('user', 18) + '<span><strong>' + esc(clientName(p.client_id)) + '</strong>' +
        (client?.phone ? ' · ' + esc(client.phone) : '') + '<br>' + esc(p.reference) + ' · ' + esc(modeLabel(p.shipping_mode)) +
        (p.description ? '<br>« ' + esc(p.description) + ' »' : '') + '</span></div>' +
    '</div>';

  /* ----- Colis déjà en transit : lecture seule ----- */
  if (!editable) {
    openModal(p.reference, header +
      '<dl class="kv"><div><dt>Poids</dt><dd>' + formatWeight(p.weight_kg) + '</dd></div><div><dt>Volume</dt><dd>' + formatVolume(p.volume_m3) + '</dd></div>' +
      '<div><dt>Lot</dt><dd>' + esc(shipmentById(p.shipment_id)?.reference || '—') + '</dd></div>' +
      '<div><dt>Parti le</dt><dd>' + formatDate(p.in_transit_at, true) + '</dd></div></dl>' +
      '<p class="muted">Ce colis est déjà en transit : il n\'est plus modifiable depuis l\'entrepôt.</p>', { kind: 'package' });
    return;
  }

  openModal(p.status === 'declared' ? 'Réceptionner un colis' : 'Modifier ' + p.reference,
    header +
    '<form class="form" id="recv-edit-form" novalidate><div class="form-grid">' +
      '<span class="form-section">Pesée</span>' +
      '<label class="field measure-big' + (isSea ? '' : ' span-2') + '"><span class="field__label">Poids (kg)' + (isSea ? '' : ' *') + '</span>' +
        '<input class="input" name="weight_kg" inputmode="decimal" autocomplete="off" placeholder="0,0" value="' + (p.weight_kg ?? '') + '"></label>' +

      '<span class="form-section">Dimensions' + (isSea ? ' *' : ' (facultatif)') + '</span>' +
      '<label class="field"><span class="field__label">Longueur (cm)</span><input class="input" name="length_cm" inputmode="decimal" value="' + (hadDims ? p.length_cm : '') + '"></label>' +
      '<label class="field"><span class="field__label">Largeur (cm)</span><input class="input" name="width_cm" inputmode="decimal" value="' + (hadDims ? p.width_cm : '') + '"></label>' +
      '<label class="field"><span class="field__label">Hauteur (cm)</span><input class="input" name="height_cm" inputmode="decimal" value="' + (hadDims ? p.height_cm : '') + '"></label>' +
      '<label class="field"><span class="field__label">Nombre de cartons identiques</span><input class="input" name="qty" inputmode="numeric" value="1"></label>' +
      '<label class="field span-2"><span class="field__label">ou volume total connu (m³)</span>' +
        '<input class="input" name="volume_direct" inputmode="decimal" placeholder="Ex : 0,85" value="' + (!hadDims && p.volume_m3 ? p.volume_m3 : '') + '">' +
        '<span class="field__hint">Si renseigné, il remplace le calcul par dimensions. Avec plusieurs cartons, seul le volume total est enregistré.</span></label>' +
    '</div>' +
    '<div class="estimate" id="estimate" aria-live="polite"></div>' +

    '<div class="form-grid"><span class="form-section">Expédition</span>' +
      '<label class="field span-2"><span class="field__label">Rattacher à un lot (facultatif)</span><select class="select" name="shipment_id">' +
        '<option value="">— Plus tard —</option>' + lots.map((s) =>
          '<option value="' + s.id + '"' + (s.id === p.shipment_id ? ' selected' : '') + '>' + esc(s.reference) + ' · ' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + (s.carrier_ref ? ' · ' + esc(s.carrier_ref) : '') + '</option>').join('') +
      '</select>' + (lots.length ? '' : '<span class="field__hint">Aucun lot ' + esc(modeLabel(p.shipping_mode).toLowerCase()) + ' en préparation. Créez-en un dans « Lots & expéditions ».</span>') + '</label>' +
    '</div>' +

    '<div class="photo-uploader"><p class="detail-section-title" style="margin:0">Photos du colis (' + MAX_PHOTOS + ' max)</p>' +
      '<div class="photo-tiles" id="photo-tiles"></div>' +
      '<div class="photo-actions">' +
        '<button type="button" class="btn btn--ghost" id="photo-cam">' + icon('camera', 18) + ' Prendre une photo</button>' +
        '<button type="button" class="btn btn--ghost" id="photo-gallery">' + icon('plusSimple', 18) + ' Depuis la galerie</button>' +
      '</div>' +
      '<input type="file" id="photo-input-cam" accept="image/*" capture="environment" hidden>' +
      '<input type="file" id="photo-input-gallery" accept="image/*" multiple hidden></div>' +

    '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="recv-cancel">Annuler</button>' +
      '<button type="submit" class="btn btn--accent">' + icon('check', 18) + (p.status === 'declared' ? ' Réceptionner le colis' : ' Enregistrer') + '</button></div></form>',
    { kind: 'package', id: p.id });

  const form = $('#recv-edit-form');
  $('#recv-cancel').addEventListener('click', closeModal);

  /* ----- Estimation du montant (indicative : le montant officiel est calculé par la base) ----- */
  const updateEstimate = () => {
    const m = readMeasures(form);
    const qty = isSea ? m.volume : m.weight;
    const rate = state.rates[p.shipping_mode]?.price_per_unit;
    const unit = SHIPPING_MODES[p.shipping_mode].unit;
    const amount = rate != null && qty > 0 ? Math.round(qty * rate) : null;
    $('#estimate').innerHTML = '<span class="estimate__label">Montant estimé du fret</span>' +
      '<span class="estimate__amount">' + (amount != null ? formatMoney(amount) : '—') + '</span>' +
      '<span class="estimate__detail">' + (qty > 0 ? fmtNum(qty, 4) + ' ' + unit + (rate != null ? ' × ' + formatMoney(rate) : '') : (isSea ? 'Saisissez les dimensions ou le volume.' : 'Saisissez le poids.')) +
        (m.volume && !isSea ? ' · Volume : ' + fmtNum(m.volume, 4) + ' m³' : '') + '</span>';
  };
  form.addEventListener('input', updateEstimate);
  updateEstimate();

  /* ----- Photos ----- */
  const totalPhotos = () => existing.filter((x) => !removed.has(x)).length + added.length;
  const drawPhotos = () => {
    const tiles = existing.filter((x) => !removed.has(x)).map((path) =>
      '<div class="photo-tile">' + (signed.get(path) ? '<img src="' + esc(signed.get(path)) + '" alt="Photo du colis" loading="lazy">' : '') +
      '<button type="button" class="photo-tile__remove" data-rm-old="' + esc(path) + '" aria-label="Retirer la photo">' + icon('x', 14) + '</button></div>');
    const fresh = added.map((a, i) =>
      '<div class="photo-tile photo-tile--new"><img src="' + esc(a.url) + '" alt="Nouvelle photo"><span class="photo-tile__badge">Nouvelle</span>' +
      '<button type="button" class="photo-tile__remove" data-rm-new="' + i + '" aria-label="Retirer la photo">' + icon('x', 14) + '</button></div>');
    $('#photo-tiles').innerHTML = tiles.length || fresh.length ? tiles.join('') + fresh.join('') : '<p class="photo-empty">Aucune photo pour le moment.</p>';
  };
  drawPhotos();
  signedPhotoMap(existing).then((m) => { signed = m; if ($('#photo-tiles')) drawPhotos(); });

  const addFiles = (files) => {
    for (const file of files) {
      if (totalPhotos() >= MAX_PHOTOS) { toast('Maximum ' + MAX_PHOTOS + ' photos par colis.', 'error'); break; }
      if (!file.type.startsWith('image/')) continue;
      added.push({ file, url: URL.createObjectURL(file) });
    }
    drawPhotos();
  };
  $('#photo-cam').addEventListener('click', () => $('#photo-input-cam').click());
  $('#photo-gallery').addEventListener('click', () => $('#photo-input-gallery').click());
  ['#photo-input-cam', '#photo-input-gallery'].forEach((sel) => $(sel).addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  }));
  on($('#photo-tiles'), 'click', '[data-rm-old]', (el) => { removed.add(el.dataset.rmOld); drawPhotos(); });
  on($('#photo-tiles'), 'click', '[data-rm-new]', (el) => {
    const [gone] = added.splice(Number(el.dataset.rmNew), 1);
    URL.revokeObjectURL(gone.url);
    drawPhotos();
  });

  /* ----- Enregistrement ----- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = readMeasures(form);
    const fd = new FormData(form);

    // Validations (les mêmes règles sont garanties par la base ; ici : message clair)
    if (m.error) return toast(m.error, 'error');
    if ([m.weight, m.L, m.W, m.H, m.volume].some((v) => v != null && !(v > 0))) return toast('Les mesures doivent être supérieures à 0.', 'error');
    if (!isSea && !(m.weight > 0)) return toast('Le poids est obligatoire pour un colis aérien.', 'error');
    if (isSea && !(m.volume > 0)) return toast('Les dimensions ou le volume sont obligatoires pour un colis maritime.', 'error');

    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Enregistrement…');
    const uploaded = [];

    try {
      // 1) Envoi des nouvelles photos (compressées) dans le bucket privé
      for (const a of added) {
        const blob = await compressImage(a.file);
        const path = p.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
        const { error } = await supabase.storage.from(APP.photosBucket).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (error) throw error;
        uploaded.push(path);
      }

      // 2) Mise à jour du colis (le montant est calculé par la base à partir du tarif actif)
      const { data, error } = await supabase.from('packages').update({
        status: 'received_china',
        weight_kg: m.weight,
        length_cm: m.keepDims ? m.L : null,
        width_cm: m.keepDims ? m.W : null,
        height_cm: m.keepDims ? m.H : null,
        volume_m3: m.volume,
        shipment_id: fd.get('shipment_id') || null,
        photos: [...existing.filter((x) => !removed.has(x)), ...uploaded],
      }).eq('id', p.id).select().single();
      if (error) throw error;

      // 3) Suppression des photos retirées (sans bloquer en cas d'échec)
      if (removed.size) await supabase.storage.from(APP.photosBucket).remove([...removed]).catch(() => {});

      added.forEach((a) => URL.revokeObjectURL(a.url));
      closeModal();
      toast('Colis réceptionné' + (data.amount_due != null ? ' · fret : ' + formatMoney(data.amount_due) : ''), 'success', 5000);
      ui.recvQuery = '';
      await router.refresh({ keepScroll: true });
      $('#recv-q')?.focus();
    } catch (err) {
      // Échec : on nettoie les photos déjà envoyées pour ne pas laisser d'orphelines
      if (uploaded.length) await supabase.storage.from(APP.photosBucket).remove(uploaded).catch(() => {});
      toast(friendlyError(err), 'error', 6000);
    } finally {
      setBusy(btn, false);
    }
  });
}


/* =====================================================================
 * 6. SECTION : EN ENTREPÔT (colis réceptionnés, en attente de départ)
 * ===================================================================== */

function filteredStock() {
  const q = norm(ui.stockQuery);
  return stockList().filter((p) =>
    (!ui.stockMode || p.shipping_mode === ui.stockMode) &&
    (!ui.stockLot || (ui.stockLot === 'none' ? !p.shipment_id : !!p.shipment_id)) &&
    (!q || norm(p.supplier_tracking).includes(q) || norm(p.reference).includes(q) || norm(clientName(p.client_id)).includes(q)));
}

function stockTableHtml() {
  const list = filteredStock();
  if (!list.length) {
    return stockList().length
      ? emptyState('search', 'Aucun colis trouvé', 'Modifiez vos filtres ou votre recherche.')
      : emptyState('package', 'Aucun colis en entrepôt', 'Les colis réceptionnés apparaissent ici en attendant d\'être rattachés à un lot.',
          '<a class="btn btn--primary" href="#/receive">Aller à la réception</a>');
  }
  const allChecked = list.every((p) => ui.selected.has(p.id));
  return '<p class="result-count">' + list.length + ' colis</p><div class="table-wrap"><table class="table data-table"><thead><tr>' +
    '<th class="t-check"><input class="check" type="checkbox" id="sel-all" aria-label="Tout sélectionner"' + (allChecked ? ' checked' : '') + '></th>' +
    '<th>N° de suivi</th><th>Client</th><th>Mode</th><th>Poids / Volume</th><th>Lot</th><th>Réceptionné le</th></tr></thead><tbody>' +
    list.map((p) => {
      const lot = shipmentById(p.shipment_id);
      return '<tr class="row-link' + (ui.selected.has(p.id) ? ' is-selected' : '') + '" tabindex="0" data-open-pkg="' + p.id + '">' +
        '<td class="t-check"><input class="check" type="checkbox" data-sel="' + p.id + '" aria-label="Sélectionner ' + esc(p.reference) + '"' + (ui.selected.has(p.id) ? ' checked' : '') + '></td>' +
        '<td class="t-mono t-strong">' + esc(p.supplier_tracking) + '<span class="t-sub">' + esc(p.reference) + '</span></td>' +
        '<td>' + esc(clientName(p.client_id)) + '</td><td>' + esc(modeLabel(p.shipping_mode)) + '</td>' +
        '<td>' + esc(measureText(p)) + '</td>' +
        '<td>' + (lot ? '<span class="tag tag--info">' + esc(lot.reference) + '</span>' : '<span class="tag">Sans lot</span>') + '</td>' +
        '<td>' + formatDate(p.received_china_at, true) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function bulkBarHtml() {
  const n = ui.selected.size;
  if (!n) return '';
  return '<div class="bulk-bar"><span><strong>' + n + '</strong> colis sélectionné' + (n > 1 ? 's' : '') + '</span>' +
    '<span class="actions"><button type="button" class="btn btn--ghost btn--sm" id="bulk-clear">Désélectionner</button>' +
    '<button type="button" class="btn btn--accent btn--sm" id="bulk-lot">' + icon('layers', 16) + ' Ajouter à un lot</button></span></div>';
}

async function renderStock() {
  await loadAll();
  // On oublie les cases cochées qui ne sont plus en entrepôt
  const ids = new Set(stockList().map((p) => p.id));
  ui.selected.forEach((id) => { if (!ids.has(id)) ui.selected.delete(id); });

  return pageHead('En entrepôt', 'Colis réceptionnés, en attente de départ. Cochez-en plusieurs pour les ajouter à un lot.') +
    '<div class="filters"><div class="input-group">' + icon('search', 18) +
      '<input class="input" id="stock-q" type="search" placeholder="N° de suivi, référence, client…" value="' + esc(ui.stockQuery) + '" aria-label="Rechercher"></div>' +
      '<select class="select" id="stock-mode" aria-label="Mode">' + modeOptions(ui.stockMode, 'Aérien et maritime') + '</select>' +
      '<select class="select" id="stock-lot" aria-label="Lot">' +
        '<option value="">Avec ou sans lot</option><option value="none"' + (ui.stockLot === 'none' ? ' selected' : '') + '>Sans lot</option>' +
        '<option value="with"' + (ui.stockLot === 'with' ? ' selected' : '') + '>Déjà dans un lot</option></select></div>' +
    '<div id="stock-table">' + stockTableHtml() + '</div><div id="bulk-slot">' + bulkBarHtml() + '</div>';
}

function mountStock(view) {
  const redraw = () => { $('#stock-table', view).innerHTML = stockTableHtml(); $('#bulk-slot', view).innerHTML = bulkBarHtml(); };

  $('#stock-q', view).addEventListener('input', debounce((e) => { ui.stockQuery = e.target.value; redraw(); }, 200));
  $('#stock-mode', view).addEventListener('change', (e) => { ui.stockMode = e.target.value; redraw(); });
  $('#stock-lot', view).addEventListener('change', (e) => { ui.stockLot = e.target.value; redraw(); });

  on(view, 'change', '[data-sel]', (el) => { el.checked ? ui.selected.add(el.dataset.sel) : ui.selected.delete(el.dataset.sel); redraw(); });
  on(view, 'change', '#sel-all', (el) => {
    filteredStock().forEach((p) => (el.checked ? ui.selected.add(p.id) : ui.selected.delete(p.id)));
    redraw();
  });
  on(view, 'click', '[data-open-pkg]', (el, e) => { if (!e.target.closest('input')) openPackageModal(el.dataset.openPkg); });
  on(view, 'click', '#bulk-clear', () => { ui.selected.clear(); redraw(); });
  on(view, 'click', '#bulk-lot', () => openAssignModal([...ui.selected]));
}

/** Ajouter des colis cochés à un lot en préparation du même mode */
function openAssignModal(ids) {
  const pkgs = ids.map(pkgById).filter(Boolean);
  const modes = new Set(pkgs.map((p) => p.shipping_mode));
  if (modes.size > 1) return toast('Sélectionnez des colis du même mode (aérien OU maritime).', 'error', 5000);
  const mode = [...modes][0];
  const lots = state.shipments.filter((s) => s.status === 'preparing' && s.mode === mode);

  openModal('Ajouter ' + pkgs.length + ' colis à un lot',
    lots.length
      ? '<form class="form" id="assign-form"><div class="lot-pick">' + lots.map((s, i) =>
          '<label><input class="check" type="radio" name="lot" value="' + s.id + '"' + (i === 0 ? ' checked' : '') + '>' +
          '<span class="lot-pick__main"><strong>' + esc(s.reference) + ' · ' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + '</strong>' +
          '<small>' + (s.carrier_ref ? esc(s.carrier_ref) + ' · ' : '') + state.packages.filter((p) => p.shipment_id === s.id).length + ' colis déjà dedans</small></span></label>').join('') + '</div>' +
        '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="assign-cancel">Annuler</button><button type="submit" class="btn btn--primary">Ajouter au lot</button></div></form>'
      : '<div class="empty" style="border:0;padding:20px 0"><h3>Aucun lot ' + esc(modeLabel(mode).toLowerCase()) + ' en préparation</h3>' +
        '<p>Créez d\'abord un lot, puis revenez ajouter vos colis.</p><a class="btn btn--primary" href="#/lots" id="assign-go">Créer un lot</a></div>',
    { kind: 'assign' });

  $('#assign-go')?.addEventListener('click', closeModal);
  $('#assign-cancel')?.addEventListener('click', closeModal);
  $('#assign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    setBusy(btn, true, 'Ajout…');
    const { error } = await supabase.from('packages').update({ shipment_id: new FormData(e.target).get('lot') }).in('id', ids);
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error', 6000);
    ui.selected.clear();
    closeModal();
    toast(pkgs.length + ' colis ajouté' + (pkgs.length > 1 ? 's' : '') + ' au lot', 'success');
    router.refresh({ keepScroll: true });
  });
}


/* =====================================================================
 * 7. SECTION : LOTS & EXPÉDITIONS
 *    Un lot regroupe des colis du même mode. Quand l'employé déclare le
 *    départ, le lot passe « en transit » et TOUS ses colis suivent
 *    automatiquement (le client est averti en temps réel).
 * ===================================================================== */
const LOT_FILTERS = {
  preparing: { label: 'En préparation', test: (s) => s.status === 'preparing' },
  in_transit: { label: 'En transit', test: (s) => s.status === 'in_transit' },
  done: { label: 'Terminés', test: (s) => ['arrived', 'closed'].includes(s.status) },
};

const lotPackages = (id) => state.packages.filter((p) => p.shipment_id === id);

async function renderLots() {
  await loadAll();
  const list = state.shipments.filter(LOT_FILTERS[ui.lotFilter].test);

  return pageHead('Lots & expéditions', 'Regroupez les colis réceptionnés par conteneur, vol ou lot, puis déclarez le départ.',
      '<div class="actions"><button class="btn btn--primary" type="button" id="lot-new">' + icon('plusSimple', 18) + ' Nouveau lot</button></div>') +
    '<div class="chips" id="lot-chips" style="margin-bottom:14px">' + Object.entries(LOT_FILTERS).map(([k, f]) =>
      '<button class="chip" type="button" data-lot-filter="' + k + '" aria-pressed="' + (ui.lotFilter === k) + '">' + f.label +
      '<span class="chip__count">' + state.shipments.filter(f.test).length + '</span></button>').join('') + '</div>' +
    (list.length
      ? '<div class="table-wrap"><table class="table data-table"><thead><tr><th>Référence</th><th>Type</th><th>Mode</th><th>N° transporteur</th><th>Statut</th>' +
        '<th class="t-right">Colis</th><th>ETA</th></tr></thead><tbody>' + list.map((s) => {
          const inLot = lotPackages(s.id);
          return '<tr class="row-link" tabindex="0" data-open-lot="' + s.id + '"><td class="t-strong">' + esc(s.reference) + '</td>' +
            '<td>' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + '</td><td>' + esc(modeLabel(s.mode)) + '</td>' +
            '<td class="t-mono">' + esc(s.carrier_ref || '—') + '</td>' +
            '<td><span class="badge badge--' + s.status + '">' + esc(SHIPMENT_STATUS_LABELS[s.status]) + '</span></td>' +
            '<td class="t-right t-strong">' + (['preparing', 'in_transit'].includes(s.status) ? inLot.length : '—') + '</td>' +
            '<td>' + (s.eta ? formatDate(s.eta) : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('layers', 'Aucun lot ici', ui.lotFilter === 'preparing' ? 'Créez un lot pour commencer à regrouper vos colis.' : 'Rien à afficher pour ce filtre.',
          ui.lotFilter === 'preparing' ? '<button class="btn btn--primary" type="button" id="lot-new-empty">Créer un lot</button>' : ''));
}

function mountLots(view) {
  on(view, 'click', '[data-lot-filter]', (el) => { ui.lotFilter = el.dataset.lotFilter; router.refresh({ keepScroll: true }); });
  on(view, 'click', '#lot-new, #lot-new-empty', openLotCreator);
  on(view, 'click', '[data-open-lot]', (el) => openLotModal(el.dataset.openLot));
  on(view, 'keydown', '[data-open-lot]', (el, e) => { if (e.key === 'Enter') openLotModal(el.dataset.openLot); });
}

function openLotCreator() {
  openModal('Nouveau lot',
    '<form class="form" id="lot-form"><div class="form-grid">' +
      '<label class="field"><span class="field__label">Mode *</span><select class="select" name="mode" required>' + modeOptions('sea') + '</select></label>' +
      '<label class="field"><span class="field__label">Type</span><select class="select" name="kind">' +
        Object.entries(SHIPMENT_KIND_LABELS).map(([k, l]) => '<option value="' + k + '">' + esc(l) + '</option>').join('') + '</select></label>' +
      '<label class="field"><span class="field__label">N° conteneur / LTA / vol</span><input class="input" name="carrier_ref" maxlength="60" placeholder="Ex : MSKU1234567"></label>' +
      '<label class="field"><span class="field__label">Arrivée estimée à Cotonou</span><input class="input" type="date" name="eta"></label>' +
      '<label class="field span-2"><span class="field__label">Notes</span><textarea class="textarea" name="notes" style="min-height:70px"></textarea></label>' +
    '</div><div class="modal__actions"><button type="button" class="btn btn--ghost" id="lot-cancel">Annuler</button>' +
    '<button type="submit" class="btn btn--primary">Créer le lot</button></div></form>', { kind: 'lot-new' });

  $('#lot-cancel').addEventListener('click', closeModal);
  $('#lot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('[type="submit"]');
    setBusy(btn, true, 'Création…');
    const { data, error } = await supabase.from('shipments').insert({
      mode: fd.get('mode'), kind: fd.get('kind'),
      carrier_ref: String(fd.get('carrier_ref')).trim() || null,
      eta: fd.get('eta') || null,
      notes: String(fd.get('notes')).trim() || null,
      status: 'preparing',
      created_by: state.profile.id,
    }).select().single();
    setBusy(btn, false);
    if (error) return toast(friendlyError(error), 'error', 6000);
    toast('Lot ' + data.reference + ' créé', 'success');
    ui.lotFilter = 'preparing';
    await router.refresh({ keepScroll: true });
    openLotModal(data.id);
  });
}

/** Détail d'un lot : colis, totaux, ajout / retrait, départ */
function openLotModal(id) {
  const s = shipmentById(id);
  if (!s) return;
  const preparing = s.status === 'preparing';
  const inLot = lotPackages(id);
  const totalKg = inLot.reduce((sum, p) => sum + Number(p.weight_kg || 0), 0);
  const totalM3 = inLot.reduce((sum, p) => sum + Number(p.volume_m3 || 0), 0);
  const candidates = preparing ? stockList().filter((p) => p.shipping_mode === s.mode && !p.shipment_id) : [];

  openModal(s.reference,
    '<div class="recv-head__row"><span class="badge badge--' + s.status + '">' + esc(SHIPMENT_STATUS_LABELS[s.status]) + '</span>' +
      '<span class="muted">' + esc(SHIPMENT_KIND_LABELS[s.kind] || s.kind) + ' · ' + esc(modeLabel(s.mode)) + '</span></div>' +
    '<div class="lot-totals"><div><strong>' + inLot.length + '</strong><small>Colis</small></div>' +
      '<div><strong>' + fmtNum(totalKg, 1) + ' kg</strong><small>Poids total</small></div>' +
      '<div><strong>' + fmtNum(totalM3, 3) + ' m³</strong><small>Volume total</small></div></div>' +

    (preparing
      ? '<form class="form" id="lot-edit-form"><div class="form-grid">' +
          '<label class="field"><span class="field__label">N° conteneur / LTA / vol</span><input class="input" name="carrier_ref" maxlength="60" value="' + esc(s.carrier_ref || '') + '"></label>' +
          '<label class="field"><span class="field__label">Arrivée estimée</span><input class="input" type="date" name="eta" value="' + esc(s.eta || '') + '"></label>' +
          '<label class="field span-2"><span class="field__label">Notes</span><textarea class="textarea" name="notes" style="min-height:60px">' + esc(s.notes || '') + '</textarea></label></div>' +
          '<div><button type="submit" class="btn btn--ghost btn--sm">Enregistrer les informations</button></div></form>'
      : '<dl class="kv"><div><dt>N° transporteur</dt><dd>' + esc(s.carrier_ref || '—') + '</dd></div><div><dt>Arrivée estimée</dt><dd>' + (s.eta ? formatDate(s.eta) : '—') + '</dd></div>' +
        '<div><dt>Départ</dt><dd>' + (s.departed_at ? formatDate(s.departed_at, true) : '—') + '</dd></div></dl>') +

    '<div><p class="detail-section-title">Colis du lot (' + inLot.length + ')</p>' +
      (inLot.length
        ? '<div class="table-wrap"><table class="table data-table"><tbody>' + inLot.map((p) =>
          '<tr><td class="t-mono t-strong">' + esc(p.supplier_tracking) + '<span class="t-sub">' + esc(clientName(p.client_id)) + '</span></td>' +
          '<td>' + esc(measureText(p)) + '</td>' +
          '<td class="t-right">' + (preparing ? '<button type="button" class="btn btn--danger-ghost btn--sm" data-lot-remove="' + p.id + '" aria-label="Retirer du lot">' + icon('x', 14) + '</button>' : '') + '</td></tr>').join('') +
          '</tbody></table></div>'
        : '<p class="muted">Aucun colis dans ce lot.</p>') + '</div>' +

    (preparing
      ? '<div><p class="detail-section-title">Ajouter des colis ' + esc(modeLabel(s.mode).toLowerCase()) + 's disponibles (' + candidates.length + ')</p>' +
        (candidates.length
          ? '<form class="form" id="lot-add-form"><div class="lot-pick">' + candidates.map((p) =>
              '<label><input class="check" type="checkbox" name="pkg" value="' + p.id + '"><span class="lot-pick__main"><strong>' + esc(p.supplier_tracking) + '</strong>' +
              '<small>' + esc(clientName(p.client_id)) + ' · ' + esc(measureText(p)) + '</small></span></label>').join('') + '</div>' +
            '<div><button type="submit" class="btn btn--primary btn--sm">Ajouter la sélection</button></div></form>'
          : '<p class="muted">Aucun colis réceptionné sans lot pour ce mode.</p>') + '</div>' +
        '<div class="modal__actions" style="justify-content:space-between"><button type="button" class="btn btn--ghost" id="lot-close">Fermer</button>' +
        '<button type="button" class="btn btn--accent" id="lot-depart"' + (inLot.length ? '' : ' disabled') + '>' + icon('truck', 18) + ' Déclarer le départ</button></div>'
      : '<div class="modal__actions"><button type="button" class="btn btn--ghost" id="lot-close">Fermer</button></div>'),
    { kind: 'lot', id });

  $('#lot-close').addEventListener('click', closeModal);
  const reopen = async () => { await router.refresh({ keepScroll: true }); openLotModal(id); };

  $('#lot-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await supabase.from('shipments').update({
      carrier_ref: String(fd.get('carrier_ref')).trim() || null,
      eta: fd.get('eta') || null,
      notes: String(fd.get('notes')).trim() || null,
    }).eq('id', id);
    if (error) return toast(friendlyError(error), 'error');
    toast('Informations enregistrées', 'success');
    reopen();
  });

  on($('#modal-body'), 'click', '[data-lot-remove]', async (el) => {
    const { error } = await supabase.from('packages').update({ shipment_id: null }).eq('id', el.dataset.lotRemove);
    if (error) return toast(friendlyError(error), 'error');
    reopen();
  });

  $('#lot-add-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = new FormData(e.target).getAll('pkg');
    if (!ids.length) return toast('Cochez au moins un colis.', 'error');
    const { error } = await supabase.from('packages').update({ shipment_id: id }).in('id', ids);
    if (error) return toast(friendlyError(error), 'error', 6000);
    toast(ids.length + ' colis ajouté' + (ids.length > 1 ? 's' : ''), 'success');
    reopen();
  });

  $('#lot-depart')?.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Déclarer le départ ?',
      message: 'Le lot ' + s.reference + ' (' + inLot.length + ' colis) passera « en transit » et les clients seront informés. Vous ne pourrez plus le modifier.',
      confirmLabel: 'Déclarer le départ',
    });
    if (!ok) return;
    const { error } = await supabase.from('shipments').update({ status: 'in_transit' }).eq('id', id);
    if (error) return toast(friendlyError(error), 'error', 6000);
    closeModal();
    toast('Lot parti : ' + inLot.length + ' colis en transit', 'success', 5000);
    ui.lotFilter = 'in_transit';
    router.refresh({ keepScroll: true });
  });
}


/* =====================================================================
 * 8. SECTION : EXPÉDIÉS (colis en transit, lecture seule)
 * ===================================================================== */
function sentTableHtml() {
  const q = norm(ui.sentQuery);
  const list = sentList().filter((p) => !q || norm(p.supplier_tracking).includes(q) || norm(p.reference).includes(q) || norm(clientName(p.client_id)).includes(q));
  if (!list.length) {
    return sentList().length ? emptyState('search', 'Aucun résultat', 'Aucun colis en transit ne correspond.')
      : emptyState('truck', 'Aucun colis en transit', 'Les colis apparaissent ici dès que leur lot est déclaré parti.');
  }
  return '<p class="result-count">' + list.length + ' colis en transit</p><div class="table-wrap"><table class="table data-table"><thead><tr>' +
    '<th>N° de suivi</th><th>Client</th><th>Mode</th><th>Poids / Volume</th><th>Lot</th><th>Parti le</th></tr></thead><tbody>' +
    list.map((p) => '<tr class="row-link" tabindex="0" data-open-pkg="' + p.id + '"><td class="t-mono t-strong">' + esc(p.supplier_tracking) + '<span class="t-sub">' + esc(p.reference) + '</span></td>' +
      '<td>' + esc(clientName(p.client_id)) + '</td><td>' + esc(modeLabel(p.shipping_mode)) + '</td><td>' + esc(measureText(p)) + '</td>' +
      '<td>' + (shipmentById(p.shipment_id) ? '<span class="tag tag--info">' + esc(shipmentById(p.shipment_id).reference) + '</span>' : '—') + '</td>' +
      '<td>' + formatDate(p.in_transit_at, true) + '</td></tr>').join('') + '</tbody></table></div>';
}

async function renderSent() {
  await loadAll();
  return pageHead('Colis expédiés', 'Colis en route vers Cotonou. Le suivi continue côté Bénin.') +
    '<div class="filters filters--tight"><div class="input-group">' + icon('search', 18) +
    '<input class="input" id="sent-q" type="search" placeholder="N° de suivi, référence, client…" value="' + esc(ui.sentQuery) + '" aria-label="Rechercher"></div></div>' +
    '<div id="sent-table">' + sentTableHtml() + '</div>';
}

function mountSent(view) {
  $('#sent-q', view).addEventListener('input', debounce((e) => { ui.sentQuery = e.target.value; $('#sent-table', view).innerHTML = sentTableHtml(); }, 200));
  on(view, 'click', '[data-open-pkg]', (el) => openPackageModal(el.dataset.openPkg));
  on(view, 'keydown', '[data-open-pkg]', (el, e) => { if (e.key === 'Enter') openPackageModal(el.dataset.openPkg); });
}


/* =====================================================================
 * 9. TEMPS RÉEL & DÉMARRAGE
 * ===================================================================== */

/** Un colis ou un lot a changé (client, autre employé, admin...) */
const onLiveChange = debounce(async () => {
  if ($('#modal').open) return;                                   // jamais sous un formulaire ouvert
  if (document.activeElement?.matches('input, textarea, select')) {
    // L'employé est en train de saisir : on met à jour les données sans toucher au champ
    await loadAll().catch(() => {});
    if (router.route.id === 'receive') {
      $('#recv-results').innerHTML = receiveResultsHtml();
      $('#recv-kpis').innerHTML = receiveKpisHtml();
    }
    return;
  }
  router.refresh({ keepScroll: true });
}, 800);

async function bootChina(profile) {
  state.profile = profile;

  renderNav(NAV_GROUPS, SECTIONS);
  bindDrawer();
  bindModalBasics();

  supabase.from('app_settings').select('value').eq('key', 'company_name').maybeSingle().then(({ data }) => {
    if (!data?.value) return;
    $$('.js-company').forEach((el) => (el.textContent = data.value));
    document.title = 'Entrepôt Chine — ' + data.value;
  });

  router = createRouter({
    sections: SECTIONS,
    defaultId: 'receive',
    onChange: (id) => highlightNav(id),
  });

  ['packages', 'shipments'].forEach((t) => subscribeToTable(t, onLiveChange));

  if (!location.hash) history.replaceState(null, '', '#/receive');
  await router.navigate();
}

initPage({ allowedRoles: [ROLES.CHINA, ROLES.ADMIN], onReady: bootChina });
