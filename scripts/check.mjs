#!/usr/bin/env node
// Valvoo tps-shop.fi:n game-worn -kokoelmaa ja ilmoittaa Telegramiin
// kun kokoelmaan ilmestyy uusi tuote.
//
// Käyttö:
//   node scripts/check.mjs                 normaali ajo
//   node scripts/check.mjs --dry-run       tulosta viesti, älä lähetä äläkä kirjoita statea
//   node scripts/check.mjs --seed          kirjoita nykytila ilman ilmoituksia
//   node scripts/check.mjs --simulate-new  teeskentele että viimeisin tuote on uusi

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHOP = 'https://tps-shop.fi'
const COLLECTION = process.env.COLLECTION_HANDLE || 'game-worn'
const STATE_PATH = fileURLToPath(new URL(`../state/${COLLECTION}.json`, import.meta.url))

const USER_AGENT = 'shop-watcher (+https://github.com/al3ksis/shop-watcher)'
const TIMEOUT_MS = 15_000
const RETRIES = 3
const TELEGRAM_MAX_CHARS = 4000 // Telegramin raja on 4096, jätetään marginaali

const flags = new Set(process.argv.slice(2))
const DRY_RUN = flags.has('--dry-run')
const SEED = flags.has('--seed')
const SIMULATE_NEW = flags.has('--simulate-new')
const NOTIFY_ON_COUNT_CHANGE = process.env.NOTIFY_ON_COUNT_CHANGE !== '0'

// --- HTTP ------------------------------------------------------------------

async function fetchJson(url, { required = true } = {}) {
  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      // 4xx (paitsi 429) ei parane uudelleenyrityksellä
      if (!res.ok && res.status !== 429 && res.status < 500) {
        throw new Error(`${url} → HTTP ${res.status}`)
      }
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status} (yritetään uudelleen)`)
      return await res.json()
    } catch (err) {
      lastError = err
      if (attempt < RETRIES) await sleep(attempt * 2000)
    }
  }
  if (required) throw lastError
  console.warn(`varoitus: ${lastError.message}`)
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- State -----------------------------------------------------------------

async function loadState() {
  let raw
  try {
    raw = await readFile(STATE_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const state = JSON.parse(raw) // rikkinäinen state kaataa ajon tarkoituksella
  if (!Array.isArray(state.products)) {
    throw new Error(`${STATE_PATH}: kenttä "products" puuttuu tai ei ole taulukko`)
  }
  return state
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true })
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

const toStateProduct = (p) => ({
  id: p.id,
  handle: p.handle,
  title: p.title,
  publishedAt: p.published_at,
})

// --- Viestin muotoilu ------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatPrice = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${n.toFixed(2).replace('.', ',')} €`
}

function describeProduct(product) {
  const lines = []
  lines.push(`<b>${esc(product.title)}</b>`)

  const variants = Array.isArray(product.variants) ? product.variants : []
  const available = variants.filter((v) => v.available)
  const prices = (available.length ? available : variants)
    .map((v) => Number(v.price))
    .filter(Number.isFinite)

  if (prices.length) {
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    lines.push(min === max ? formatPrice(min) : `${formatPrice(min)} – ${formatPrice(max)}`)
  }

  if (variants.length > 1) {
    lines.push(`Saatavilla ${available.length}/${variants.length} varianttia`)
    const names = available.slice(0, 12).map((v) => v.title).filter(Boolean)
    if (names.length) {
      const more = available.length - names.length
      lines.push(esc(names.join(', ') + (more > 0 ? ` (+${more} muuta)` : '')))
    }
  } else if (variants.length === 1 && !variants[0].available) {
    lines.push('Loppuunmyyty')
  }

  lines.push(`${SHOP}/products/${product.handle}`)
  return lines.join('\n')
}

function formatNewProducts(products) {
  const header =
    products.length === 1
      ? '🔴⚪ <b>Uusi tuote GAME WORN -kokoelmassa!</b>'
      : `🔴⚪ <b>${products.length} uutta tuotetta GAME WORN -kokoelmassa!</b>`
  const body = products.map(describeProduct).join('\n\n')
  return truncate([header, '', body, '', `${SHOP}/collections/${COLLECTION}`].join('\n'))
}

function formatCountChange(before, after) {
  return [
    'ℹ️ <b>GAME WORN -kokoelma muuttui</b>',
    '',
    `Kokoelmaan liitettyjen tuotteiden määrä: ${before} → ${after}`,
    'Julkisia tuotteita ei tullut lisää — tuote on todennäköisesti',
    'valmisteilla eikä vielä julkaistu.',
    '',
    `${SHOP}/collections/${COLLECTION}`,
  ].join('\n')
}

