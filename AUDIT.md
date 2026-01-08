# OpenWatchParty - Audit de Sécurité et Qualité

> **Date**: 2026-01-08
> **Version auditée**: main @ cdc2599
> **Auditeur**: Claude Code

---

## Résumé Exécutif

| Sévérité | Total | Résolus | Restants |
|----------|-------|---------|----------|
| 🔴 Critique | 4 | 4 | 0 |
| 🟠 Haute | 10 | 10 | 0 |
| 🟡 Moyenne | 65 | 12 | 53 |
| 🟢 Basse | 24 | 9 | 15 |
| **Total** | **103** | **35** | **68** |

### Répartition par Composant

| Composant | Critique | Haute | Moyenne | Basse | Total |
|-----------|----------|-------|---------|-------|-------|
| Rust Server | 1 | 2 | 14 | 12 | 29 |
| JavaScript Client | 1 | 2 | 33 | 2 | 38 |
| C# Plugin | 2 | 6 | 18 | 10 | 36 |

---

## 🔴 Issues Critiques

### C01 - Token JWT exposé dans l'URL WebSocket
| Attribut | Valeur |
|----------|--------|
| **ID** | C01 |
| **Sévérité** | 🔴 Critique |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ws.js` |
| **Ligne** | 98 |
| **Statut** | ✅ Résolu |
| **Assigné** | - |

**Description**
Le token d'authentification JWT est passé en paramètre de query string dans l'URL WebSocket :
```javascript
wsUrl = `${DEFAULT_WS_URL}?token=${encodeURIComponent(token)}`
```

**Risque**
- Tokens exposés dans l'historique du navigateur
- Tokens visibles dans les logs serveur (access logs)
- Tokens transmis via headers Referer à des tiers
- Tokens persistants dans le cache du navigateur

**Recommandation**
Implémenter une authentification par message après connexion WebSocket :
1. Connecter sans token
2. Envoyer message `{ type: "auth", token: "..." }`
3. Serveur valide et associe le client

**Effort estimé**: 2-3h

---

### C02 - Expiration JWT non validée côté serveur
| Attribut | Valeur |
|----------|--------|
| **ID** | C02 |
| **Sévérité** | 🔴 Critique |
| **Composant** | Rust Server |
| **Fichier** | `server/src/auth.rs` |
| **Ligne** | 52-60 |
| **Statut** | ✅ Résolu |
| **Assigné** | - |

**Description**
La validation JWT vérifie l'audience et l'issuer mais la validation de l'expiration (`exp` claim) n'est pas explicitement configurée :
```rust
let mut validation = Validation::new(Algorithm::HS256);
validation.set_audience(&[&self.audience]);
validation.set_issuer(&[&self.issuer]);
// Pas de validation explicite de l'expiration
```

**Risque**
- Tokens expirés acceptés indéfiniment
- Sessions persistantes après déconnexion utilisateur
- Impossible de révoquer l'accès

**Recommandation**
```rust
validation.validate_exp = true;
validation.leeway = 60; // 60 secondes de tolérance
```

**Effort estimé**: 30min

---

### C03 - Pas de rate-limiting sur génération de tokens
| Attribut | Valeur |
|----------|--------|
| **ID** | C03 |
| **Sévérité** | 🔴 Critique |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 61 |
| **Statut** | ✅ Résolu |
| **Assigné** | - |

**Description**
L'endpoint `/OpenWatchParty/Token` n'a aucune limite de requêtes. Un utilisateur authentifié peut générer un nombre illimité de tokens.

**Risque**
- Attaque par force brute sur le secret JWT
- Déni de service par saturation
- Accumulation de tokens valides

**Recommandation**
Implémenter un rate-limiter :
- Maximum 10 tokens/minute par utilisateur
- Maximum 100 tokens/heure par IP
- Utiliser un middleware ASP.NET Core rate limiting

**Effort estimé**: 1-2h

---

### C04 - Secret JWT exposé dans le formulaire de configuration
| Attribut | Valeur |
|----------|--------|
| **ID** | C04 |
| **Sévérité** | 🔴 Critique |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Web/configPage.html` |
| **Ligne** | 40-42 |
| **Statut** | ✅ Résolu |
| **Assigné** | - |

