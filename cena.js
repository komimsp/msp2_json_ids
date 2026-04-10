import fs from "fs";
import path from "path";

const SHOP_IDS = [
  6, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 17, 22,
  34, 35, 44, 45, 55, 56, 62, 67, 68, 69, 70, 71, 89
];

const CONCURRENCY = 6;
const PAGE_SIZE = 100;
const MAX_PAGES = Number(process.env.PRICE_SCAN_MAX_PAGES || 0);
const REQUEST_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_BASE_DELAY_MS = 1200;
const CHECKED_URLS_VERSION = 2;
const PRICE_RESULT_VERSION = 2;

const OUTPUT_DIR = "./prices";
const PRICES_FILE = "./prices/id_cena.json";
const CHECKED_URLS_FILE = "./prices/sprawdzone_linki.json";

function parseArgs(argv) {
  const options = {
    ids: null,
    maxIds: null,
    forceRecheck: false,
    resetUrlCache: false,
    skipShopCrawl: false,
    skipItemScan: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--ids=")) {
      options.ids = arg
        .slice("--ids=".length)
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value));
      continue;
    }

    if (arg.startsWith("--max-ids=")) {
      const value = Number.parseInt(arg.slice("--max-ids=".length), 10);
      options.maxIds = Number.isInteger(value) && value > 0 ? value : null;
      continue;
    }

    if (arg === "--force-recheck") {
      options.forceRecheck = true;
      continue;
    }

    if (arg === "--reset-url-cache") {
      options.resetUrlCache = true;
      continue;
    }

    if (arg === "--skip-shop-crawl") {
      options.skipShopCrawl = true;
      continue;
    }

    if (arg === "--skip-item-scan") {
      options.skipItemScan = true;
    }
  }

  return options;
}

const CLI_OPTIONS = parseArgs(process.argv.slice(2));

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

function isRetryableError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();

  return (
    code.includes("UND_ERR_CONNECT_TIMEOUT") ||
    code.includes("ETIMEDOUT") ||
    code.includes("ECONNRESET") ||
    code.includes("ECONNREFUSED") ||
    code.includes("EAI_AGAIN") ||
    text.includes("fetch failed") ||
    text.includes("timeout") ||
    text.includes("network") ||
    text.includes("socket") ||
    text.includes("http 403") ||
    text.includes("http 429") ||
    text.includes("http 5")
  );
}

async function fetchJSON(url, label = "request") {
  for (let i = 0; i < REQUEST_RETRIES; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Timeout po ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "msp2-price-scanner",
          accept: "application/json",
        }
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 404) {
          return null;
        }

        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (e) {
      clearTimeout(timeout);
      if (i < REQUEST_RETRIES - 1 && isRetryableError(e)) {
        const waitMs = RETRY_BASE_DELAY_MS * (i + 1);
        console.log(`[retry ${i + 1}/${REQUEST_RETRIES}] ${label}: ${e?.message || e}`);
        await sleep(waitMs);
        continue;
      }
    }
  }

  return null;
}

