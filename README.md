# GAME WORN -tuotevahti

Valvoo Shopify -kokoelmaa minuutin välein ja
lähettää Telegram-viestin heti kun kokoelmaan ilmestyy tuote. Kokoelma saa olla
tyhjä — ilmoitus lähtee jo ensimmäisestä ilmestyvästä tuotteesta.

Ei riippuvuuksia — pelkkä Node (natiivi `fetch`) ja GitHub Actions.

## Miten se toimii

1. `scripts/check.mjs` varmistaa `https://xxx.yy/collections/game-worn.json`
   -endpointista että kokoelma on yhä olemassa (404 = handle vaihtunut tai
   kokoelma piilotettu → ajo kaatuu ja Telegramiin lähtee hälytys)
2. Hakee `https://xxx.yy/collections/game-worn/products.json`
3. Vertaa tuote-id:itä `state/game-worn.json` -tiedostoon
4. Jos uusia löytyy → Telegram-viesti (otsikko, hintahaarukka, saatavilla olevat
   variantit, suora linkki tuotteeseen)
5. State päivitetään ja committoidaan **vasta kun viesti on mennyt läpi** — jos
   lähetys kaatuu, seuraava ajo yrittää saman muutoksen uudelleen

Tyhjä kokoelma on normaali tila: tuotteen poistuminen päivittää staten hiljaisesti
ilman ilmoitusta, ja seuraava ilmestyvä tuote laukaisee viestin.

Ajastus tulee **ulkopuolelta** (cron-job.org), joka kutsuu GitHubin
`workflow_dispatch`-endpointia. Syyt: GitHubin oma `schedule`-cron on epätarkka
ruuhka-aikoina ja kytkeytyy pois päältä jos repoon ei committoida ~60 päivään.
Workflow'ssa on silti `schedule`-varasuoja 30 min välein.

### Ennakkosignaali

`collections/game-worn.json` -endpointin `products_count` kertoo kuinka monta
tuotetta kokoelmaan on **liitetty** — myös julkaisemattomat. Kirjoitushetkellä
luku on 4, vaikka julkisia tuotteita on 0. Kun tämä luku **kasvaa** ilman että
julkisia tuotteita tulee lisää, tulee erillinen, hillitympi ilmoitus: tuote on
valmisteilla mutta ei vielä julkaistu. Laskevasta luvusta ei ilmoiteta.
Pois päältä: `NOTIFY_ON_COUNT_CHANGE=0`.

## Käyttöönotto

### 1. Telegram-botti

1. Telegramissa [@BotFather](https://t.me/BotFather) → `/newbot` → anna nimi ja
   username → saat **tokenin**
2. Avaa chat omalle botillesi ja lähetä sille `/start`
   (pakollinen — botti ei voi aloittaa keskustelua ensin)
3. Hae chat id:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
   ```

### 2. GitHub Secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Nimi | Arvo |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFatherilta saatu token |
| `TELEGRAM_CHAT_ID` | yllä haettu chat id |

> Repo on julkinen, jotta GitHub Actions on rajattomasti ilmainen. Salaisuudet
> eivät ole koodissa vaan Secretseissä — älä committoi tokeneita.

### 3. Personal access token cron-job.orgia varten

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token:

- Repository access: **Only select repositories** → tämä repo
- Permissions → Repository permissions → **Actions: Read and write**

⚠️ Fine-grained token vanhenee (max ~1 v). Laita kalenteriin muistutus, muuten
vahti hiljenee huomaamatta.

### 4. cron-job.org

| Asetus | Arvo |
| --- | --- |
| URL | `https://api.github.com/repos/al3ksis/shop-watcher/actions/workflows/watch.yml/dispatches` |
| Method | `POST` |
| Väli | 1 min |
| Body | `{"ref":"main"}` |

Headers:

```
Authorization: Bearer <PAT>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

Onnistunut kutsu palauttaa **HTTP 204** (ei 200). Kytke päälle cron-job.orgin
sähköposti-ilmoitus epäonnistumisista — se paljastaa vanhentuneen tokenin.

### 5. Lähtötilan tallennus

```bash
node scripts/check.mjs --seed
git add state/ && git commit -m "state: seed" && git push
```

Ilman tätä ensimmäinen ajo lähettää kertaluontoisen "vahti käynnistetty" -viestin
ja tallentaa lähtötilan itse.

## Paikallinen ajo ja testaus

```bash
# Näytä mitä lähetettäisiin, älä lähetä äläkä kirjoita statea
node scripts/check.mjs --dry-run

# Tallenna nykytila lähtötilaksi ilman ilmoituksia
node scripts/check.mjs --seed

# Lähetä oikea viesti puhelimeen teeskentelemällä että viimeisin tuote on uusi
# (tyhjällä kokoelmalla käytetään testituotetta, jotta testi toimii silloinkin)
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/check.mjs --simulate-new

# Normaali ajo
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/check.mjs
```

Saman testin voi ajaa ilman paikallista ympäristöä: GitHub → Actions →
**Watch game-worn** → *Run workflow* → rastita `simulate_new`. Tämä lähettää
oikean viestin Telegramiin, mutta **ei kirjoita statea**, joten vahdin tila
säilyy ennallaan. cron-job.org ei lähetä inputteja, joten ajastetut ajot ovat
aina normaaleja.

Ympäristömuuttujat:

| Muuttuja | Oletus | Selitys |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | – | pakollinen (paitsi `--dry-run` / `--seed`) |
| `TELEGRAM_CHAT_ID` | – | pakollinen (paitsi `--dry-run` / `--seed`) |
| `COLLECTION_HANDLE` | `game-worn` | valvottava kokoelma |
| `NOTIFY_ON_COUNT_CHANGE` | `1` | `0` = ei ennakkosignaali-ilmoituksia |

## Kuormitus

2 GET-pyyntöä ajoa kohti (~11,6 KB) → minuutin välillä ~2 880 pyyntöä/vrk
≈ 0,03 req/s ≈ 16 MB/vrk. `products.json` tarjoillaan Shopifyn CDN:stä, joten
kuorma kaupalle on olematon.

## Vikatilanteet

Skripti **kaatuu tarkoituksella** (exit 1) eikä kirjoita statea, jos:

- `products.json` ei vastaa 200:lla tai vastauksesta puuttuu `products`-taulukko
- `collections/<handle>.json` palauttaa **404** — kokoelmaa ei enää ole:
  handle on vaihtunut tai kokoelma piilotettu. (Tyhjä kokoelma **ei** ole virhe,
  koska Shopify vastaa olemattomallekin kokoelmalle `products.json`:sta
  HTTP 200 + tyhjällä taulukolla — siksi olemassaolo tarkistetaan erikseen.)
- Telegram-lähetys epäonnistuu

Kaatuminen laukaisee workflow'n `Notify on failure` -askeleen, joka lähettää
Telegramiin linkin Actions-lokiin. Hiljaista epäonnistumista ei siis pitäisi
tapahtua.
