# Répondo — réservation calendrier réelle

Cinq fichiers. Quatre sont nouveaux, un remplace l'existant.

| Fichier | Où le mettre | Action |
|---|---|---|
| `api/calendar-connect.js` | `api/calendar-connect.js` | nouveau |
| `api/calendar-callback.js` | `api/calendar-callback.js` | nouveau |
| `api/book.js` | `api/book.js` | nouveau |
| `confidentialite.html` | `confidentialite.html` (racine) | nouveau |
| `vercel.json` | `vercel.json` | **remplace** l'existant |

Le `vercel.json` fourni ajoute la route `/confidentialite` et retire `"public": true`,
qui rendait le code source et les logs consultables publiquement. Les deux réécritures
existantes (`/dentaire`, `/immobilier`) sont conservées à l'identique.

**Ne touche pas à** `index.html`, `api/reply.js`, `api/threesixty-webhook.js`.
Le branchement de la démo sur les vrais créneaux vient après, une fois la connexion testée.

---

## 1. Champs Airtable à créer à la main

Table **Clients** (`tblYJSEz2VSRhNMHG`) :

| Nom exact | Type |
|---|---|
| `Google Refresh Token` | Ligne de texte |
| `Google Calendar ID` | Ligne de texte |
| `Google Connecte` | Case à cocher |

Table **Leads** (`tbl59sHf4hsoE7FIp`) :

| Nom exact | Type |
|---|---|
| `RDV` | Date **avec heure** |
| `Google Event ID` | Ligne de texte |

Les noms doivent être exacts, accents compris — le code les cherche par nom.

---

## 2. Variables d'environnement Vercel

Settings → Environment Variables → Production. Puis **redéployer** : Vercel ne les
prend en compte qu'au déploiement suivant.

| Variable | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | depuis Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | depuis Google Cloud Console |
| `TOKEN_SECRET` | une chaîne aléatoire, générée par toi (voir ci-dessous) |
| `APP_URL` | `https://repondo.online` |

`ANTHROPIC_API_KEY` et `AIRTABLE_TOKEN` sont déjà en place.

Pour générer `TOKEN_SECRET`, dans un terminal :

```
openssl rand -hex 32
```

Génère-la toi-même et ne la partage avec personne, moi compris. Elle chiffre les
autorisations Google de tes clients : si elle change, toutes les connexions
existantes deviennent illisibles et chaque client doit se reconnecter.

---

## 3. Google Cloud Console

- **URI de redirection autorisée** (exactement, sans barre finale) :
  `https://repondo.online/api/calendar-callback`
- **Page d'accueil** : `https://repondo.online`
- **Politique de confidentialité** : `https://repondo.online/confidentialite`
- **Domaine autorisé** : `repondo.online`
- **Scopes**, ces deux-là uniquement :
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/calendar.events`

Ne demande aucun scope supplémentaire. Un scope non justifié est le motif de
refus le plus courant à la vérification.

---

## 4. Tester

Une fois les variables en place et le déploiement passé :

1. Crée une fiche client de test dans Airtable, note son ID (`recXXXXXXXXXXXXXX`).
2. Ouvre `https://repondo.online/api/calendar-connect?client=recXXXXXXXXXXXXXX`
3. Autorise avec ton propre compte Google.
4. Vérifie sur la fiche : `Google Connecte` coché, `Google Calendar ID` rempli,
   `Google Refresh Token` rempli et illisible (c'est normal, il est chiffré).
5. Ouvre `https://repondo.online/api/book?client=recXXXXXXXXXXXXXX`
   → tu dois voir deux créneaux réels, en heure marocaine, qui évitent
   ce que tu as déjà dans ton agenda. Bloque une heure dans Google Calendar,
   recharge : le créneau doit avoir changé.
6. Test de création — remplace l'horaire par un créneau renvoyé à l'étape 5 :

```
curl -X POST https://repondo.online/api/book \
  -H "Content-Type: application/json" \
  -d '{"client":"recXXXXXXXXXXXXXX","start":"2026-08-12T09:00:00.000Z",
       "lead":{"name":"Test Youssef","phone":"+212600000000",
               "message":"3 chambres Maarif, 1.5M MAD, avant decembre"}}'
```

L'événement doit apparaître dans ton Google Calendar avec le nom, le numéro
et la demande dans la description.

---

## Ce qui reste après ça

- Brancher `index.html` sur `/api/book` pour que les créneaux affichés dans la
  démo soient les vrais et que le clic crée un vrai rendez-vous.
- Brancher `api/threesixty-webhook.js` sur `/api/book` pour le flux WhatsApp.

Les deux sont petits. Ils viennent une fois que l'étape 4 passe.

---

## Rappel sur l'expiration

Tant que l'application Google reste en statut « Test », Google révoque chaque
autorisation au bout de 7 jours. Sans conséquence pour tes propres essais — tu
reconnectes en un clic. Mais aucun vrai client ne peut être livré avant que
l'application soit publiée et vérifiée. La vérification prend une dizaine de
jours : soumets-la dès que la page de confidentialité est en ligne.