function truncate(text) {
  if (text.length <= TELEGRAM_MAX_CHARS) return text
  return text.slice(0, TELEGRAM_MAX_CHARS - 2) + '…'
}

// --- Telegram --------------------------------------------------------------

async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log('--- dry run, viestiä ei lähetetty ---')
    console.log(text)
    return
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN ja TELEGRAM_CHAT_ID puuttuvat')
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram-lähetys epäonnistui: HTTP ${res.status} ${JSON.stringify(body)}`)
  }
  console.log('Telegram-viesti lähetetty.')
}

// --- Pääohjelma ------------------------------------------------------------

async function main() {
  const productsUrl = `${SHOP}/collections/${COLLECTION}/products.json?limit=250`
  const data = await fetchJson(productsUrl)

  // Sanity check: jos vastaus ei ole odotetun muotoinen, kaadutaan ennen kuin
  // state ehtii korruptoitua ja aiheuttaa valeilmoituksia.
  if (!data || !Array.isArray(data.products)) {
    throw new Error(`${productsUrl}: vastauksesta puuttuu "products"-taulukko`)
  }
  const current = data.products
  console.log(`Kokoelmassa ${COLLECTION}: ${current.length} julkista tuotetta.`)

  // Shopify palauttaa olemattomalle kokoelmalle HTTP 200 + tyhjän taulukon,
  // ei 404:ää. Tyhjä tulos tarkoittaa siis lähes varmasti että kokoelman handle
  // on vaihtunut tai kokoelma on piilotettu — ei sitä että tuotteet loppuivat.
  // Kaadetaan ajo, jotta vahti ei hiljene huomaamatta.
  if (current.length === 0 && process.env.ALLOW_EMPTY !== '1') {
    throw new Error(
      `kokoelma "${COLLECTION}" palautti 0 tuotetta — handle on todennäköisesti ` +
        `vaihtunut tai kokoelma piilotettu. Tarkista ${SHOP}/collections/${COLLECTION} ` +
        `(ohita tarvittaessa: ALLOW_EMPTY=1)`,
    )
  }

  // Pehmeä haku: products_count paljastaa kokoelmaan liitetyt mutta vielä
  // julkaisemattomat tuotteet. Jos tämä epäonnistuu, ajo jatkuu normaalisti.
  const meta = await fetchJson(`${SHOP}/collections/${COLLECTION}.json`, { required: false })
  const productsCount = meta?.collection?.products_count ?? null

  const nextState = {
    collection: COLLECTION,
    productsCount,
    products: current.map(toStateProduct),
  }

  const previous = await loadState()

  if (SEED || !previous) {
    if (!DRY_RUN) await saveState(nextState)
    const reason = SEED ? 'seed' : 'ensimmäinen ajo'
    console.log(`${reason}: tallennettiin ${current.length} tuotetta lähtötilaksi.`)
    if (!SEED) {
      await sendTelegram(
        [
          '👀 <b>GAME WORN -vahti käynnistetty</b>',
          '',
          `Seurataan nyt ${current.length} tuotetta.`,
          'Saat viestin heti kun kokoelmaan ilmestyy uusi tuote.',
          '',
          `${SHOP}/collections/${COLLECTION}`,
        ].join('\n'),
      )
    }
    return
  }

  const knownIds = new Set(previous.products.map((p) => p.id))
  if (SIMULATE_NEW && previous.products.length) {
    const victim = previous.products.at(-1)
    knownIds.delete(victim.id)
    console.log(`--simulate-new: käsitellään "${victim.title}" uutena.`)
  }

  const newProducts = current.filter((p) => !knownIds.has(p.id))

  if (newProducts.length) {
    console.log(`Uusia tuotteita: ${newProducts.map((p) => p.title).join(', ')}`)
    await sendTelegram(formatNewProducts(newProducts))
  } else if (
    NOTIFY_ON_COUNT_CHANGE &&
    productsCount !== null &&
    previous.productsCount !== null &&
    previous.productsCount !== undefined &&
    productsCount !== previous.productsCount
  ) {
    console.log(`products_count muuttui: ${previous.productsCount} → ${productsCount}`)
    await sendTelegram(formatCountChange(previous.productsCount, productsCount))
  } else {
    console.log('Ei muutoksia.')
    return // ei kirjoiteta statea turhaan → ei turhia commiteja
  }

  // State kirjoitetaan vasta kun ilmoitus on mennyt läpi: jos lähetys kaatuu,
  // seuraava ajo yrittää saman muutoksen uudelleen.
  if (!DRY_RUN && !SIMULATE_NEW) await saveState(nextState)
}

main().catch((err) => {
  console.error(`VIRHE: ${err.message}`)
  process.exit(1)
})