**Description**
Le secret JWT est chargé en clair dans l'input et renvoyé en AJAX :
```javascript
$('#JwtSecret', page).val(config.JwtSecret || '');
```

**Risque**
- Secret visible en mémoire du navigateur
- Secret transmis en clair (si pas HTTPS)
- Secret visible dans les DevTools
- Secret potentiellement loggé

**Recommandation**
- Ne jamais renvoyer le secret existant au client
- Afficher `********` si un secret existe
- Permettre uniquement de définir un nouveau secret
- Ajouter un bouton "Générer nouveau secret"

**Effort estimé**: 1-2h

---

## 🟠 Issues Hautes

### H01 - CORS wildcard autorise toutes les origines
| Attribut | Valeur |
|----------|--------|
| **ID** | H01 |
| **Sévérité** | 🟠 Haute |
| **Composant** | Rust Server |
| **Fichier** | `server/src/main.rs` |
| **Ligne** | 29-34 |
| **Statut** | ✅ Résolu |

**Description**
```rust
fn is_origin_allowed(origin: &str, allowed: &[String]) -> bool {
    if allowed.iter().any(|o| o == "*") {
        return true;  // Autorise TOUT
    }
    // ...
}
```

**Risque**
- CSRF possible depuis n'importe quel site
- Contourne toute protection CORS

**Recommandation**
- Supprimer le support wildcard `*`
- Exiger une liste explicite d'origines
- Logger un warning si wildcard configuré

**Effort estimé**: 30min

---

### H02 - Pas de limite de taille sur messages WebSocket
| Attribut | Valeur |
|----------|--------|
| **ID** | H02 |
| **Sévérité** | 🟠 Haute |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 178-195 |
| **Statut** | ✅ Résolu |

**Description**
Les messages WebSocket sont parsés sans validation de taille. Un client malveillant peut envoyer des payloads de plusieurs Mo.

**Risque**
- Épuisement mémoire (OOM)
- Déni de service

**Recommandation**
```rust
const MAX_MESSAGE_SIZE: usize = 64 * 1024; // 64 KB
if msg.len() > MAX_MESSAGE_SIZE {
    return Err("Message too large");
}
```

**Effort estimé**: 30min

---

### H03 - XSS potentiel via URL d'image dans CSS
| Attribut | Valeur |
|----------|--------|
| **ID** | H03 |
| **Sévérité** | 🟠 Haute |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ui.js` |
| **Ligne** | 90 |
| **Statut** | ✅ Résolu |

**Description**
```javascript
cover.style.background = `#111 url('${imageUrl}') center/cover no-repeat`;
```

**Risque**
- Injection CSS si URL contrôlée par l'utilisateur
- XSS via `javascript:` URLs (selon navigateur)

**Recommandation**
```javascript
cover.style.backgroundImage = `url(${CSS.escape(imageUrl)})`;
// Ou valider que l'URL commence par http(s)://
```

**Effort estimé**: 30min

---

### H04 - Pas de timeout sur chargement des scripts
| Attribut | Valeur |
|----------|--------|
| **ID** | H04 |
| **Sévérité** | 🟠 Haute |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/plugin.js` |
| **Ligne** | 18-25 |
| **Statut** | ✅ Résolu |

**Description**
Le chargement séquentiel des scripts n'a pas de timeout. Si un script ne charge pas, toute la chaîne bloque indéfiniment.

**Risque**
- Plugin jamais initialisé
- Pas de feedback utilisateur
- Page potentiellement bloquée