function parseLastPageHeader(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const parts = String(linkHeader).split(",");
  for (const part of parts) {
    if (!part.includes('rel="last"')) {
      continue;
    }

    const match = part.match(/<([^>]+)>/);
    if (!match) {
      continue;
    }

    try {
      const parsed = new URL(match[1], "https://eu.mspapis.com/");
      const page = Number.parseInt(parsed.searchParams.get("page") || "", 10);
      if (Number.isInteger(page) && page > 0) {
        return page;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchListingPage(url, label = "listing") {
  for (let i = 0; i < REQUEST_RETRIES; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Timeout po ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "msp2-price-scanner",
          accept: "application/json",
        }
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 404) {
          return null;
        }

        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const totalCount = Number.parseInt(res.headers.get("x-total-count") || "", 10);
      const lastPageFromHeader = parseLastPageHeader(res.headers.get("link"));
      const calculatedLastPage = Number.isInteger(totalCount) && totalCount > 0
        ? Math.ceil(totalCount / PAGE_SIZE)
        : null;

      let lastPage = lastPageFromHeader ?? calculatedLastPage;
      if (Number.isInteger(MAX_PAGES) && MAX_PAGES > 0) {
        lastPage = Number.isInteger(lastPage) ? Math.min(lastPage, MAX_PAGES) : MAX_PAGES;
      }

      return {
        data,
        totalCount: Number.isInteger(totalCount) ? totalCount : null,
        lastPage: Number.isInteger(lastPage) && lastPage > 0 ? lastPage : null,
      };
    } catch (e) {
      clearTimeout(timeout);
      if (i < REQUEST_RETRIES - 1 && isRetryableError(e)) {
        const waitMs = RETRY_BASE_DELAY_MS * (i + 1);
        console.log(`[retry ${i + 1}/${REQUEST_RETRIES}] ${label}: ${e?.message || e}`);
        await sleep(waitMs);
        continue;
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

function buildTagStrategies(item) {
  const baseBuckets = {
    rootCategory: [],
    gender: [],
    category: [],
    subcategory: [],
    collection: [],
    meta: [],
  };

  const tags = Array.isArray(item?.tags) ? item.tags : [];
  for (const tag of tags) {
    const tagId = String(tag?.id ?? "").trim();
    const tagType = String(tag?.type ?? "").trim();

    if (!tagId) continue;

    if (tagType === "gender") {
      baseBuckets.gender.push(tagId);
      continue;
    }

    if (tagType.startsWith("collection.")) {
      baseBuckets.collection.push(tagId);
      continue;
    }

    if (tagType === "meta") {
      baseBuckets.meta.push(tagId);
      continue;
    }

    if (tagType.startsWith("subcategory.")) {
      baseBuckets.subcategory.push(tagId);
      continue;
    }

    if (tagType.startsWith("category.")) {
      const lookUpId = String(tag?.lookUpId ?? "").toLowerCase();
      const labelKeys = (tag?.resourceIdentifiers || [])
        .filter((entry) => entry?.type === "label" && entry?.key)
        .map((entry) => String(entry.key).toLowerCase());

      const isRootClothes =
        tagType === "category.clothes" &&
        (
          lookUpId === "tag_clothes" ||
          lookUpId === "tag_beauty" ||
          labelKeys.includes("tag_clothes") ||
          labelKeys.includes("tag_beauty")
        );

      if (isRootClothes) {
        baseBuckets.rootCategory.push(tagId);
      } else {
        baseBuckets.category.push(tagId);
      }
    }
  }

  for (const key of Object.keys(baseBuckets)) {
    baseBuckets[key] = [...new Set(baseBuckets[key])];
  }

  const strategies = [];
  const strategyKeys = new Set();

  function pushStrategy(values) {
    const unique = [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
    if (!unique.length) {
      return;
    }

    const key = unique.join(",");
    if (strategyKeys.has(key)) {
      return;
    }

    strategyKeys.add(key);
    strategies.push(unique);
  }

  const collectionOptions = [[], ...baseBuckets.collection.map((id) => [id])];
  const metaOptions = [[], ...baseBuckets.meta.map((id) => [id])];

  for (const collection of collectionOptions) {
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...baseBuckets.category,
      ...baseBuckets.subcategory,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...baseBuckets.category,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...baseBuckets.subcategory,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.gender,
      ...baseBuckets.category,
      ...baseBuckets.subcategory,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.category,
      ...baseBuckets.subcategory,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.category,
      ...baseBuckets.subcategory,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.category,
      ...collection,
    ]);
    pushStrategy([
      ...baseBuckets.subcategory,
      ...collection,
    ]);
    pushStrategy(collection);
  }

  for (const meta of metaOptions) {
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...baseBuckets.category,
      ...baseBuckets.subcategory,
      ...meta,
    ]);
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...baseBuckets.category,
      ...meta,
    ]);
    pushStrategy([
      ...baseBuckets.rootCategory,
      ...baseBuckets.gender,
      ...meta,
    ]);
    pushStrategy(meta);
  }

  pushStrategy(extractBestTagsForListing(item, { includeCollection: true, includeMeta: false }));
  pushStrategy(extractBestTagsForListing(item, { includeCollection: false, includeMeta: false }));
  pushStrategy(extractBestTagsForListing(item, { includeCollection: true, includeMeta: true }));

  return strategies;
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
  if (v === "soft") return "SC";
  if (v.includes("diamond")) return "DIA";
  if (v === "dia") return "DIA";
  if (v === "hard") return "DIA";

  return String(value).trim().toUpperCase();
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

function extractSalesPriceRaw(entry) {
  return (
    entry?.salesPrice ??
    entry?.price?.salesPrice ??
    entry?.pricing?.salesPrice ??
    entry?.salePrice ??
    entry?.price?.amount ??
    null
  );
}

function extractListingItemId(entry) {
  const candidates = [
    entry?.item?.objectId,
    entry?.item?.id,
    entry?.objectId,
    entry?.id,
  ];

  for (const candidate of candidates) {
    const value = Number.parseInt(String(candidate ?? "").trim(), 10);
    if (Number.isInteger(value)) {
      return value;
    }
  }

  return null;
}

function buildIdSet(allLocalItems) {
  const set = new Set();

  for (const item of allLocalItems) {
    set.add(item.id);
  }

  return set;
}

function hasStoredPrice(entry) {
  return Boolean(entry && entry.price != null && !entry.foundButNoPrice);
}

function hasResolvedPrice(entry) {
  return hasStoredPrice(entry);
}

function buildQueue(allLocalItems, prices, options = {}) {
  const idFilter = options.ids?.length ? new Set(options.ids) : null;
  let queue = allLocalItems.filter((item) => !idFilter || idFilter.has(item.id));

  if (!options.forceRecheck) {
    queue = queue.filter((item) => !hasStoredPrice(prices[item.id]));
  }

  if (Number.isInteger(options.maxIds) && options.maxIds > 0) {
    queue = queue.slice(0, options.maxIds);
  }

  return queue;
}

function shouldUpdateStoredPrice(currentEntry, nextEntry, forceRecheck = false) {
  if (forceRecheck) {
    return true;
  }

  if (!currentEntry) {
    return true;
  }

  if (!hasStoredPrice(currentEntry) && hasStoredPrice(nextEntry)) {
    return true;
  }

  return false;
}

function saveFoundPrice(prices, id, payload, forceRecheck = false) {
  if (!shouldUpdateStoredPrice(prices[id], payload, forceRecheck)) {
    return false;
  }

  prices[id] = {
    ...payload,
    scanVersion: PRICE_RESULT_VERSION,
  };
  savePrices(prices);
  return true;
}

function processListingEntries(entries, prices, allKnownIds, stats, metadata = {}, options = {}) {
  for (const entry of entries) {
    const entryId = extractListingItemId(entry);
    if (!Number.isInteger(entryId)) continue;
    if (!allKnownIds.has(entryId)) continue;

    const p = extractPrice(entry);
    const payload = {
      price: p ? p.price : null,
      currency: p ? p.currency : null,
      salesPriceRaw: extractSalesPriceRaw(entry),
      foundButNoPrice: !p,
      shop: metadata.shop ?? null,
      page: metadata.page ?? null,
    };

    const saved = saveFoundPrice(prices, entryId, payload, options.forceRecheck);
    if (saved) {
      stats.found++;
      console.log(`Zapisano: ${entryId} -> ${payload.price ?? "brak"} ${payload.currency ?? ""}`);
    }
  }
}

function buildCheckedUrlKey(url) {
  return `v${CHECKED_URLS_VERSION}:${url}`;
}

async function processListingURL(url, prices, checkedUrls, allKnownIds, stats, options = {}) {
  const checkedUrlKey = buildCheckedUrlKey(url);

  if (!options.forceRecheck && checkedUrls[checkedUrlKey]) {
    stats.urlSkipped++;
    return;
  }

  checkedUrls[checkedUrlKey] = {
    checkedAt: new Date().toISOString()
  };
  saveCheckedUrls(checkedUrls);

  stats.urlChecked++;

  const listingPage = await fetchListingPage(url, `listing ${url}`);
  if (!listingPage || !Array.isArray(listingPage.data)) {
    return;
  }

  const parsedUrl = new URL(url);
  const shop = Number.parseInt(parsedUrl.pathname.split("/").filter(Boolean).at(-2), 10);
  const page = Number.parseInt(parsedUrl.searchParams.get("page") || "0", 10);

  processListingEntries(
    listingPage.data,
    prices,
    allKnownIds,
    stats,
    {
      shop: Number.isInteger(shop) ? shop : null,
      page: Number.isInteger(page) ? page : null,
    },
    options
  );
}

async function crawlFullShopListings(prices, checkedUrls, allKnownIds, stats, options = {}) {
  for (const shopId of SHOP_IDS) {
    let lastPage = Number.isInteger(MAX_PAGES) && MAX_PAGES > 0 ? MAX_PAGES : 1;

    for (let page = 1; page <= lastPage; page++) {
      const url = buildListingURL([], shopId, page);
      const checkedUrlKey = buildCheckedUrlKey(url);

      if (!options.forceRecheck && checkedUrls[checkedUrlKey]) {
        stats.urlSkipped++;
        continue;
      }

      const listingPage = await fetchListingPage(url, `shop-crawl shop=${shopId} page=${page}`);
      if (!listingPage || !Array.isArray(listingPage.data)) {
        continue;
      }

      if (Number.isInteger(listingPage.lastPage) && listingPage.lastPage > lastPage) {
        lastPage = listingPage.lastPage;
      }

      checkedUrls[checkedUrlKey] = {
        checkedAt: new Date().toISOString(),
        mode: "shop-crawl",
        totalCount: listingPage.totalCount,
        lastPage,
      };
      saveCheckedUrls(checkedUrls);
      stats.urlChecked++;

      processListingEntries(
        listingPage.data,
        prices,
        allKnownIds,
        stats,
        { shop: shopId, page },
        options
      );

      if (listingPage.data.length < PAGE_SIZE) {
        break;
      }
    }
  }
}

async function processItem(itemInfo, prices, checkedUrls, allKnownIds, stats, options = {}) {
  const { id, filePath } = itemInfo;

  if (!options.forceRecheck && hasResolvedPrice(prices[id])) {
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

  const tagStrategies = buildTagStrategies(item);
  if (!tagStrategies.length) {
    stats.notFound++;
    return;
  }

  for (const tagIds of tagStrategies) {
    if (!options.forceRecheck && hasResolvedPrice(prices[id])) break;

    for (const shopId of SHOP_IDS) {
      if (!options.forceRecheck && hasResolvedPrice(prices[id])) break;

      let lastPage = Number.isInteger(MAX_PAGES) && MAX_PAGES > 0 ? MAX_PAGES : 1;
      for (let page = 1; page <= lastPage; page++) {
        if (!options.forceRecheck && hasResolvedPrice(prices[id])) break;

        const url = buildListingURL(tagIds, shopId, page);
        const checkedUrlKey = buildCheckedUrlKey(url);
        if (!options.forceRecheck && checkedUrls[checkedUrlKey]) {
          stats.urlSkipped++;
          continue;
        }

        const listingPage = await fetchListingPage(url, `listing id=${id} shop=${shopId} page=${page}`);
        if (!listingPage || !Array.isArray(listingPage.data)) {
          continue;
        }

        if (Number.isInteger(listingPage.lastPage) && listingPage.lastPage > lastPage) {
          lastPage = listingPage.lastPage;
        }

        checkedUrls[checkedUrlKey] = {
          checkedAt: new Date().toISOString(),
          tagCount: tagIds.length,
          totalCount: listingPage.totalCount,
          lastPage
        };
        saveCheckedUrls(checkedUrls);
        stats.urlChecked++;
        processListingEntries(
          listingPage.data,
          prices,
          allKnownIds,
          stats,
          { shop: shopId, page },
          options
        );

        if (hasResolvedPrice(prices[id])) {
          break;
        }

        if (listingPage.data.length < PAGE_SIZE) {
          break;
        }
      }
    }
  }

  if (!hasResolvedPrice(prices[id])) {
    stats.notFound++;
  }
}

async function worker(queue, prices, checkedUrls, allKnownIds, stats, options = {}) {
  while (queue.length) {
    const itemInfo = queue.shift();
    if (!itemInfo) return;

    try {
      await processItem(itemInfo, prices, checkedUrls, allKnownIds, stats, options);
    } catch (e) {
      stats.errors++;
      console.log("Błąd ID:", itemInfo.id, e?.message || e);
    }
  }
}

async function main() {
  ensureDir();

  const prices = loadPrices();
  const checkedUrls = CLI_OPTIONS.resetUrlCache ? {} : loadCheckedUrls();

  console.log("Wczytano zapisane ceny:", Object.keys(prices).length);
  console.log("Wczytano sprawdzone linki:", Object.keys(checkedUrls).length);

  const allLocalItems = getAllLocalItems();
  console.log("Znaleziono lokalnych ID:", allLocalItems.length);

  const allKnownIds = buildIdSet(allLocalItems);
  const queue = buildQueue(allLocalItems, prices, CLI_OPTIONS);

  console.log("Do sprawdzenia ID:", queue.length);
  if (CLI_OPTIONS.ids?.length) {
    console.log("Tryb testowy ID:", CLI_OPTIONS.ids.join(", "));
  }

  const stats = {
    checked: 0,
    skipped: 0,
    found: 0,
    notFound: 0,
    errors: 0,
    urlChecked: 0,
    urlSkipped: 0
  };

  if (!CLI_OPTIONS.skipShopCrawl) {
    console.log("Start pełnego skanu listingów sklepowych...");
    await crawlFullShopListings(prices, checkedUrls, allKnownIds, stats, CLI_OPTIONS);
  }

  if (!CLI_OPTIONS.skipItemScan) {
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(worker(queue, prices, checkedUrls, allKnownIds, stats, CLI_OPTIONS));
    }

    await Promise.all(workers);
  }

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
