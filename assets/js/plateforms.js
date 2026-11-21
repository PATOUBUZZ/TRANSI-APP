/* =====================================================================
 *  plateforms.js  |  Socle COMMUN aux 4 interfaces
 * =====================================================================
 *  Contenu :
 *   1. Client Supabase unique
 *   2. Authentification Google (connexion / déconnexion)
 *   3. Profil + rôle de l'utilisateur connecté
 *   4. initPage() : garde d'accès par rôle + bascule login / accès refusé / app
 *   5. Realtime (abonnement aux changements de table)
 *   6. Photos (liens signés)
 *   7. Utilitaires : erreurs, formats, échappement HTML, toasts
 *
 *  IMPORTANT : ce fichier ne remplace pas la RLS. La garde ci-dessous sert à
 *  l'expérience utilisateur ; même en la contournant, Supabase refuse les
 *  lectures / écritures non autorisées (schema.sql).
 *
 *  CONTRAT HTML attendu par initPage() (ids à reprendre dans chaque page) :
 *    #auth-screen        écran de connexion          (contient #btn-google-login)
 *    #access-denied      écran d'accès refusé        (contient #denied-message,
 *                                                     #denied-redirect, .js-logout)
 *    #app                application (cachée tant que l'accès n'est pas validé)
 *    .js-logout          tout bouton de déconnexion
 *    .js-user-name / .js-user-email / .js-user-role / .js-user-avatar (<img>)
 * ===================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, APP, ROLE_HOME, ROLE_LABELS,
  STATUS_LABELS, SHIPPING_MODES,
} from './config.js';


/* =====================================================================
 * 1. CLIENT SUPABASE UNIQUE
 *    La session est conservée dans le navigateur (localStorage) et
 *    rafraîchie automatiquement. PKCE = flux OAuth recommandé.
 * ===================================================================== */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,   // récupère la session au retour de Google
    flowType: 'pkce',
  },
});


/* =====================================================================
 * 2. AUTHENTIFICATION GOOGLE (aucun mot de passe)
 * ===================================================================== */

/**
 * Lance la connexion Google. L'utilisateur revient sur la page courante
 * (chaque portail se ré-ouvre lui-même). Cette URL doit figurer dans
 * Supabase > Authentication > URL Configuration > Redirect URLs.
 */
export async function signInWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: { prompt: 'select_account' },   // permet de choisir le bon Gmail
    },
  });
  if (error) throw error;
}

/** Déconnecte l'utilisateur puis recharge la page (retour à l'écran de login). */
export async function signOut() {
  _profile = null;
  await supabase.auth.signOut();
  window.location.reload();
}


/* =====================================================================
 * 3. PROFIL ET RÔLE
 *    Le rôle vient de public.users (rempli par le trigger de schema.sql à
 *    partir de la liste blanche authorized_staff). Il n'est jamais lu dans
 *    le navigateur de l'utilisateur (localStorage, URL...).
 * ===================================================================== */
let _profile = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retourne la session Supabase courante (ou null). */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/**
 * Retourne la ligne public.users de l'utilisateur connecté, ou null.
 * 3 tentatives courtes : juste après la 1re connexion, le profil vient
 * d'être créé par le trigger.
 */
export async function getProfile({ force = false } = {}) {
  if (_profile && !force) return _profile;

  const session = await getSession();
  if (!session) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('users').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    if (data) { _profile = data; return data; }
    await sleep(600);
  }
  return null;
}


/* =====================================================================
 * 4. GARDE D'ACCÈS DES PAGES : initPage()
 * ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const show = (el) => { if (el) el.hidden = false; };
const hide = (el) => { if (el) el.hidden = true; };

/** Affiche un seul des 3 écrans : 'auth' | 'denied' | 'app' */
function showScreen(name) {
  hide($('#boot'));            // l'écran de chargement disparaît dès qu'un écran est choisi
  hide($('#auth-screen'));
  hide($('#access-denied'));
  hide($('#app'));
  show($({ auth: '#auth-screen', denied: '#access-denied', app: '#app' }[name]));
}

/** Affiche l'écran « accès refusé » avec un message et, si utile, un lien. */
function denyAccess(message, redirectHref = null, redirectLabel = '') {
  $('#denied-message').textContent = message;
  const link = $('#denied-redirect');
  if (link) {
    if (redirectHref) {
      link.href = redirectHref;
      link.textContent = redirectLabel;
      show(link);
    } else {
      hide(link);
    }
  }
  showScreen('denied');
}