**Recommandation**
```javascript
const loadScript = (src, timeout = 10000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout loading ${src}`)), timeout);
  // ...
  script.onload = () => { clearTimeout(timer); resolve(); };
});
```

**Effort estimé**: 30min

---

### H05 - I/O synchrone bloquant dans Controller
| Attribut | Valeur |
|----------|--------|
| **ID** | H05 |
| **Sévérité** | 🟠 Haute |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 23-25 |
| **Statut** | ✅ Résolu |

**Description**
```csharp
using var reader = new StreamReader(stream);
return reader.ReadToEnd();  // Bloquant
```

**Risque**
- Thread pool épuisé sous charge
- Latence accrue
- Scalabilité réduite

**Recommandation**
```csharp
return await reader.ReadToEndAsync();
```

**Effort estimé**: 15min

---

### H06 - Pas de cache HTTP pour le script client
| Attribut | Valeur |
|----------|--------|
| **ID** | H06 |
| **Sévérité** | 🟠 Haute |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 21-27 |
| **Statut** | ✅ Résolu |

**Description**
Le script est rechargé à chaque requête sans headers de cache.

**Risque**
- Bande passante gaspillée
- Latence à chaque chargement de page

**Recommandation**
```csharp
Response.Headers.Add("Cache-Control", "public, max-age=3600");
Response.Headers.Add("ETag", $"\"{ComputeHash(script)}\"");
```

**Effort estimé**: 1h

---

### H07 - Aucun error handling sur les promises jQuery
| Attribut | Valeur |
|----------|--------|
| **ID** | H07 |
| **Sévérité** | 🟠 Haute |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Web/configPage.html` |
| **Ligne** | 39-44 |
| **Statut** | ✅ Résolu |

**Description**
```javascript
ApiClient.getPluginConfiguration(...).then(function (config) {
    // ...
});
// Pas de .catch()
```

**Risque**
- Loading spinner infini si erreur
- Utilisateur sans feedback
- Erreurs silencieuses

**Recommandation**
```javascript
.catch(function(err) {
    Dashboard.hideLoadingMsg();
    Dashboard.alert('Failed to load configuration');
});
```

**Effort estimé**: 30min

---

### H08 - Singleton antipattern sur Plugin
| Attribut | Valeur |
|----------|--------|
| **ID** | H08 |
| **Sévérité** | 🟠 Haute |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Plugin.cs` |
| **Ligne** | 12 |
| **Statut** | ✅ Résolu |

**Description**
```csharp
public static Plugin? Instance { get; private set; }
```

**Risque**
- Thread-safety non garantie
- Difficile à tester
- Couplage fort

**Recommandation**
Utiliser l'injection de dépendances Jellyfin standard.

**Effort estimé**: 2-3h

---

### H09 - Fallback silencieux sans validation
| Attribut | Valeur |
|----------|--------|
| **ID** | H09 |
| **Sévérité** | 🟠 Haute |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 42-46 |
| **Statut** | ✅ Résolu |

**Description**
```csharp
var userId = User.FindFirst("Jellyfin-UserId")?.Value ?? "unknown";
var userName = User.FindFirst("Jellyfin-UserName")?.Value ?? "Unknown User";
```

**Risque**
- Tokens générés pour utilisateurs invalides
- Pas de validation que l'utilisateur existe toujours

**Recommandation**
Retourner 401 Unauthorized si claims manquants.

**Effort estimé**: 30min

---

### H10 - Pas de validation des valeurs de configuration
| Attribut | Valeur |
|----------|--------|
| **ID** | H10 |
| **Sévérité** | 🟠 Haute |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Configuration/PluginConfiguration.cs` |
| **Ligne** | 7-22 |
| **Statut** | ✅ Résolu |

**Description**
Aucune validation sur les propriétés de configuration :
- `JwtSecret` peut être vide ou trop court
- `TokenTtlSeconds` peut être 0 ou négatif
- `JwtAudience` peut être null

**Risque**
- Configuration invalide acceptée
- Comportement imprévisible

