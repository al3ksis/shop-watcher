# Suunnittelupäätökset

Käyttöönotto-ohjeet ovat [README.md](README.md):ssä. Tämä dokumentti kertoo
*miksi* ratkaisu on tällainen.

## Lähtökohta muuttui kesken suunnittelun

Alkuperäinen suunnitelma valvoi **uusien kokoelmien** ilmestymistä
(`/collections.json`), koska `game-worn`-kokoelmaa ei oletettu olevan vielä
olemassa. Tarkistus osoitti toisin:

- `game-worn`-kokoelma on julkaistu jo 2025-07-07
- Siinä on **yksi** julkinen tuote: "PRE SEASON 26, GAME WORN"
  (26 varianttia, pelaajakohtaiset paidat 150–225 €)

Varsinainen tarve on siis *uusi tuote olemassa olevassa kokoelmassa*, jolloin
valvottava endpoint vaihtuu:

```
/collections.json                        →  /collections/game-worn/products.json
```

HTML-sivun tuotelistaus vastasi täsmälleen JSON-endpointin sisältöä, joten JSON
on luotettava lähde eikä sivun raapimista tarvita.

## `products_count` on ennakkosignaali

`/collections/game-worn.json` kertoo `products_count: 4`, vaikka julkisia
tuotteita on 1. Kokoelmaan on siis liitetty 3 tuotetta, joita ei ole julkaistu
Online Store -kanavaan. Tämä voi laueta tunteja tai päiviä ennen julkaisua, mutta
se voi myös heilua turhaan ylläpitäjän muokatessa kokoelmaa. Siksi se on oma,
selvästi merkitty ja pois kytkettävä viestityyppinsä — ei korvaa tuotediffiä.

## Miksi Telegram

Paras push-ilmoitus puhelimeen. Discord-webhook olisi ollut hieman helpompi
pystyttää, mutta sen ilmoitusluotettavuus riippuu kanavan asetuksista.

## Miksi julkinen repo

Minuutin ajoväli = ~43 000 ajoa/kk. Yksityisessä repossa GitHub Actionsin
ilmaiskiintiö on 2 000 min/kk, joka ylittyisi moninkertaisesti. Julkisissa
repoissa Actions on rajattomasti ilmainen. Koodissa ei ole mitään salaista —
token ja chat id ovat GitHub Secretseissä.

## Miksi ulkoinen ajastin eikä GitHubin cron

GitHubin `schedule`-cron on epätarkka ruuhka-aikoina ja **kytkeytyy pois päältä**
jos repoon ei committoida ~60 päivään. Koska state committoidaan vain kun jotain
muuttuu, repo voisi olla hiljaa kuukausia. `workflow_dispatch` ei kärsi
kummastakaan ongelmasta, joten cron-job.org kutsuu sitä. `schedule` on silti
mukana 30 min varasuojana.

## Miksi ei `concurrency`-ryhmää workflow'ssa

Ajo kestää ~30–45 s ja ajoväli on 60 s. Concurrency-ryhmä jonouttaisi
päällekkäiset ajot ja kasvattaisi viivettä. Push-törmäys on käytännössä mahdoton,
koska state kirjoitetaan vain todellisen muutoksen yhteydessä; varmuudeksi push
tehdään `git pull --rebase` -uudelleenyrityksellä.

## Miksi tyhjä tulos kaataa ajon

Shopify palauttaa olemattomalle kokoelmalle **HTTP 200 ja tyhjän
`products`-taulukon**, ei 404:ää. Ilman erillistä tarkistusta vahti hiljenisi
huomaamatta jos kokoelman handle vaihtuu tai kokoelma piilotetaan. Siksi 0
tuotetta = virhe (exit 1) → workflow lähettää Telegramiin hälytyksen.

Sama periaate muuallakin: state päivitetään vasta onnistuneen ilmoituksen
jälkeen, jotta epäonnistunut ajo ei "kuluta" muutosta.

## Avoimet riskit

- **Tuote myydään loppuun alle minuutissa** → ilmoitus tulee, mutta myöhässä.
  Tätä ei voi ratkaista pollaamalla tiheämmin ilman että kuorma ja GitHubin
  fair use -raja alkavat painaa.
- **Fine-grained PAT vanhenee** (max ~1 v) → dispatch alkaa palauttaa 401.
  Mitigaatio: kalenterimuistutus + cron-job.orgin failure-sähköposti.
- **1 440 ajoa/vrk** on julkisessa repossa ilmaista mutta raskaanpuoleista
  käyttöä. Jos GitHub joskus rajoittaa, ajovälin nosto 2–3 min:iin riittää.