/** Renseigne nom / email / rôle / avatar dans les éléments .js-user-* */
function fillUserInfo(profile) {
  $$('.js-user-name').forEach((el) => (el.textContent = profile.full_name || profile.email));
  $$('.js-user-email').forEach((el) => (el.textContent = profile.email));
  $$('.js-user-role').forEach((el) => (el.textContent = ROLE_LABELS[profile.role] || profile.role));
  $$('.js-user-avatar').forEach((img) => {
    if (profile.avatar_url) { img.src = profile.avatar_url; img.alt = profile.full_name || ''; }
  });
}

/**
 * Point d'entrée de CHAQUE page.
 *
 * @param {Object}   options
 * @param {string[]} options.allowedRoles  rôles autorisés sur cette page
 * @param {Function} options.onReady       appelée avec le profil quand l'accès est validé
 *
 * Déroulé :
 *   pas de session        -> écran de connexion Google
 *   profil introuvable    -> accès refusé
 *   compte désactivé      -> accès refusé
 *   rôle non autorisé     -> accès refusé + lien vers le bon portail
 *   sinon                 -> affiche #app et appelle onReady(profile)
 */
export async function initPage({ allowedRoles, onReady }) {
  // Boutons communs : connexion et déconnexion
  $('#btn-google-login')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await signInWithGoogle(); }
    catch (err) { e.currentTarget.disabled = false; toast(friendlyError(err), 'error'); }
  });
  $$('.js-logout').forEach((btn) => btn.addEventListener('click', signOut));

  // Si la session est fermée dans un autre onglet, on revient au login
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && _profile) window.location.reload();
  });

  try {
    const session = await getSession();
    if (!session) return showScreen('auth');

    const profile = await getProfile();
    if (!profile) {
      return denyAccess('Profil introuvable. Déconnectez-vous puis reconnectez-vous.');
    }
    if (!profile.active) {
      return denyAccess('Votre compte est désactivé. Contactez l\'administrateur.');
    }
    if (!allowedRoles.includes(profile.role)) {
      const home = ROLE_HOME[profile.role];
      const isHere = home && window.location.pathname.endsWith(home);
      return denyAccess(
        'Votre compte Google (' + profile.email + ') n\'a pas accès à cette interface.',
        isHere ? null : home,
        isHere ? '' : 'Aller à mon espace (' + (ROLE_LABELS[profile.role] || profile.role) + ')'
      );
    }

    fillUserInfo(profile);
    showScreen('app');
    await onReady(profile);
  } catch (err) {
    console.error('[initPage]', err);
    denyAccess(friendlyError(err));
  }
}


/* =====================================================================
 * 5. REALTIME
 *    Les événements respectent la RLS : un client ne reçoit QUE les
 *    changements de ses propres colis.
 * ===================================================================== */

/**
 * S'abonne aux changements d'une table.
 * @param {string}   table     ex. 'packages'
 * @param {Function} callback  reçoit { eventType, new, old }
 * @param {string}   [filter]  ex. 'client_id=eq.<uuid>'
 * @returns {Function} fonction à appeler pour se désabonner
 */
export function subscribeToTable(table, callback, filter) {
  const channel = supabase
    .channel('rt-' + table + '-' + Math.random().toString(36).slice(2, 8))
    .on('postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        callback)
    .subscribe();
  return () => supabase.removeChannel(channel);
}


/* =====================================================================
 * 6. PHOTOS DES COLIS (bucket privé -> liens signés temporaires)
 * ===================================================================== */

/** Transforme des chemins Storage en URLs temporaires affichables. */
export async function getPhotoUrls(paths = []) {
  if (!paths.length) return [];
  const { data, error } = await supabase.storage
    .from(APP.photosBucket).createSignedUrls(paths, APP.signedUrlTtl);
  if (error) throw error;
  return data.filter((d) => d.signedUrl).map((d) => d.signedUrl);
}


/* =====================================================================
 * 7. UTILITAIRES
 * ===================================================================== */

/** Échappe le HTML : à utiliser sur TOUTE donnée affichée via innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
  ));
}

/** Convertit une erreur Supabase / PostgreSQL en message clair en français. */
export function friendlyError(err) {
  const code = err?.code;
  const msg = err?.message || '';
  if (code === '23505') return 'Cet enregistrement existe déjà (numéro de suivi déjà déclaré ?).';
  if (code === '42501' || /row-level security/i.test(msg)) return 'Action non autorisée pour votre rôle.';
  if (code === 'P0001') return msg;                         // règles métier (raise exception)
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Connexion impossible. Vérifiez votre réseau.';
  if (/JWT|session/i.test(msg)) return 'Session expirée. Reconnectez-vous.';
  return msg || 'Une erreur est survenue.';
}

/** Montant en devise locale : 125000 -> « 125 000 FCFA ». */
export function formatMoney(amount) {
  if (amount === null || amount === undefined) return '—';
  const n = new Intl.NumberFormat(APP.locale, { maximumFractionDigits: 0 }).format(amount);
  return APP.currency === 'XOF' ? n + ' FCFA' : n + ' ' + APP.currency;
}

/** Date lisible : 17 nov. 2026 (+ heure si withTime). */
export function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(APP.locale, {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(iso));
}

export const formatWeight = (kg) => (kg == null ? '—' : Number(kg).toLocaleString(APP.locale) + ' kg');
export const formatVolume = (m3) => (m3 == null ? '—' : Number(m3).toLocaleString(APP.locale) + ' m³');

export const statusLabel = (status) => STATUS_LABELS[status] || status;
export const modeLabel   = (mode) => SHIPPING_MODES[mode]?.label || mode;

/** Pastille de statut : <span class="badge badge--in_transit">En transit</span> */
export function statusBadge(status) {
  return '<span class="badge badge--' + escapeHtml(status) + '">' + escapeHtml(statusLabel(status)) + '</span>';
}

/** Limite la fréquence d'un appel (ex. recherche pendant la frappe). */
export function debounce(fn, delay = 300) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

/**
 * Notification temporaire (type : 'info' | 'success' | 'error').
 * Le style (.toast-container, .toast, .toast--success...) est dans style.css.
 */
export function toast(message, type = 'info', duration = 4000) {
  let box = $('.toast-container');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast-container';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast toast--' + type;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), duration);
}