**Recommandation**
Ajouter des attributs de validation `[Required]`, `[MinLength]`, `[Range]`.

**Effort estimé**: 1h

---

## 🟡 Issues Moyennes - Produit/UX

### M-UX01 - Avertissement WebSocket insécure uniquement en console
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX01 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ws.js` |
| **Ligne** | 101-106 |
| **Statut** | ⬜ Non résolu |

**Description**
L'avertissement `ws://` sur page `https://` n'est visible qu'en console.

**Recommandation**
Afficher un banner visible dans l'UI.

---

### M-UX02 - Toast disparaît trop vite (2s)
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX02 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ui.js` |
| **Ligne** | 257 |
| **Statut** | ✅ Résolu |

**Recommandation**
Augmenter à 3-4s ou permettre dismiss manuel.

---

### M-UX03 - Bouton "Join" toujours actif même si déjà dans la room
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX03 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ui.js` |
| **Ligne** | 65 |
| **Statut** | ⬜ Non résolu |

**Recommandation**
Désactiver ou changer le label si déjà membre.

---

### M-UX04 - Pas de feedback visuel lors du chargement média
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX04 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/playback.js` |
| **Ligne** | 46-65 |
| **Statut** | ⬜ Non résolu |

---

### M-UX05 - Port hardcodé :3000 dans le footer
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX05 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ui.js` |
| **Ligne** | 202 |
| **Statut** | ✅ Résolu |

---

### M-UX06 - Pas de contrôle d'accès aux rooms
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX06 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 272-318 |
| **Statut** | ⬜ Non résolu |

**Description**
N'importe qui peut rejoindre n'importe quelle room. Pas de mot de passe ou code d'invitation.

---

### M-UX07 - Pas d'indicateur de latence visible
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX07 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ui.js` |
| **Ligne** | 219 |
| **Statut** | ⬜ Non résolu |

**Description**
RTT affiché uniquement dans le panneau, pas visible pendant la lecture.

---

### M-UX08 - Room fermée sans notification claire
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX08 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ws.js` |
| **Ligne** | 192 |
| **Statut** | ✅ Résolu |

---

### M-UX09 - TTL tokens configurables mais pas exposés dans l'UI
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX09 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Configuration/PluginConfiguration.cs` |
| **Ligne** | 21-22 |
| **Statut** | ⬜ Non résolu |

---

### M-UX10 - Pas de page de documentation dans le plugin
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX10 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Plugin.cs` |
| **Statut** | ⬜ Non résolu |

---

### M-UX11 - Pas de support de localisation (i18n)
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX11 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | All |
| **Statut** | ⬜ Non résolu |

---

### M-UX12 - Pas de health check endpoint pour diagnostics
| Attribut | Valeur |
|----------|--------|
| **ID** | M-UX12 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Statut** | ⬜ Non résolu |

---

## 🟡 Issues Moyennes - Performance

### M-P01 - broadcast_room_list() O(n*m) lock acquisitions
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P01 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/messaging.rs` |
| **Ligne** | 24-32 |
| **Statut** | ⬜ Non résolu |

---

### M-P02 - Lock maintenu pendant opérations async
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P02 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 274-317 |
| **Statut** | ⬜ Non résolu |

---

### M-P03 - Clone de Room à chaque message
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P03 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 254 |
| **Statut** | ⬜ Non résolu |

---

### M-P04 - Polling DOM toutes les 2s
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P04 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/app.js` |
| **Ligne** | 35-38 |
| **Statut** | ✅ Résolu |

**Recommandation**
Utiliser MutationObserver.

---

### M-P05 - Refresh home toutes les 5s même hors vue
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P05 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/app.js` |
| **Ligne** | 48-52 |
| **Statut** | ✅ Résolu |

---

### M-P06 - syncLoop() toutes les 500ms
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P06 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/playback.js` |
| **Ligne** | 198-238 |
| **Statut** | ⬜ Non résolu |

**Recommandation**
Utiliser requestAnimationFrame ou event-driven.

