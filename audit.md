# OpenWatchParty - Rapport d'Audit Complet

**Date :** 2026-01-16
**Version analysée :** Commit d300c04 (main)
**Scope :** Documentation, Serveur Rust, Plugin Jellyfin C#, Client Web JavaScript, Infrastructure

---

## Table des Matières

1. [Résumé Exécutif](#1-résumé-exécutif)
2. [Documentation](#2-documentation)
3. [Serveur Rust](#3-serveur-rust)
4. [Plugin Jellyfin C#](#4-plugin-jellyfin-c)
5. [Client Web JavaScript](#5-client-web-javascript)
6. [Infrastructure & CI/CD](#6-infrastructure--cicd)
7. [Sécurité](#7-sécurité)
8. [Plan d'Action Recommandé](#8-plan-daction-recommandé)

---

## 1. Résumé Exécutif

### Vue d'Ensemble

OpenWatchParty est un projet bien architecturé avec une documentation de qualité supérieure à la moyenne des projets open-source. Le code est propre, bien structuré et fonctionnellement prêt pour la production.

### Points Forts

- Architecture modulaire claire (3 composants distincts)
- Algorithme de synchronisation sophistiqué avec correction de drift
- Documentation technique détaillée (protocole WebSocket, algorithmes sync)
- Bonnes pratiques de sécurité (JWT, rate limiting, validation d'entrée)
- Optimisations de performance déjà appliquées

### Points Faibles Majeurs

- **Aucun test automatisé** (0 tests unitaires, 0 tests d'intégration)
- **Aucune CI/CD** (pas de GitHub Actions)
- **Incohérences documentation/code** sur les valeurs de timing
- **CHANGELOG.md manquant** malgré références multiples

### Statistiques

| Métrique | Valeur |
|----------|--------|
| Problèmes critiques | 5 (2 corrigés) |
| Problèmes haute priorité | 12 (3 doc + 2 Rust + 2 C# + 4 JS corrigés) |
| Problèmes moyenne priorité | 15 (3 doc + 2 Rust + 1 C# + 1 JS corrigés) |
| Problèmes basse priorité | 10 (3 doc + 1 C# + 1 JS corrigés) |
| Tests unitaires | **27** (Rust) + **31** (C#) = **58** |
| Couverture CI/CD | **0%** |

---

## 2. Documentation

### 2.1 Évaluation Globale

**Qualité : Bonne** - Documentation complète et bien organisée avec quelques incohérences à corriger.

### 2.2 Problèmes Critiques

#### 2.2.1 CHANGELOG.md Manquant

**Sévérité :** Critique
**Localisation :** Racine du projet
**Statut :** CORRIGÉ

Le fichier `CHANGELOG.md` est référencé mais n'existe pas :
- `docs/product/features.md` ligne 95 : `See the [CHANGELOG](../../CHANGELOG.md)`
- `docs/development/release.md` lignes 109, 308

**Impact :** Liens cassés, utilisateurs ne peuvent pas voir l'historique des versions.

**Action :** ~~Créer `CHANGELOG.md` avec l'historique des releases.~~

**Correction appliquée :** Fichier `CHANGELOG.md` créé avec l'historique des versions basé sur les commits git.

#### 2.2.2 Incohérences Valeurs de Timing

**Sévérité :** Critique
**Localisation :** `docs/technical/sync.md`, `docs/technical/client.md`
**Statut :** CORRIGÉ

| Paramètre | Documentation | Code Réel | Corrigé |
|-----------|---------------|-----------|---------|
| `PLAY_SCHEDULE_MS` | 1500ms | 1000ms | sync.md déjà correct |
| `SYNC_LEAD_MS` | 120ms | 300ms | sync.md corrigé |
| `DRIFT_GAIN` | 0.20 (client.md) | 0.50 | client.md corrigé |
| Plage playbackRate | 0.95-1.05x | 0.85-2.0x | client.md et sync.md corrigés |
| `DRIFT_SOFT_MAX` | 2.5s (client.md) | 2.0s | client.md corrigé |

**Impact :** Développeurs et utilisateurs auront des attentes incorrectes sur le comportement de synchronisation.

**Action :** ~~Mettre à jour la documentation pour refléter les valeurs réelles du code.~~

**Corrections appliquées :**
- `docs/technical/client.md` : `DRIFT_GAIN` 0.20 → 0.50, `PLAYBACK_RATE_MAX` 1.50 → 2.0, `DRIFT_SOFT_MAX` 2.5s → 2.0s, formule syncLoop corrigée
- `docs/technical/sync.md` : `SYNC_LEAD_MS` commentaire 120ms → 300ms, `clamp` max 1.50 → 2.0, visualisation rate max 1.50 → 2.0

### 2.3 Problèmes Haute Priorité

#### 2.3.1 Home Section Non Documentée

**Sévérité :** Haute
**Localisation :** `docs/product/features.md`, `docs/product/user-guide.md`
**Statut :** CORRIGÉ

La fonctionnalité "Home section - Watch parties shown on Jellyfin homepage" est mentionnée mais :
- Aucune documentation d'utilisation
- Pas de screenshots
- Non expliquée dans le guide utilisateur

**Action :** ~~Ajouter section dans user-guide.md avec captures d'écran.~~

**Correction appliquée :** Section "From the Homepage" dans user-guide.md entièrement réécrite avec :
- Explication détaillée du fonctionnement
- Description des éléments affichés sur les cartes
- Options de join (clic carte vs bouton play)
- Notes sur le comportement (refresh, authentification)

#### 2.3.2 Limitations JWT Non Documentées

**Sévérité :** Haute
**Localisation :** `docs/operations/security.md`
**Statut :** CORRIGÉ

Manque une section "Ce que l'authentification JWT ne protège PAS" :
- N'empêche pas la création de rooms par utilisateurs non authentifiés
- N'empêche pas le join de rooms sans mot de passe
- Pas de révocation de tokens possible

**Action :** ~~Ajouter section sur les limitations de sécurité.~~

**Correction appliquée :** Nouvelle section "What JWT Authentication Does NOT Protect" ajoutée avec :
- Tableau des scénarios non protégés et mitigations
- Documentation du cycle de vie des tokens
- Diagramme du modèle de confiance
- Recommandations selon le type d'instance

#### 2.3.3 Compatibilité Navigateurs Incomplète

**Sévérité :** Haute
**Localisation :** `docs/product/features.md` lignes 47-54
**Statut :** CORRIGÉ

| Navigateur | Statut Documenté | Problème |
|------------|------------------|----------|
| Safari | "Supported" | Problèmes HLS connus non documentés |
| Mobile | "Partial" | Aucune explication de ce qui fonctionne/ne fonctionne pas |
| Tous | - | Aucune version minimum spécifiée |

**Action :** ~~Détailler les versions supportées et limitations connues.~~

**Correction appliquée :** Section navigateurs entièrement réécrite avec :
- Versions minimum pour chaque navigateur (Chrome 80+, Firefox 75+, Safari 14+, etc.)
- Section "Safari Known Issues" détaillant les problèmes HLS et workarounds
- Section "Mobile Browser Limitations" avec tableau comparatif desktop/mobile
- Notes spécifiques iOS Safari, Android Chrome, data saver modes

### 2.4 Problèmes Moyenne Priorité

#### 2.4.1 API Configuration Incomplète

**Localisation :** `docs/technical/api.md` lignes 192-223
**Statut :** CORRIGÉ

- Champs de configuration sans explication
- `InviteTtlSeconds` documenté mais apparemment inutilisé
- Comportement de `SessionServerUrl` vide non clarifié

**Correction appliquée :** Section "Configuration Fields Reference" ajoutée avec :
- Tableau complet des 10 champs de configuration avec types, valeurs par défaut et descriptions
- `InviteTtlSeconds` marqué comme "Reserved for future use"
- Section "SessionServerUrl Behavior" expliquant le comportement auto-detect vs URL explicite

#### 2.4.2 Cas Limites Non Documentés

**Localisation :** Documentation générale
**Statut :** CORRIGÉ

Scénarios non documentés :
- Comportement quand plusieurs clients rejoignent rapidement
- Que se passe-t-il si le réseau du host tombe
- Seuils de tolérance du décalage d'horloge
- Taille de room maximale recommandée
- Dégradation de performance à N connexions

**Correction appliquée :** Sections ajoutées à `docs/technical/architecture.md` :
- "Operational Limits" avec tableaux des contraintes et performances
- "Edge Cases and Behavior" documentant :
  - Multiple Clients Joining Rapidly
  - Host Network Disconnect (avec diagramme)
  - Clock Skew Tolerance (tableau par niveau)
  - Buffering and HLS Edge Cases
  - Room Capacity and Scaling (avec projections)
  - Reconnection Behavior

#### 2.4.3 Glossaire Manquant

**Statut :** CORRIGÉ

Termes techniques utilisés sans définition :
- HLS (HTTP Live Streaming)
- RTT (Round-Trip Time)
- EMA (Exponential Moving Average)

**Correction appliquée :** Section "Glossary" ajoutée à `docs/README.md` avec définitions de :
- HLS, RTT, EMA, JWT, CORS, WebSocket, Drift, Host

### 2.5 Problèmes Basse Priorité

**Statut :** CORRIGÉ

- ~~Références croisées incohérentes entre fichiers~~
- ~~Diagrammes d'architecture incomplets (flux de déconnexion manquant)~~
- ~~Guide de troubleshooting incomplet (pas de HLS, rate limiting)~~

**Corrections appliquées :**

1. **Références croisées ajoutées** à `docs/operations/troubleshooting.md` :
   - Liens vers Architecture Edge Cases, Security Guide, Configuration
   - Liens vers sections spécifiques (Host Network Disconnect, Clock Skew Tolerance, Sync Algorithms)

2. **Diagrammes d'architecture** ajoutés à `docs/technical/architecture.md` :
   - "Leaving a Room (Normal Disconnect)" - flux participant → server → host
   - "Host Disconnect (Room Closure)" - flux de fermeture de room

3. **Guide de troubleshooting** enrichi avec nouvelles sections :
   - "HLS Streaming Issues" : symptômes, explication HLS, 5 solutions détaillées, lien vers doc technique
   - "Rate Limiting Issues" : tableau des limites, 4 solutions avec commandes de debug

---

## 3. Serveur Rust

### 3.1 Évaluation Globale

**Qualité : Bonne** - Code propre et bien structuré, prêt pour la production.

**Statistiques :**
- Lignes de code : ~1200 (7 modules)
- Compilation : Clean (aucun warning Clippy)
- Tests : **27** (utils, auth, types, ws)

### 3.2 Architecture

```
server/
├── src/
│   ├── main.rs      # Setup serveur, routes
│   ├── ws.rs        # Gestion messages WebSocket
│   ├── room.rs      # Cycle de vie des rooms
│   ├── messaging.rs # Transmission des messages
│   ├── auth.rs      # Validation JWT
│   ├── types.rs     # Structures de données
│   └── utils.rs     # Utilitaires
└── Cargo.toml
```

### 3.3 Points Forts

1. **Séparation des concerns** - Modules bien délimités
2. **Async/Await propre** - Pas de `.block_on()` dans contexte async
3. **Validation d'entrée robuste** :
   - Position : vérifie NaN, Infinity, plages valides
   - Media ID : vérifie 32 caractères hex
   - Play state : whitelist "playing"/"paused"
   - Taille message : limite 64KB
4. **Rate limiting** : 30 msg/sec par client
5. **Détection connexions zombies** : timeout 60s

### 3.4 Problèmes Critiques

Aucun problème critique identifié dans le code.

### 3.5 Problèmes Haute Priorité

#### 3.5.1 Aucun Test Unitaire

**Sévérité :** Haute
**Statut :** CORRIGÉ

~~Tests nécessaires :~~
- ~~Logique rate limiting (`check_rate_limit`)~~
- ~~Validation position (`is_valid_position`)~~
- ~~Cycle de vie room (create, join, leave, close)~~
- ~~Flux d'authentification~~
- ~~Gestion des types de messages~~

**Corrections appliquées :**
- 27 tests unitaires ajoutés couvrant :
  - `utils.rs` : `now_ms()` valeurs et monotonicité
  - `auth.rs` : entropie (6 tests), validation JWT (3 tests)
  - `types.rs` : sérialisation/désérialisation enum (6 tests)
  - `ws.rs` : validation position, play_state, media_id, noms (12 tests)

#### 3.5.2 Dispatch par String

**Sévérité :** Haute
**Statut :** CORRIGÉ

~~**Problème :** Typos dans les types de messages tombent silencieusement dans le handler par défaut.~~

**Corrections appliquées :**
- Création de `ClientMessageType` enum avec `#[serde(rename_all = "snake_case")]`
- Création de `IncomingMessage` struct utilisant l'enum
- Variante `Unknown` avec `#[serde(other)]` capture les types inconnus
- Match exhaustif sur l'enum au lieu de strings
- Les types inconnus génèrent maintenant un warning et une erreur client

### 3.6 Problèmes Moyenne Priorité

#### 3.6.1 Validation Noms Manquante

**Localisation :** `ws.rs`
**Statut :** CORRIGÉ

~~Les noms d'utilisateur et de room ne sont pas validés :~~
- ~~Pas de limite de longueur~~
- ~~Pas de validation de contenu~~

**Corrections appliquées :**
- Ajout de `const MAX_NAME_LENGTH: usize = 100;`
- Fonction `is_valid_name()` : vérifie longueur et absence de caractères de contrôle
- Fonction `sanitize_name()` : trim, tronque, supprime caractères de contrôle
- Validation appliquée dans handlers `auth` et `create_room`

#### 3.6.2 Vérification Entropie JWT Simpliste

**Localisation :** `auth.rs`
**Statut :** CORRIGÉ

~~**Problème :** "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" passe le test mais a une entropie terrible.~~

**Corrections appliquées :**
- Implémentation de `calculate_entropy()` utilisant l'entropie de Shannon
- Seuil minimum de 80 bits (inspiré NIST SP 800-63B)
- Avertissement log avec valeur d'entropie calculée vs recommandée
- 6 tests unitaires couvrant divers patterns d'entropie

#### 3.6.3 Logs Non Structurés

**Localisation :** Tout le code

```rust
info!("Client {} authenticated as {}", client_id, claims.name);
```

**Recommandation :** Migrer vers `tracing` avec logs structurés JSON pour meilleure analyse.

**Note :** Non corrigé - migration vers tracing est un changement plus important qui peut être fait ultérieurement.

### 3.7 Fonctionnalités Manquantes

| Fonctionnalité | Statut | Priorité |
|----------------|--------|----------|
| Tests unitaires | **FAIT** (27 tests) | ~~Haute~~ |
| Métriques Prometheus | Manquant | Moyenne |
| Mots de passe room | Planifié | Moyenne |
| Permissions utilisateur | Planifié | Basse |
| Révocation tokens | Manquant | Basse |
| Persistance rooms | By design (in-memory) | - |

### 3.8 Dépendances

| Package | Version | Statut |
|---------|---------|--------|
| tokio | - | Actif, bien maintenu |
| warp | - | Standard industrie |
| serde | - | Fiable |
| jsonwebtoken | - | Purpose-built |
| uuid | - | Standard |

**Recommandation :** Activer Dependabot pour mises à jour sécurité.

---

## 4. Plugin Jellyfin C#

### 4.1 Évaluation Globale

**Qualité : Bonne** - Suit les patterns Jellyfin, bonnes pratiques de sécurité.

**Statistiques :**
- Lignes de code : ~300
- Framework : .NET 9.0
- Jellyfin : 10.11.3
- Tests : **31** (PluginTests, PluginConfigurationTests)

### 4.2 Architecture

```
plugins/jellyfin/OpenWatchParty/
├── Plugin.cs                    # Classe principale
├── Controllers/
│   └── OpenWatchPartyController.cs  # API endpoints
├── Configuration/
│   └── PluginConfiguration.cs   # Schéma config
└── Web/
    ├── configPage.html          # UI configuration
    └── plugin.js                # Loader client
```

### 4.3 Points Forts

1. **JWT bien implémenté** :
   - Claims appropriés (sub, name, aud, iss, iat, jti)
   - TTL court par défaut (3600s)
   - ID unique par token

2. **Rate limiting** : 30 tokens/min/user avec cleanup périodique

3. **Performance** :
   - Cache statique script et ETag
   - Credentials JWT cachés
   - Handler JWT singleton

4. **Validation** :
   - Nullable reference types activés
   - Data annotations sur configuration
   - Vérification null appropriée

### 4.4 Problèmes Haute Priorité

#### 4.4.1 UI Configuration Incomplète

**Sévérité :** Haute
**Localisation :** `Web/configPage.html`
**Statut :** CORRIGÉ

~~Champs définis dans `PluginConfiguration.cs` mais non exposés dans l'UI :~~
- ~~`SessionServerUrl`~~
- ~~`DefaultMaxBitrate`~~
- ~~`PreferDirectPlay`~~
- ~~`AllowHostQualityControl`~~

**Corrections appliquées :**
- Page de configuration entièrement réécrite avec 3 sections : Authentication, Session Server, Quality Control
- Ajout de tous les champs manquants avec descriptions et validations appropriées
- `DefaultMaxBitrate` : dropdown avec options prédéfinies (Auto, 4K, 1080p, 720p, 480p, 360p)
- `SessionServerUrl` : champ texte avec placeholder "Auto-detect"
- Checkboxes pour `PreferDirectPlay` et `AllowHostQualityControl`
- Ajout de `TokenTtlSeconds` avec min/max HTML5

#### 4.4.2 Aucun Test Unitaire

**Sévérité :** Haute
**Statut :** CORRIGÉ

~~Tests nécessaires :~~
- ~~Génération JWT avec différents claims~~
- ~~Logique rate limiting~~
- ~~Validation configuration~~
- ~~Caching script~~

**Corrections appliquées :**
- 31 tests unitaires ajoutés dans `OpenWatchParty.Tests/`
- `PluginTests.cs` : 4 tests pour validation constantes (GUID format, valeur, version)
- `PluginConfigurationTests.cs` : 27 tests couvrant :
  - Valeurs par défaut de chaque champ
  - Validation et clamping des TTL (TokenTtlSeconds, InviteTtlSeconds)
  - Clamping DefaultMaxBitrate (valeurs négatives → 0)
  - Comportement null → empty pour JwtSecret
  - Valeurs par défaut booléens (PreferDirectPlay, AllowHostQualityControl)

### 4.5 Problèmes Moyenne Priorité

#### 4.5.1 Race Condition Cache Statique

**Localisation :** `OpenWatchPartyController.cs`
**Statut :** CORRIGÉ

~~**Problème :**~~
```csharp
if (_cachedScript == null) {
    // Multiple threads peuvent entrer ici simultanément
    _cachedScript = LoadScript();
}
```

**Corrections appliquées :**
- Utilisation de `Lazy<T>` avec `LazyThreadSafetyMode.ExecutionAndPublication`
- Méthode `LoadScriptFromResource()` charge le script depuis embedded resource
- Génération ETag SHA256 au chargement
- Initialisation thread-safe garantie

#### 4.5.2 Changement Secret JWT

**Problème :** Quand le secret JWT est changé, les anciens tokens restent valides jusqu'à expiration (1h par défaut).

**Recommandation :** Implémenter mécanisme de révocation ou documenter ce comportement.

### 4.6 Problèmes Basse Priorité

#### 4.6.1 GUID Plugin en Dur

**Localisation :** `Plugin.cs`, `configPage.html`
**Statut :** CORRIGÉ

~~Le GUID apparaît à deux endroits - risque de désynchronisation.~~

**Corrections appliquées :**
- `Plugin.cs` : Constante `public const string PluginGuid` définit la valeur unique
- `OpenWatchPartyController.cs` : Nouvel endpoint `GET /OpenWatchParty/Info` retourne l'ID du plugin
- `configPage.html` : Récupère le GUID dynamiquement via API au lieu de hardcoder
- Fallback vers GUID hardcodé si l'API échoue (graceful degradation)

#### 4.6.2 Valeurs Hardcodées

- Cache max-age : 3600s
- Cleanup interval : 5 min

**Recommandation :** Rendre configurable.

---

## 5. Client Web JavaScript

### 5.1 Évaluation Globale

**Qualité : Bonne** - Architecture modulaire, algorithme sync sophistiqué.

### 5.2 Architecture

```
clients/web-plugin/
├── state.js     # État global, constantes
├── utils.js     # Utilitaires (getVideo, escapeHtml, etc.)
├── ui.js        # Interface utilisateur, panels
├── playback.js  # Contrôle lecture, sync loop
├── ws.js        # WebSocket, messages
├── app.js       # Initialisation, lifecycle
└── plugin.js    # Loader (injection Jellyfin)
```

**Ordre de chargement :** `state.js` → `utils.js` → `ui.js`/`playback.js` → `ws.js` → `app.js`

### 5.3 Points Forts

1. **Algorithme de synchronisation** :
   - Correction drift avec courbe sqrt (smooth)
   - Clock sync type NTP avec lissage EMA
   - Handling initial sync vs normal sync
   - Cooldown après resume pour éviter jitter

2. **Gestion mémoire** :
   - Listeners video nommés pour cleanup propre
   - Intervals trackés et nettoyés
   - Cache LRU pour URLs images

3. **Sécurité** :
   - Escape HTML pour noms de room
   - Token JWT pas dans l'URL
   - Warning pour ws:// sur https:

### 5.4 Problèmes Haute Priorité

#### 5.4.1 Erreurs JSON Silencieuses

**Sévérité :** Haute
**Localisation :** `ws.js`
**Statut :** CORRIGÉ

~~**Problème :** Aucun logging dans le catch block.~~

```javascript
state.ws.onmessage = (e) => {
  try {
    const msg = JSON.parse(e.data);
    // ...
  } catch (err) {}  // Aucun logging !
};
```

**Corrections appliquées :**
- Ajout de `console.error()` avec message d'erreur et extrait des données
- Logging du contenu tronqué (100 premiers caractères) pour debug

#### 5.4.2 Token Jamais Rafraîchi

**Sévérité :** Haute
**Localisation :** `ws.js`
**Statut :** CORRIGÉ

~~**Problème :** Le token est récupéré une fois au démarrage mais jamais rafraîchi.~~

**Corrections appliquées :**
- Tracking de l'expiration du token (`tokenExpiresAt` dans state)
- Fonction `scheduleTokenRefresh()` planifie le refresh automatique
- Refresh effectué 5 min avant expiration (ou 80% du TTL pour tokens courts)
- Re-authentification automatique via WebSocket après refresh

#### 5.4.3 Bug Position 0

**Sévérité :** Haute
**Localisation :** `ws.js`
**Statut :** CORRIGÉ

~~**Problème :** Si le host seek à 0 secondes, `position || previous` garde l'ancienne valeur car `0` est falsy.~~

```javascript
// Avant (bug)
state.lastSyncPosition = msg.payload.position || state.lastSyncPosition;
```

**Corrections appliquées :**
- Utilisation de `typeof` pour vérifier si position est un nombre
- Corrigé dans `state_update` handler et `room_state` handler
```javascript
state.lastSyncPosition = typeof msg.payload.position === 'number'
  ? msg.payload.position
  : state.lastSyncPosition;
```

#### 5.4.4 Playback Init Sans Feedback

**Sévérité :** Haute
**Localisation :** `playback.js`
**Statut :** CORRIGÉ

~~**Problème :** Si toutes les méthodes de lecture échouent, l'utilisateur n'a aucun feedback.~~

```javascript
try {
  pm.play({ items: [item], ...qualityOptions });
  return true;
} catch (err) { }  // Aucun logging, aucun feedback
```

**Corrections appliquées :**
- Collecte des erreurs de chaque méthode tentée
- Logging de la méthode qui réussit (`console.log`)
- Logging détaillé des échecs (`console.error`) avec tableau des erreurs
- Toast notification à l'utilisateur si toutes les méthodes échouent

### 5.5 Problèmes Moyenne Priorité

#### 5.5.1 Quality Control Sans UI

**Localisation :** `playback.js` lignes 22-101, `state.js` lignes 71-77

Les presets de qualité sont définis mais :
- Aucune UI pour les changer
- `setQualityPreset()` et `toggleDirectPlay()` exportés mais jamais appelés
- Guests reçoivent updates mais ne peuvent pas demander de changements

#### 5.5.2 Détection Video Ready Trop Stricte

**Localisation :** `utils.js` lignes 12-15

```javascript
return video && video.readyState >= 3;  // HAVE_FUTURE_DATA
```

**Problème :** `readyState >= 2` (HAVE_CURRENT_DATA) serait plus permissif. Pas de vérification des `buffered` ranges.

#### 5.5.3 Reconnection Sans Backoff

**Localisation :** `ws.js`
**Statut :** CORRIGÉ

~~**Problème :** Délai fixe de 3s peut surcharger le serveur en cas de panne prolongée.~~

```javascript
setTimeout(() => connect(), 3000);  // Fixe 3s
```

**Corrections appliquées :**
- Ajout de constantes `RECONNECT_BASE_MS` (1s) et `RECONNECT_MAX_MS` (30s) dans state.js
- Compteur `reconnectAttempts` dans state
- Backoff exponentiel : 1s → 2s → 4s → 8s → 16s → 30s (plafonné)
- Reset du compteur sur connexion réussie
- Logging du délai et du numéro de tentative

#### 5.5.4 État Global Sprawling

**Localisation :** `state.js`

40+ propriétés sans validation :
- Mutations directes possibles
- Interdépendances complexes (ex: `isInitialSync`, `initialSyncUntil`, `initialSyncTargetPos`)
- Pas de protection contre états invalides

### 5.6 Problèmes Basse Priorité

- Toast messages avec timeout fixe (4s) quelle que soit l'importance
- Pas d'indication quand seeking au-delà du buffer
- Pas d'indicateur de qualité actuelle dans l'UI
- ~~Clock sync devrait faire ping immédiatement après connexion~~ **CORRIGÉ** : Ping immédiat envoyé dans `onopen` handler

### 5.7 Compatibilité Navigateurs

| Aspect | Risque | Notes |
|--------|--------|-------|
| HLS.js | Moyen | Peut ne pas setter `networkState` correctement |
| Safari HLS | Moyen | Implémentation native diffère du standard |
| Async/Await | Faible | Navigateurs modernes OK |
| WebSocket | Faible | Support universel |

---

## 6. Infrastructure & CI/CD

### 6.1 Évaluation Globale

**Qualité : Faible** - Manque critique de CI/CD et hardening sécurité.

### 6.2 Problèmes Critiques

#### 6.2.1 Aucune CI/CD

**Sévérité :** Critique

Pas de `.github/workflows/` :
- Pas de tests automatisés sur PR
- Pas de builds automatiques
- Pas de scanning sécurité
- Pas de releases automatisées

**Action :** Créer workflows pour :
- `test.yml` - Tests Rust + linting JS
- `security.yml` - cargo-audit, SAST
- `build.yml` - Build images Docker
- `release.yml` - Releases automatiques

#### 6.2.2 Dockerfile Sans Utilisateur Non-Root

**Sévérité :** Critique
**Localisation :** `infra/docker/Dockerfile.session-server`

```dockerfile
FROM debian:bookworm-slim
COPY --from=builder /usr/local/cargo/bin/session-server /usr/local/bin/
CMD ["session-server"]
# Pas de USER directive = root !
```

**Action :** Ajouter :
```dockerfile
RUN useradd -m -u 1000 appuser
USER appuser
```

### 6.3 Problèmes Haute Priorité

#### 6.3.1 Pas de .env.example

**Impact :** Nouveaux développeurs ne savent pas quelles variables configurer.

**Action :** Créer `.env.example` avec toutes les variables documentées.

#### 6.3.2 Pas de Limites Ressources Docker

**Localisation :** `docker-compose.yml`

```yaml
# Manque:
# deploy:
#   resources:
#     limits:
#       memory: 512M
#       cpus: '0.5'
```

#### 6.3.3 Pas de HEALTHCHECK

**Localisation :** Dockerfile

```dockerfile
# Manque:
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:3000/health || exit 1
```

### 6.4 Problèmes Moyenne Priorité

#### 6.4.1 Pas de Pre-commit Hooks

Pas de husky/pre-commit pour :
- Format check (cargo fmt, prettier)
- Lint enforcement (clippy, eslint)
- Détection de secrets

#### 6.4.2 Fichiers Manquants

| Fichier | Usage |
|---------|-------|
| `.dockerignore` | Optimiser build context |
| `.editorconfig` | Cohérence style code |
| `SECURITY.md` | Politique disclosure vulnérabilités |

### 6.5 Makefile

**Points forts :**
- 50+ targets bien organisés
- Documentation couleur
- Préservation UID/GID

**Points faibles :**
- Pas de validation pré-build (refs Jellyfin)
- Chemins hardcodés multiples

### 6.6 Recommandations Docker

**Dockerfile amélioré :**
```dockerfile
FROM rust:1.83 as builder
WORKDIR /usr/src/app
COPY . .
RUN cargo install --path .

FROM debian:bookworm-slim
RUN useradd -m -u 1000 appuser && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/cargo/bin/session-server /usr/local/bin/
RUN chown appuser:appuser /usr/local/bin/session-server
USER appuser
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost:3000/health || exit 1
CMD ["session-server"]
```

---

## 7. Sécurité

### 7.1 Points Forts

1. **JWT Authentication**
   - Claims appropriés
   - Validation issuer/audience
   - TTL court par défaut

2. **Rate Limiting**
   - 30 msg/sec par client (serveur)
   - 30 tokens/min par user (plugin)

3. **Validation Input**
   - Position, media ID, play state validés
   - Taille message limitée 64KB
   - HTML escape côté client

4. **CORS**
   - Warning log pour wildcard origin
   - Validation origin implémentée

### 7.2 Préoccupations

#### 7.2.1 JWT Secret Optionnel

**Problème :** `JWT_SECRET` vide = authentification désactivée par défaut.

**Recommandation :** Exiger configuration explicite en production.

#### 7.2.2 Pas de Révocation Token

**Problème :** Tokens compromis restent valides jusqu'à expiration.

**Recommandation :** Implémenter blacklist ou documenter limitation.

#### 7.2.3 Pas de Rate Limiting par IP

**Problème :** Rate limiting par client UUID, pas par IP. Attaquant peut générer multiples UUIDs.

**Recommandation :** Documenter que rate limiting réseau (reverse proxy) est requis.

#### 7.2.4 Noms Non Sanitizés

**Localisation :** `ws.rs` lignes 236, 280

**Problème :** Noms utilisateur/room pas sanitizés (longueur, contenu).

**Recommandation :** Valider et sanitizer tous les inputs texte.

### 7.3 Recommandations

1. Créer `SECURITY.md` avec politique de disclosure
2. Documenter architecture sécurité et limitations
3. Ajouter scanning vulnérabilités en CI (cargo-audit)
4. Implémenter validation secret au démarrage

---

## 8. Plan d'Action Recommandé

### 8.1 Actions Immédiates (Cette Semaine)

| # | Action | Priorité | Effort | Statut |
|---|--------|----------|--------|--------|
| 1 | Créer `CHANGELOG.md` | Critique | 1h | FAIT |
| 2 | Corriger constantes timing dans docs | Critique | 30min | FAIT |
| 3 | Ajouter utilisateur non-root au Dockerfile | Critique | 15min | À faire |
| 4 | Fix bug position 0 dans ws.js | Haute | 15min | À faire |
| 5 | Ajouter logging erreurs JSON | Haute | 15min | À faire |

### 8.2 Court Terme (Ce Mois)

| # | Action | Priorité | Effort | Statut |
|---|--------|----------|--------|--------|
| 6 | Créer CI/CD GitHub Actions (tests, lint) | Critique | 4h | À faire |
| 7 | Ajouter tests unitaires Rust | Haute | 8h | **FAIT** (27 tests) |
| 8 | Compléter UI configuration plugin | Haute | 2h | À faire |
| 9 | Implémenter token refresh client | Haute | 2h | À faire |
| 10 | Créer `.env.example` | Haute | 30min | À faire |
| 11 | Ajouter HEALTHCHECK Docker | Haute | 15min | À faire |
| 12 | Documenter Home section | Haute | 1h | **FAIT** |

### 8.3 Moyen Terme (Ce Trimestre)

| # | Action | Priorité | Effort | Statut |
|---|--------|----------|--------|--------|
| 13 | Ajouter métriques Prometheus | Moyenne | 4h | À faire |
| 14 | Implémenter backoff reconnection WS | Moyenne | 1h | À faire |
| 15 | Créer UI quality control | Moyenne | 4h | À faire |
| 16 | Migrer logs structurés (tracing) | Moyenne | 2h | À faire |
| 17 | Ajouter pre-commit hooks | Moyenne | 1h | À faire |
| 18 | Enum message dispatch Rust | Moyenne | 2h | **FAIT** |
| 19 | Tests unitaires plugin C# | Moyenne | 4h | À faire |
| 20 | Documenter limitations sécurité JWT | Moyenne | 1h | **FAIT** |

### 8.4 Long Terme (Backlog)

| # | Action | Priorité | Statut |
|---|--------|----------|--------|
| 21 | Tests unitaires client JS | Basse | À faire |
| 22 | Mots de passe room | Basse | À faire |
| 23 | Permissions utilisateur avancées | Basse | À faire |
| 24 | Révocation tokens | Basse | À faire |
| 25 | Glossaire documentation | Basse | **FAIT** |
| 26 | Diagrammes architecture complets | Basse | **FAIT** |

---

## Annexes

### A. Fichiers Analysés

**Documentation :**
- README.md
- CLAUDE.md
- docs/product/features.md
- docs/product/user-guide.md
- docs/technical/sync.md
- docs/technical/client.md
- docs/technical/api.md
- docs/technical/protocol.md
- docs/technical/architecture.md
- docs/operations/security.md
- docs/operations/configuration.md
- docs/operations/troubleshooting.md
- docs/development/setup.md
- docs/development/release.md
- docs/development/testing.md

**Serveur Rust :**
- server/src/main.rs
- server/src/ws.rs
- server/src/room.rs
- server/src/messaging.rs
- server/src/auth.rs
- server/src/types.rs
- server/src/utils.rs
- server/Cargo.toml

**Plugin Jellyfin :**
- plugins/jellyfin/OpenWatchParty/Plugin.cs
- plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs
- plugins/jellyfin/OpenWatchParty/Configuration/PluginConfiguration.cs
- plugins/jellyfin/OpenWatchParty/Web/configPage.html
- plugins/jellyfin/OpenWatchParty/Web/plugin.js
- plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj

**Client Web :**
- clients/web-plugin/state.js
- clients/web-plugin/utils.js
- clients/web-plugin/ui.js
- clients/web-plugin/playback.js
- clients/web-plugin/ws.js
- clients/web-plugin/app.js
- clients/web-plugin/plugin.js

**Infrastructure :**
- docker-compose.yml
- infra/docker/docker-compose.yml
- infra/docker/Dockerfile.session-server
- Makefile
- .gitignore
- .eslintrc.json

### B. Outils d'Analyse Utilisés

- Analyse statique code (lecture manuelle)
- Clippy (Rust linting)
- Vérification cohérence documentation/code
- Revue patterns sécurité

---

*Rapport généré le 2026-01-16*