/* =====================================================================
 * 8. KIT UI PARTAGÉ (portails admin, entrepôt Chine, agence Bénin)
 *    Même vocabulaire visuel que l'espace client (style.css).
 *    Ids HTML requis selon l'usage :
 *      menu      : #btn-menu  #sidebar  #overlay  #nav
 *      modale    : #modal #modal-title #modal-body #modal-close
 *      confirm   : #confirm #confirm-title #confirm-text #confirm-ok
 *      contenu   : #view
 * ===================================================================== */

export { $, $$ };

/* ----- 8.1 Icônes SVG ----- */
export const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  plus: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  plusSimple: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  megaphone: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plane: '<path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  ship: '<path d="M2 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M4 14l2-8h12l2 8"/><path d="M12 6V2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  card: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 8a3 3 0 0 0 6 0z"/><path d="M19 7l-3 8a3 3 0 0 0 6 0z"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  scan: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
};

/** SVG d'une icône : icon('home', 20) */
export const icon = (name, size = 20) =>
  '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  (ICONS[name] || '') + '</svg>';

/* ----- 8.2 Nombres & blocs HTML ----- */
export const num = (v) => parseFloat(String(v ?? '').replace(',', '.')) || 0;
export const fmtNum = (n, digits = 2) =>
  Number(n).toLocaleString(APP.locale, { maximumFractionDigits: digits });

export function pageHead(title, sub = '', actions = '') {
  return '<div class="page-head"><div><h1 class="page-title">' + escapeHtml(title) + '</h1>' +
    (sub ? '<p class="page-sub">' + escapeHtml(sub) + '</p>' : '') + '</div>' + actions + '</div>';
}

export function emptyState(iconName, title, text, actionHtml = '') {
  return '<div class="empty"><span class="empty__icon">' + icon(iconName, 26) + '</span>' +
    '<h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(text) + '</p>' + actionHtml + '</div>';
}

export const skeleton = () =>
  '<div class="skeleton skeleton--title"></div><div class="skeleton-grid">' +
  '<div class="skeleton skeleton--card"></div>'.repeat(4) + '</div>';

/** Bouton « en cours » : texte temporaire puis restauration du contenu d'origine */
const busyHtml = new WeakMap();
export function setBusy(btn, busy, label) {
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

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copié dans le presse-papiers', 'success', 2200); }
  catch { toast('Copie impossible : sélectionnez le texte manuellement.', 'error'); }
}

/**
 * Lit TOUTES les lignes d'une requête (Supabase limite à 1000 lignes par appel).
 * @param {Function} buildQuery  () => supabase.from(...).select(...)  (nouvelle requête à chaque appel)
 */
export async function fetchAll(buildQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/* ----- 8.3 Modales ----- */
export function openModal(title, bodyHtml, dataset = {}) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  Object.assign(dlg.dataset, dataset);
  if (!dlg.open) dlg.showModal();
}

export function closeModal() {
  const dlg = $('#modal');
  if (dlg.open) dlg.close();
}

/** Fermeture par la croix et par clic sur le fond sombre */
export function bindModalBasics() {
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#modal').addEventListener('close', stopScanner);      // fermer la fenêtre coupe la caméra
}

/* ----- 8.3b Scanner de code-barres / QR par la caméra -----
 *  Disponible seulement si le navigateur gère BarcodeDetector (surtout Chrome
 *  Android). Prévoir un champ de saisie : une douchette USB fonctionne comme un clavier. */
let scanStop = null;

export const canScanBarcodes = () => 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