---

### M-P07 - LRUCache eviction O(n)
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P07 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/state.js` |
| **Ligne** | 29 |
| **Statut** | ⬜ Non résolu |

---

### M-P08 - Pas de virtual diffing pour les cards
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P08 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ui.js` |
| **Ligne** | 149-181 |
| **Statut** | ⬜ Non résolu |

---

### M-P09 - Script rechargé sans cache
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P09 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 21-27 |
| **Statut** | ⬜ Non résolu |

---

### M-P10 - Config fetched 2x lors de save
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P10 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Web/configPage.html` |
| **Ligne** | 39, 51 |
| **Statut** | ⬜ Non résolu |

---

### M-P11 - jQuery selectors répétés
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P11 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Web/configPage.html` |
| **Ligne** | 35, 47 |
| **Statut** | ⬜ Non résolu |

---

### M-P12 - JSON serialization panic on failure
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P12 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/messaging.rs` |
| **Ligne** | 36, 42 |
| **Statut** | ✅ Résolu |

---

### M-P13 - Tous les messages parsés même si non pertinents
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P13 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ws.js` |
| **Ligne** | 111-118 |
| **Statut** | ⬜ Non résolu |

---

### M-P14 - Pas de compression WebSocket
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P14 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Statut** | ⬜ Non résolu |

---

### M-P15 - Pas de compression réponse HTTP script
| Attribut | Valeur |
|----------|--------|
| **ID** | M-P15 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Statut** | ⬜ Non résolu |

---

## 🟡 Issues Moyennes - Qualité Code

### M-Q01 - Magic numbers éparpillés
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q01 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 12-17, 23-28 |
| **Statut** | ⬜ Non résolu |

---

### M-Q02 - Logging incohérent
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q02 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Statut** | ⬜ Non résolu |

---

### M-Q03 - .unwrap() sur sérialisation JSON
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q03 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/messaging.rs` |
| **Ligne** | 36, 42 |
| **Statut** | ✅ Résolu |

---

### M-Q04 - Erreurs ignorées silencieusement
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q04 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/messaging.rs` |
| **Statut** | ✅ Résolu |

---

### M-Q05 - Multiples patterns d'accès API Jellyfin
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q05 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/utils.js` |
| **Ligne** | 34 |
| **Statut** | ⬜ Non résolu |

---

### M-Q06 - Try-catch vides swallowing errors
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q06 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/playback.js` |
| **Ligne** | 21-28 |
| **Statut** | ⬜ Non résolu |

---

### M-Q07 - Condition complexe non lisible
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q07 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ws.js` |
| **Ligne** | 114 |
| **Statut** | ⬜ Non résolu |

---

### M-Q08 - Pas de TypeScript
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q08 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Statut** | ⬜ Non résolu |

---

### M-Q09 - XML comments manquants sur API publique
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q09 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Statut** | ✅ Résolu |

---

### M-Q10 - Hardcoded resource path
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q10 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 20 |
| **Statut** | ⬜ Non résolu |

---

### M-Q11 - Backing fields inutiles
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q11 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Configuration/PluginConfiguration.cs` |
| **Statut** | ⬜ Non résolu |

---

### M-Q12 - Naming inconsistant
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q12 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | All |
| **Statut** | ⬜ Non résolu |

---

### M-Q13 - Plugin GUID hardcodé en 2 endroits
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q13 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `configPage.html:32`, `Plugin.cs:39` |
| **Statut** | ⬜ Non résolu |

---

### M-Q14 - Pas de IDisposable sur Plugin
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q14 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Plugin.cs` |
| **Statut** | ⬜ Non résolu |

---

### M-Q15 - Pas de ILogger dans Controller
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q15 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Statut** | ✅ Résolu |

---

### M-Q16 - Tests unitaires absents
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q16 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | All |
| **Statut** | ⬜ Non résolu |

---

### M-Q17 - Pas de CI/CD
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q17 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | All |
| **Statut** | ⬜ Non résolu |

---

### M-Q18 - Pas de graceful shutdown
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q18 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/main.rs` |
| **Statut** | ✅ Résolu |

