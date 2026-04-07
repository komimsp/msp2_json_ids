import fs from "fs";
import path from "path";

const SHOP_IDS = [
  6, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 17, 22,
  34, 35, 44, 45, 55, 56, 62, 67, 68, 69, 70, 71, 89
];

const CONCURRENCY = 6;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const REQUEST_RETRIES = 4;

const OUTPUT_DIR = "./prices";
const PRICES_FILE = "./prices/id_cena.json";
const CHECKED_URLS_FILE = "./prices/sprawdzone_linki.json";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function loadJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJsonFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadPrices() {
  return loadJsonFile(PRICES_FILE, {});
}

function savePrices(data) {
  saveJsonFile(PRICES_FILE, data);
}

function loadCheckedUrls() {
  return loadJsonFile(CHECKED_URLS_FILE, {});
}

function saveCheckedUrls(data) {
  saveJsonFile(CHECKED_URLS_FILE, data);
}

function findIdsFolder() {
  const candidates = [
    path.resolve("./ids"),
    path.resolve("../ids"),
    "C:/Users/konra/Downloads/msp2_json_ids/ids"
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

const IDS_DIR = findIdsFolder();

function getAllLocalItems() {
  if (!IDS_DIR) {
    console.log("Nie znaleziono folderu ids.");
    return [];
  }

  console.log("Używam folderu:", IDS_DIR);

  const items = [];
  const buckets = fs.readdirSync(IDS_DIR, { withFileTypes: true });

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;

    const bucketPath = path.join(IDS_DIR, bucket.name);
    const files = fs.readdirSync(bucketPath, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile()) continue;
      if (!file.name.endsWith(".json")) continue;

      const id = Number(file.name.replace(".json", ""));
      if (!Number.isInteger(id)) continue;

      items.push({
        id,
        filePath: path.join(bucketPath, file.name)
      });
    }
  }

  items.sort((a, b) => a.id - b.id);
  return items;
}

function loadLocalItem(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchJSON(url) {
  for (let i = 0; i < REQUEST_RETRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "msp2-price-scanner"
        }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (e) {
      if (i < REQUEST_RETRIES - 1) {
        console.log("Retry:", url);
        await sleep(1000 * (i + 1));
      }
    }
  }

  return null;
}

function extractBestTagsForListing(item, options = {}) {
  const {
    includeCollection = true,
    includeMeta = false
  } = options;

  const tags = Array.isArray(item?.tags) ? item.tags : [];

  const buckets = {
    rootCategory: [],
    gender: [],
    category: [],
    subcategory: [],
    collection: [],
    meta: [],
    other: []
  };

  for (const tag of tags) {
    const tagId = String(tag?.id ?? "").trim();
    const tagType = String(tag?.type ?? "").trim();

    if (!tagId) continue;

    if (tagType === "gender") {
      buckets.gender.push(tagId);
      continue;
    }

    if (tagType === "collection.theme" || tagType.startsWith("collection.")) {
      buckets.collection.push(tagId);
      continue;
    }

    if (tagType === "meta") {
      buckets.meta.push(tagId);
      continue;
    }

    if (tagType.startsWith("subcategory.clothes.")) {
      buckets.subcategory.push(tagId);
      continue;
    }

    if (tagType === "category.clothes") {
      const lookUpId = String(tag?.lookUpId ?? "").toLowerCase();
      const labelKeys = (tag?.resourceIdentifiers || [])
        .filter(x => x?.type === "label" && x?.key)
        .map(x => String(x.key).toLowerCase());

      const isRoot =
        lookUpId === "tag_clothes" ||
        lookUpId === "tag_beauty" ||
        labelKeys.includes("tag_clothes") ||
        labelKeys.includes("tag_beauty");

      if (isRoot) {
        buckets.rootCategory.push(tagId);
      } else {
        buckets.category.push(tagId);
      }
      continue;
    }

    buckets.other.push(tagId);
  }

  const finalTags = [];

  const pushUnique = (arr) => {
    for (const x of arr) {
      if (!finalTags.includes(x)) {
        finalTags.push(x);
      }
    }
  };

  pushUnique(buckets.rootCategory);
  pushUnique(buckets.gender);
  pushUnique(buckets.category);
  pushUnique(buckets.subcategory);

  if (includeCollection) {
    pushUnique(buckets.collection);
  }

  if (includeMeta) {
    pushUnique(buckets.meta);
  }

  return finalTags;
}

function buildListingURL(tagIds, shopId, page) {
  const url = new URL(`https://eu.mspapis.com/shopinventory/v1/shops/${shopId}/listings`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));

  for (const tagId of tagIds) {
    url.searchParams.append("tag", tagId);
  }

  return url.toString();
}

function normalizeCurrency(value) {
  if (!value) return null;

  const v = String(value).toLowerCase();

  if (v.includes("star")) return "SC";
  if (v === "sc") return "SC";
  if (v.includes("diamond")) return "DIA";
  if (v === "dia") return "DIA";

  return String(value);
}

