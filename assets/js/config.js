/* =====================================================================
 *  config.js  |  Configuration centrale (importée par les 4 pages)
 * =====================================================================
 *  - Les clés Supabase ci-dessous sont PUBLIQUES par conception : la sécurité
 *    repose sur la RLS définie dans schema.sql, pas sur le secret de la clé.
 *  - N'écrivez JAMAIS ici la clé "service_role" : elle contourne la RLS.
 *  - La liste blanche des admins / employés N'EST PAS ici : elle vit dans la
 *    table public.authorized_staff de Supabase (alimentée par votre SQL).
 *
 *  Les pages utilisent des modules ES (<script type="module">) : servez le
 *  projet via http(s) (ex. extension VS Code "Live Server"), pas en file://.
 * ===================================================================== */


/* ---------------------------------------------------------------------
 * 1. SUPABASE  (Dashboard > Project Settings > API)
 * --------------------------------------------------------------------- */
export const SUPABASE_URL      = 'https://VOTRE-PROJET.supabase.co';
export const SUPABASE_ANON_KEY = 'VOTRE_CLE_ANON_PUBLIQUE';


/* ---------------------------------------------------------------------
 * 2. PARAMÈTRES GÉNÉRAUX DE L'APPLICATION
 * --------------------------------------------------------------------- */
export const APP = {
  name: 'Transit Chine-Bénin',
  currency: 'XOF',            // doit correspondre à la devise des tarifs (rates)
  locale: 'fr-FR',
  photosBucket: 'package-photos',   // bucket Storage créé par schema.sql
  maxPhotoSizeMB: 5,                // limite du bucket
  signedUrlTtl: 3600,               // durée de validité des liens photo (secondes)
};


/* ---------------------------------------------------------------------
 * 3. RÔLES  (identiques à l'enum user_role de schema.sql)
 * --------------------------------------------------------------------- */
export const ROLES = {
  CLIENT: 'client',
  ADMIN:  'admin',
  CHINA:  'china_staff',
  BENIN:  'benin_staff',
};

export const ROLE_LABELS = {
  client:      'Client',
  admin:       'Administrateur',
  china_staff: 'Employé Entrepôt Chine',
  benin_staff: 'Employé Agence Bénin',
};

/** Page d'accueil de chaque rôle (utilisée pour rediriger / orienter) */
export const ROLE_HOME = {
  client:      'index.html',
  admin:       'admin.html',
  china_staff: 'entrepot-chine.html',
  benin_staff: 'agence-benin.html',
};


/* ---------------------------------------------------------------------
 * 4. STATUTS DES COLIS  (identiques à l'enum package_status)
 *    L'ordre de STATUS_ORDER sert à la frise de suivi côté client.
 * --------------------------------------------------------------------- */
export const PACKAGE_STATUS = {
  DECLARED:         'declared',
  RECEIVED_CHINA:   'received_china',
  IN_TRANSIT:       'in_transit',
  ARRIVED_BENIN:    'arrived_benin',
  AVAILABLE_AGENCY: 'available_agency',
  DELIVERED:        'delivered',
};

export const STATUS_ORDER = [
  'declared', 'received_china', 'in_transit',
  'arrived_benin', 'available_agency', 'delivered',
];

export const STATUS_LABELS = {
  declared:         'Déclaré',
  received_china:   'Réceptionné en Chine',
  in_transit:       'En transit',
  arrived_benin:    'Arrivé à Cotonou',
  available_agency: 'Disponible à l\'agence',
  delivered:        'Livré',
};

/** Date associée à chaque statut (colonne de la table packages) */
export const STATUS_DATE_FIELD = {
  declared:         'created_at',
  received_china:   'received_china_at',
  in_transit:       'in_transit_at',
  arrived_benin:    'arrived_at',
  available_agency: 'available_at',
  delivered:        'delivered_at',
};


/* ---------------------------------------------------------------------
 * 5. MODES D'EXPÉDITION, PAIEMENT, LOTS, LITIGES
 * --------------------------------------------------------------------- */
export const SHIPPING_MODES = {
  air: { label: 'Aérien',   unit: 'kg', rateLabel: 'prix / kg' },
  sea: { label: 'Maritime', unit: 'm³', rateLabel: 'prix / m³' },
};

export const PAYMENT_STATUS_LABELS = { unpaid: 'Non payé', paid: 'Payé' };

export const PAYMENT_METHOD_LABELS = {
  prepaid:     'Payé d\'avance',
  on_delivery: 'Paiement à la livraison',
};

export const SHIPMENT_STATUS_LABELS = {
  preparing:  'En préparation',
  in_transit: 'En transit',
  arrived:    'Arrivé à Cotonou',
  closed:     'Clôturé',
};

export const SHIPMENT_KIND_LABELS = {
  lot: 'Lot', container: 'Conteneur', flight: 'Vol',
};

export const DISPUTE_STATUS_LABELS = {
  open:      'Ouvert',
  in_review: 'En cours d\'examen',
  resolved:  'Résolu',
  rejected:  'Rejeté',
};