---

### M-Q19 - Pas de métriques/observabilité
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q19 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Statut** | ⬜ Non résolu |

---

### M-Q20 - Pas de sourcemaps JS
| Attribut | Valeur |
|----------|--------|
| **ID** | M-Q20 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Statut** | ⬜ Non résolu |

---

## 🐛 Bugs Potentiels

### B01 - Race condition: client join entre check ready et broadcast
| Attribut | Valeur |
|----------|--------|
| **ID** | B01 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 320-332 |
| **Statut** | ⬜ Non résolu |

---

### B02 - Race zombie: client actif déconnecté
| Attribut | Valeur |
|----------|--------|
| **ID** | B02 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/main.rs` |
| **Ligne** | 56-78 |
| **Statut** | ⬜ Non résolu |

---

### B03 - Message room_closed malformé
| Attribut | Valeur |
|----------|--------|
| **ID** | B03 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/room.rs` |
| **Ligne** | 51-56 |
| **Statut** | ✅ Résolu |

**Description**
Le message `room_closed` est créé comme string JSON brute au lieu d'un `WsMessage` structuré.

---

### B04 - Video binding perdu après navigation
| Attribut | Valeur |
|----------|--------|
| **ID** | B04 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/playback.js` |
| **Ligne** | 96-99 |
| **Statut** | ⬜ Non résolu |

---

### B05 - Race condition sur room state
| Attribut | Valeur |
|----------|--------|
| **ID** | B05 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/ws.js` |
| **Ligne** | 159-170 |
| **Statut** | ⬜ Non résolu |

---

### B06 - Listeners orphelins (memory leak)
| Attribut | Valeur |
|----------|--------|
| **ID** | B06 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/playback.js` |
| **Ligne** | 152-176 |
| **Statut** | ⬜ Non résolu |

---

### B07 - return false au lieu de preventDefault()
| Attribut | Valeur |
|----------|--------|
| **ID** | B07 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Web/configPage.html` |
| **Ligne** | 59 |
| **Statut** | ⬜ Non résolu |

---

### B08 - Stream non garanti fermé sur exception
| Attribut | Valeur |
|----------|--------|
| **ID** | B08 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 21-27 |
| **Statut** | ⬜ Non résolu |

---

### B09 - JWT sans jti (non révocable)
| Attribut | Valeur |
|----------|--------|
| **ID** | B09 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | C# Plugin |
| **Fichier** | `plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` |
| **Ligne** | 86-92 |
| **Statut** | ✅ Résolu |

---

### B10 - PendingPlay cassé si horloge recule
| Attribut | Valeur |
|----------|--------|
| **ID** | B10 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 111-144 |
| **Statut** | ⬜ Non résolu |

---

### B11 - Cache image sans expiration
| Attribut | Valeur |
|----------|--------|
| **ID** | B11 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | JavaScript Client |
| **Fichier** | `clients/web-plugin/state.js` |
| **Ligne** | 86 |
| **Statut** | ⬜ Non résolu |

---

### B12 - Ready clients pas clear pour membres existants
| Attribut | Valeur |
|----------|--------|
| **ID** | B12 |
| **Sévérité** | 🟡 Moyenne |
| **Composant** | Rust Server |
| **Fichier** | `server/src/ws.rs` |
| **Ligne** | 295 |
| **Statut** | ⬜ Non résolu |

---

## 🟢 Issues Basses

<details>
<summary>Voir les 24 issues basses (9 résolues)</summary>