export function stopScanner() {
  scanStop?.();
  scanStop = null;
}

/** Ouvre la caméra dans la modale ; onResult(texteLu) est appelée au premier code détecté. */
export async function openScanner(onResult) {
  openModal('Scanner un code',
    '<div class="scan"><div class="scan__frame"><video id="scan-video" playsinline muted autoplay></video></div>' +
    '<p class="muted">Cadrez le code-barres ou le QR code de l\'étiquette du colis.</p></div>', { kind: 'scanner' });

  let stopped = false;
  let stream = null;
  scanStop = () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    scanStop = null;
    closeModal();
    return toast('Caméra inaccessible : autorisez-la dans le navigateur.', 'error', 6000);
  }
  if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }   // fermé pendant l'autorisation

  const video = $('#scan-video');
  if (!video) return stopScanner();
  video.srcObject = stream;
  await video.play().catch(() => {});

  const detector = new BarcodeDetector();
  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length && codes[0].rawValue) {
        const value = codes[0].rawValue;
        stopScanner();
        closeModal();
        return onResult(value);
      }
    } catch { /* image pas encore prête : on réessaie */ }
    setTimeout(tick, 250);
  };
  tick();
}

/** Confirmation : Promise<boolean> */
export function askConfirm({ title, message, confirmLabel = 'Confirmer', danger = false }) {
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

/* ----- 8.4 Menu latéral : construction, tiroir mobile, pastilles ----- */

/** groups = [['Titre', ['idSection', ...]], ...] ; sections = { id: {label, icon} } */
export function renderNav(groups, sections) {
  $('#nav').innerHTML = groups.map(([title, ids]) =>
    '<div class="nav-group"><p class="nav-group__title">' + escapeHtml(title) + '</p>' +
    ids.map((id) =>
      '<a class="nav-link" href="#/' + id + '" data-nav="' + id + '">' + icon(sections[id].icon) +
      '<span>' + escapeHtml(sections[id].label) + '</span>' +
      '<span class="nav-badge" data-badge="' + id + '" hidden></span></a>').join('') + '</div>').join('');
}

export function highlightNav(id) {
  $$('[data-nav]').forEach((a) => {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** Pastille numérique d'un élément du menu (0 = masquée) */
export function setBadge(id, count) {
  const el = $('[data-badge="' + id + '"]');
  if (el) { el.textContent = count; el.hidden = !count; }
}

export function bindDrawer() {
  const toggle = (open) => {
    $('#sidebar').classList.toggle('is-open', open);
    $('#overlay').hidden = !open;
    $('#btn-menu')?.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  };
  $('#btn-menu')?.addEventListener('click', () => toggle(true));
  $('#overlay')?.addEventListener('click', () => toggle(false));
  document.addEventListener('click', (e) => { if (e.target.closest('#sidebar a')) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
  window.addEventListener('resize', () => { if (window.innerWidth >= 1024) toggle(false); });
  return toggle;
}

/* ----- 8.5 Routeur générique (hash #/section?cle=valeur) -----
 *  sections : { id: { label, icon, render(params) -> Promise<html>, mount?(view, params) } }
 *  Retourne { route, navigate, refresh } ; route = { id, params } (toujours à jour). */
export function createRouter({ sections, defaultId, view = '#view', onChange }) {
  let token = 0;                       // ignore les réponses d'une navigation périmée
  const route = { id: defaultId, params: {} };

  const parse = () => {
    const [id, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    return { id: sections[id] ? id : defaultId, params: Object.fromEntries(new URLSearchParams(query)) };
  };

  async function refresh({ keepScroll = false } = {}) {
    const mine = ++token;
    const el = $(view);
    const section = sections[route.id];
    const scrollY = window.scrollY;
    try {
      const html = await section.render(route.params);
      if (mine !== token) return;
      el.innerHTML = html;
      if (section.mount) await section.mount(el, route.params);
    } catch (err) {
      if (mine !== token) return;
      console.error('[section ' + route.id + ']', err);
      el.innerHTML = '<div class="alert alert--error">' + icon('alert') +
        '<span>' + escapeHtml(friendlyError(err)) + '</span>' +
        '<button class="btn btn--ghost btn--sm" id="btn-retry" type="button">Réessayer</button></div>';
      $('#btn-retry')?.addEventListener('click', () => navigate());
    }
    if (!keepScroll) { window.scrollTo(0, 0); el.focus?.({ preventScroll: true }); }
    else window.scrollTo(0, scrollY);
  }

  async function navigate() {
    const next = parse();
    route.id = next.id;
    route.params = next.params;
    onChange?.(route.id, route.params);
    $(view).innerHTML = skeleton();
    await refresh();
  }

  window.addEventListener('hashchange', navigate);
  return { route, navigate, refresh };
}