function normalizePrice(value) {
  if (value == null) return null;

  const num = Number(value);
  if (!Number.isFinite(num)) return value;

  if (Number.isInteger(num)) {
    return num;
  }

  return Number(num.toFixed(2));
}

function extractPrice(entry) {
  const price =
    entry?.salesPrice ??
    entry?.price?.salesPrice ??
    entry?.pricing?.salesPrice ??
    entry?.salePrice ??
    entry?.price?.amount ??
    null;

  const currency =
    entry?.currency ??
    entry?.price?.currency ??
    entry?.pricing?.currency ??
    entry?.currencyType ??
    entry?.priceType ??
    null;

  if (price == null) return null;

  return {
    price: normalizePrice(price),
    currency: normalizeCurrency(currency)
  };
}

function buildIdSet(allLocalItems) {
  const set = new Set();

  for (const item of allLocalItems) {
    set.add(item.id);
  }

  return set;
}

function buildQueue(allLocalItems, prices) {
  return allLocalItems.filter(x => !prices[x.id]);
}

function saveFoundPrice(prices, id, payload) {
  if (prices[id]) return false;

  prices[id] = payload;
  savePrices(prices);
  return true;
}

async function processListingURL(url, prices, checkedUrls, allKnownIds, stats) {
  if (checkedUrls[url]) {
    stats.urlSkipped++;
    return;
  }

  checkedUrls[url] = {
    checkedAt: new Date().toISOString()
  };
  saveCheckedUrls(checkedUrls);

  stats.urlChecked++;

  const data = await fetchJSON(url);
  if (!Array.isArray(data)) {
    return;
  }

  for (const entry of data) {
    const entryId = Number(entry?.id);
    if (!Number.isInteger(entryId)) continue;
    if (!allKnownIds.has(entryId)) continue;
    if (prices[entryId]) continue;

    const p = extractPrice(entry);

    const payload = {
      price: p ? p.price : null,
      currency: p ? p.currency : null,
      salesPriceRaw: entry?.salesPrice ?? null,
      foundButNoPrice: !p
    };

    const saved = saveFoundPrice(prices, entryId, payload);

    if (saved) {
      stats.found++;
      console.log(`Zapisano: ${entryId} -> ${payload.price ?? "brak"} ${payload.currency ?? ""}`);
    }
  }
}

async function processItem(itemInfo, prices, checkedUrls, allKnownIds, stats) {
  const { id, filePath } = itemInfo;

  if (prices[id]) {
    stats.skipped++;
    return;
  }

  stats.checked++;
  console.log("Sprawdzam ID:", id);

  const item = loadLocalItem(filePath);
  if (!item) {
    stats.errors++;
    return;
  }

  const tagIds = extractBestTagsForListing(item, {
    includeCollection: true,
    includeMeta: false
  });

  if (!tagIds.length) {
    stats.notFound++;
    return;
  }

  for (const shopId of SHOP_IDS) {
    if (prices[id]) break;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (prices[id]) break;

      const url = buildListingURL(tagIds, shopId, page);
      await processListingURL(url, prices, checkedUrls, allKnownIds, stats);

      if (prices[id]) {
        prices[id].shop = shopId;
        prices[id].page = page;
        savePrices(prices);
        break;
      }
    }
  }

  if (!prices[id]) {
    stats.notFound++;
  }
}

async function worker(queue, prices, checkedUrls, allKnownIds, stats) {
  while (queue.length) {
    const itemInfo = queue.shift();
    if (!itemInfo) return;

    try {
      await processItem(itemInfo, prices, checkedUrls, allKnownIds, stats);
    } catch (e) {
      stats.errors++;
      console.log("Błąd ID:", itemInfo.id, e?.message || e);
    }
  }
}

async function main() {
  ensureDir();

  const prices = loadPrices();
  const checkedUrls = loadCheckedUrls();

  console.log("Wczytano zapisane ceny:", Object.keys(prices).length);
  console.log("Wczytano sprawdzone linki:", Object.keys(checkedUrls).length);

  const allLocalItems = getAllLocalItems();
  console.log("Znaleziono lokalnych ID:", allLocalItems.length);

  const allKnownIds = buildIdSet(allLocalItems);
  const queue = buildQueue(allLocalItems, prices);

  console.log("Do sprawdzenia ID:", queue.length);

  const stats = {
    checked: 0,
    skipped: 0,
    found: 0,
    notFound: 0,
    errors: 0,
    urlChecked: 0,
    urlSkipped: 0
  };

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(queue, prices, checkedUrls, allKnownIds, stats));
  }

  await Promise.all(workers);

  savePrices(prices);
  saveCheckedUrls(checkedUrls);

  console.log("\n=== GOTOWE ===");
  console.log("Sprawdzone ID:", stats.checked);
  console.log("Pominięte ID:", stats.skipped);
  console.log("Znalezione ceny:", stats.found);
  console.log("Brak ceny:", stats.notFound);
  console.log("Błędy:", stats.errors);
  console.log("Nowe sprawdzone URL:", stats.urlChecked);
  console.log("Pominięte URL z cache:", stats.urlSkipped);
  console.log("Łącznie zapisane ceny:", Object.keys(prices).length);
}

main();