| ID | Composant | Description | Statut |
|----|-----------|-------------|--------|
| L01 | Rust | `now_ms()` unwrap peut panic si horloge recule | ✅ Résolu |
| L02 | Rust | Validation position/play_state incohérente | ⬜ Non résolu |
| L03 | Rust | Messages d'erreur incomplets | ✅ Résolu |
| L04 | Rust | Pas de validation entropie JWT secret | ✅ Résolu |
| L05 | Rust | Media ID validé format mais pas permissions | ⬜ Non résolu |
| L06 | Rust | Pas de CSRF token pour state changes | ⬜ Non résolu |
| L07 | Rust | Rate limiting ne distingue pas messages critiques | ⬜ Non résolu |
| L08 | Rust | Room names pas sanitized | ✅ Résolu |
| L09 | Rust | Pas de timeout idle connection | ⬜ Non résolu |
| L10 | Rust | User permission checks absents | ⬜ Non résolu |
| L11 | Rust | Pas de persistent storage | ⬜ Non résolu |
| L12 | Rust | Position NaN handling edge case | ✅ Résolu |
| L13 | JS | Hash-based item ID parsing fragile | ✅ Résolu |
| L14 | JS | Empty room list rendering incomplete | ⬜ Non résolu |
| L15 | C# | Logging JWT secret length info leak | ✅ Résolu |
| L16 | C# | No secret rotation support | ⬜ Non résolu |
| L17 | C# | Missing version info in plugin | ✅ Résolu |
| L18 | C# | No explicit DI registration | ⬜ Non résolu |
| L19 | C# | Missing localization attributes | ⬜ Non résolu |
| L20 | C# | Incomplete meta.json | ⬜ Non résolu |
| L21 | C# | No API documentation | ⬜ Non résolu |
| L22 | C# | No authorization on GetClientScript | ⬜ Non résolu |
| L23 | C# | Missing data validation attributes | ✅ Résolu |
| L24 | C# | No async config calls | ⬜ Non résolu |

</details>

---

## Plan de Résolution Recommandé

### Phase 1 - Sécurité Critique (Sprint 1)
| ID | Effort | Priorité |
|----|--------|----------|
| C01 | 2-3h | P0 |
| C02 | 30min | P0 |
| C03 | 1-2h | P0 |
| C04 | 1-2h | P0 |

### Phase 2 - Sécurité Haute (Sprint 1-2)
| ID | Effort | Priorité |
|----|--------|----------|
| H01 | 30min | P1 |
| H02 | 30min | P1 |
| H03 | 30min | P1 |
| H04 | 30min | P1 |
| H05 | 15min | P1 |
| H06 | 1h | P1 |
| H07 | 30min | P1 |

### Phase 3 - Stabilité (Sprint 2-3)
- Bugs B01-B12
- Performance critiques M-P01, M-P04, M-P06

### Phase 4 - Qualité (Sprint 3-4)
- Tests unitaires M-Q16
- CI/CD M-Q17
- Logging M-Q02, M-Q15

### Phase 5 - UX (Sprint 4+)
- Contrôle d'accès rooms M-UX06
- Health checks M-UX12
- i18n M-UX11

---

## Historique des Modifications

| Date | Version | Auteur | Changements |
|------|---------|--------|-------------|
| 2026-01-08 | 1.0 | Claude Code | Création initiale |
| 2026-01-08 | 1.1 | Claude Code | Résolution de 12 issues moyennes (B03, B09, M-UX02, M-UX05, M-UX08, M-P04, M-P05, M-P12, M-Q03, M-Q04, M-Q09, M-Q15, M-Q18) |
| 2026-01-08 | 1.2 | Claude Code | Résolution de 9 issues basses (L01, L03, L04, L08, L12, L13, L15, L17, L23) |

---

## Glossaire

| Terme | Définition |
|-------|------------|
| JWT | JSON Web Token - standard d'authentification |
| CORS | Cross-Origin Resource Sharing |
| CSRF | Cross-Site Request Forgery |
| XSS | Cross-Site Scripting |
| RTT | Round-Trip Time |
| OOM | Out Of Memory |
| DI | Dependency Injection |
| i18n | Internationalisation |
